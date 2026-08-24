/**
 * tools.js — MCP tool definitions for the daily.dev connector.
 * Every tool returns both human-readable text and structuredContent.
 */
import * as z from 'zod/v4';
import { normPost, rankPosts, sanitizeFeedName, DEFAULT_ICON, DEFAULT_BOOKMARK_LIST, DailyDevError } from './dailydev.js';

const FEED_KINDS = ['custom', 'foryou', 'popular', 'discussed', 'tag', 'source'];

function ok(data, text) {
  return { content: [{ type: 'text', text: text ?? JSON.stringify(data, null, 1) }], structuredContent: data };
}
function errResult(e) {
  const status = e instanceof DailyDevError ? e.status : 500;
  return { isError: true, content: [{ type: 'text', text: `error (${status}): ${e.message}` }], structuredContent: { error: e.message, status } };
}
const guard = (fn) => async (...a) => { try { return await fn(...a); } catch (e) { return errResult(e); } };

function postsText(posts, heading) {
  if (!posts.length) return `${heading}: none`;
  return `${heading} (${posts.length}):\n` + posts.map((p, i) => `${i + 1}. ${p.title} — ${p.source || '?'} (⬆️ ${p.upvotes} · 💬 ${p.comments}${p.readTime ? ` · ${p.readTime} min` : ''}) [${(p.tags || []).slice(0, 4).join(', ')}]\n   ${p.url}  id=${p.id}`).join('\n');
}

export function registerTools(server, dd) {
  server.registerTool('dailydev_whoami', {
    title: 'daily.dev: who am I',
    description: 'Confirms the connector works: returns the daily.dev account behind this connector (username, name, Plus status) and the current API rate-limit headroom. Call this first if anything else fails.',
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, guard(async () => {
    const p = await dd.api('GET', '/profile/');
    const data = { username: p.username, name: p.name, isPlus: !!p.isPlus, reputation: p.reputation, permalink: p.permalink, rateLimit: { ...dd.rate } };
    return ok(data, `@${data.username} (${data.name}) · Plus: ${data.isPlus ? 'yes' : 'NO'} · rate limit ${dd.rate.remaining}/${dd.rate.limit} remaining`);
  }));

  server.registerTool('dailydev_list_feeds', {
    title: 'daily.dev: list custom feeds',
    description: "Lists the account's custom feeds (id, name, settings). The agent's own learning feed is one of these.",
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, guard(async () => {
    const { items } = await dd.paged('/feeds/custom/', { limit: 50, pages: 2 });
    const data = { feeds: items.map((f) => ({ id: f.id, name: f.flags?.name, icon: f.flags?.icon, minUpvotes: f.flags?.minUpvotes ?? null, minViews: f.flags?.minViews ?? null, disableEngagementFilter: f.flags?.disableEngagementFilter ?? null, createdAt: f.createdAt })) };
    return ok(data, data.feeds.length ? data.feeds.map((f) => `${f.id}  ${f.name}`).join('\n') : 'no custom feeds');
  }));

  server.registerTool('dailydev_feed_posts', {
    title: 'daily.dev: feed posts',
    description: 'Fetches posts from a feed. kind=custom needs feedId (the agent feed), foryou/popular/discussed are the account feeds, tag/source need `tag`/`source`. Optional sinceHours filters by createdAt; rank=true orders by community engagement (upvotes*3+comments*2). Returns compact posts with ids for dailydev_post / dailydev_bookmark.',
    inputSchema: z.object({
      kind: z.enum(FEED_KINDS).default('custom'),
      feedId: z.string().optional().describe('custom feed id (required for kind=custom)'),
      tag: z.string().optional(), source: z.string().optional(),
      limit: z.number().int().min(1).max(50).default(30),
      pages: z.number().int().min(1).max(4).default(1).describe('how many pages of `limit` to walk'),
      cursor: z.string().optional(),
      sinceHours: z.number().min(1).max(24 * 60).optional().describe('keep only posts created within the last N hours'),
      rank: z.boolean().default(true),
    }),
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, guard(async ({ kind, feedId, tag, source, limit, pages, cursor, sinceHours, rank }) => {
    let route;
    if (kind === 'custom') { if (!feedId) throw new DailyDevError('feedId is required for kind=custom', 400); route = `/feeds/custom/${encodeURIComponent(feedId)}`; }
    else if (kind === 'tag') { if (!tag) throw new DailyDevError('tag is required for kind=tag', 400); route = `/feeds/tag/${encodeURIComponent(tag)}`; }
    else if (kind === 'source') { if (!source) throw new DailyDevError('source is required for kind=source', 400); route = `/feeds/source/${encodeURIComponent(source)}`; }
    else route = `/feeds/${kind}`;
    const { items, nextCursor } = await dd.paged(route, { limit, pages, query: { cursor } });
    let posts = items.map(normPost);
    if (sinceHours) { const cutoff = Date.now() - sinceHours * 3600e3; posts = posts.filter((p) => p.createdAt && new Date(p.createdAt).getTime() >= cutoff); }
    if (rank) posts = rankPosts(posts);
    const data = { kind, feedId: feedId || null, fetched: items.length, returned: posts.length, nextCursor, posts };
    return ok(data, postsText(posts, `${kind} feed posts${sinceHours ? ` (last ${sinceHours}h)` : ''}`) + (nextCursor ? `\nnextCursor=${nextCursor}` : ''));
  }));

  server.registerTool('dailydev_post', {
    title: 'daily.dev: post details',
    description: "Full details for one post: daily.dev's summary, tags, engagement, author, and full content when the post is a daily.dev-native post. Use the post's url with a web fetch for the original article.",
    inputSchema: z.object({ id: z.string().min(1) }),
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, guard(async ({ id }) => {
    const d = await dd.api('GET', `/posts/${encodeURIComponent(id)}`);
    const p = d?.data || d;
    const data = { ...normPost(p), summary: p.summary || '', content: p.content || null, author: p.author?.name || null, bookmarked: !!p.bookmarked };
    return ok(data, `# ${data.title}\n${data.url}\nsource: ${data.source} · ⬆️ ${data.upvotes} · 💬 ${data.comments} · ${data.readTime ?? '?'} min · tags: ${data.tags.join(', ')}\npublished: ${data.publishedAt}\n\n${data.summary || '(no summary)'}${data.content ? `\n\n---\n${data.content}` : ''}`);
  }));

  server.registerTool('dailydev_search', {
    title: 'daily.dev: search',
    description: 'Search daily.dev. mode=semantic answers natural-language questions (best for "how do I…"), keyword for specific terms, posts for title search, tags/sources to discover exact tag or publisher names. Results are community-vetted developer articles ranked by upvotes.',
    inputSchema: z.object({
      mode: z.enum(['semantic', 'keyword', 'posts', 'tags', 'sources']).default('semantic'),
      q: z.string().min(1),
      limit: z.number().int().min(1).max(20).default(10),
      time: z.enum(['day', 'week', 'month', 'year', 'all']).optional().describe('semantic only: recency window'),
    }),
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, guard(async ({ mode, q, limit, time }) => {
    if (mode === 'tags' || mode === 'sources') {
      const d = await dd.api('GET', `/search/${mode}`, { query: { q } });
      const data = { mode, q, results: (d?.data || []).slice(0, limit) };
      return ok(data, data.results.length ? data.results.map((x) => x.name || x.handle || JSON.stringify(x)).join(', ') : 'no matches');
    }
    const route = mode === 'posts' ? '/search/posts' : `/recommend/${mode}`;
    const d = await dd.api('GET', route, { query: { q, limit, time } });
    const posts = (d?.data || []).map(normPost);
    const data = { mode, q, posts };
    return ok(data, postsText(posts, `${mode} results for "${q}"`));
  }));

  server.registerTool('dailydev_tags', {
    title: 'daily.dev: tag catalog',
    description: 'Lists daily.dev tag names (catalog may be capped at 1,000 — use dailydev_search mode=tags to confirm a specific tag). Optional substring filter.',
    inputSchema: z.object({ contains: z.string().optional(), limit: z.number().int().min(1).max(1000).default(200) }),
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, guard(async ({ contains, limit }) => {
    const d = await dd.api('GET', '/tags/');
    let tags = (d?.data || []).map((t) => t.name);
    if (contains) tags = tags.filter((t) => t.includes(contains.toLowerCase()));
    const data = { total: tags.length, tags: tags.slice(0, limit) };
    return ok(data, `${data.total} tags${contains ? ` containing "${contains}"` : ''}: ${data.tags.join(', ')}`);
  }));

  server.registerTool('dailydev_create_feed', {
    title: 'daily.dev: create agent feed',
    description: 'Creates a custom feed for the agent (letters/digits/spaces in the name only — sanitized), with the engagement filter disabled so posts the user already saw still reach the agent, and follows the given tags (invalid tags are reported, not applied). Idempotent by name: if a feed with that name exists it is reused.',
    inputSchema: z.object({ name: z.string().min(1).max(50), tags: z.array(z.string()).min(1).max(100), icon: z.string().max(4).optional(), minUpvotes: z.number().int().min(0).optional() }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, guard(async ({ name, tags, icon, minUpvotes }) => {
    const clean = sanitizeFeedName(name);
    const { items } = await dd.paged('/feeds/custom/', { limit: 50, pages: 2 });
    let feed = items.find((f) => f.flags?.name === clean);
    let created = false;
    if (!feed) { feed = await dd.api('POST', '/feeds/custom/', { body: { name: clean, icon: icon || DEFAULT_ICON, disableEngagementFilter: true, ...(minUpvotes != null ? { minUpvotes } : {}) } }); created = true; }
    const { valid, invalid } = await dd.validateTags(tags);
    if (valid.length) await dd.api('POST', `/feeds/filters/${feed.id}/tags/follow`, { body: { tags: valid } });
    const live = await dd.api('GET', `/feeds/filters/${feed.id}`);
    const data = { feedId: feed.id, name: clean, created, followed: valid, invalidTags: invalid, liveIncludeTags: live?.includeTags || [] };
    return ok(data, `${created ? 'created' : 'reused'} feed "${clean}" (id ${feed.id}); now following ${data.liveIncludeTags.length} tags${invalid.length ? `; not on daily.dev: ${invalid.join(', ')}` : ''}`);
  }));

  server.registerTool('dailydev_feed_filters', {
    title: 'daily.dev: read feed filters',
    description: 'Reads the live filter of a custom feed: followed tags, blocked tags, followed/blocked sources.',
    inputSchema: z.object({ feedId: z.string().min(1) }),
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, guard(async ({ feedId }) => {
    const f = await dd.api('GET', `/feeds/filters/${encodeURIComponent(feedId)}`);
    const data = { feedId, includeTags: f?.includeTags || [], blockedTags: f?.blockedTags || [], includeSources: (f?.includeSources || []).map((s) => s.handle || s.name), excludeSources: (f?.excludeSources || []).map((s) => s.handle || s.name) };
    return ok(data, `follows ${data.includeTags.length} tags: ${data.includeTags.join(', ')}${data.blockedTags.length ? `\nblocks: ${data.blockedTags.join(', ')}` : ''}`);
  }));

  server.registerTool('dailydev_feed_tags', {
    title: 'daily.dev: adapt feed tags',
    description: "Follow / unfollow / block / unblock tags on a custom feed (the agent's own feed — never the user's personal For You feed). Tags are validated against daily.dev first; the live filter is read back afterwards as evidence.",
    inputSchema: z.object({ feedId: z.string().min(1), follow: z.array(z.string()).optional(), unfollow: z.array(z.string()).optional(), block: z.array(z.string()).optional(), unblock: z.array(z.string()).optional(), minUpvotes: z.number().int().min(0).optional().describe('raise the engagement bar for the feed (0 = off)') }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, guard(async ({ feedId, follow, unfollow, block, unblock, minUpvotes }) => {
    const done = {};
    for (const [op, tags] of [['follow', follow], ['unfollow', unfollow], ['block', block], ['unblock', unblock]]) {
      if (!tags?.length) continue;
      const { valid, invalid } = (op === 'follow' || op === 'block') ? await dd.validateTags(tags) : { valid: tags, invalid: [] };
      if (valid.length) await dd.api('POST', `/feeds/filters/${encodeURIComponent(feedId)}/tags/${op}`, { body: { tags: valid } });
      done[op] = { applied: valid, invalid };
    }
    if (minUpvotes != null) {
      const info = await dd.api('GET', `/feeds/custom/${encodeURIComponent(feedId)}/info`);
      await dd.api('PATCH', `/feeds/custom/${encodeURIComponent(feedId)}`, { body: dd.feedFlagsBody(info, { minUpvotes }) });
      done.minUpvotes = minUpvotes;
    }
    if (!Object.keys(done).length) throw new DailyDevError('nothing to do: pass follow/unfollow/block/unblock/minUpvotes', 400);
    const live = await dd.api('GET', `/feeds/filters/${encodeURIComponent(feedId)}`);
    const data = { feedId, ...done, liveIncludeTags: live?.includeTags || [], liveBlockedTags: live?.blockedTags || [] };
    return ok(data, Object.entries(done).map(([k, v]) => `${k}: ${Array.isArray(v?.applied) ? (v.applied.join(', ') || '(none)') : v}${v?.invalid?.length ? ` (not on daily.dev: ${v.invalid.join(', ')})` : ''}`).join('\n') + `\nlive: follows ${data.liveIncludeTags.length} tags, blocks ${data.liveBlockedTags.length}`);
  }));

  server.registerTool('dailydev_bookmark', {
    title: 'daily.dev: bookmark posts',
    description: `Bookmarks posts into a bookmark list (default "${DEFAULT_BOOKMARK_LIST}", created if missing). This is the cross-surface store for the agent's best finds.`,
    inputSchema: z.object({ postIds: z.array(z.string()).min(1).max(100), listName: z.string().max(50).optional() }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, guard(async ({ postIds, listName }) => {
    const list = await dd.ensureBookmarkList(listName || DEFAULT_BOOKMARK_LIST);
    const d = await dd.api('POST', '/bookmarks/', { body: { postIds, listId: list.listId } });
    const data = { list, bookmarked: (d?.data || []).map((x) => x.postId), requested: postIds };
    return ok(data, `bookmarked ${data.bookmarked.length}/${postIds.length} into "${list.name}"`);
  }));

  server.registerTool('dailydev_bookmarks', {
    title: 'daily.dev: read bookmarks',
    description: 'Reads bookmarked posts (optionally one list by name, e.g. "Agent picks", or unread only). Use this to recall what the agent found valuable before.',
    inputSchema: z.object({ listName: z.string().optional(), unreadOnly: z.boolean().default(false), limit: z.number().int().min(1).max(50).default(30), cursor: z.string().optional() }),
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, guard(async ({ listName, unreadOnly, limit, cursor }) => {
    let listId;
    if (listName) { const lists = await dd.api('GET', '/bookmarks/lists'); const hit = (lists?.data || []).find((l) => l.name === listName); if (!hit) throw new DailyDevError(`bookmark list "${listName}" not found`, 404); listId = hit.id; }
    const d = await dd.api('GET', '/bookmarks/', { query: { listId, unreadOnly, limit, cursor } });
    const posts = (d?.data || []).map((p) => ({ ...normPost(p), bookmarkedAt: p.bookmarkedAt || null }));
    const data = { listName: listName || null, posts, nextCursor: d?.pagination?.hasNextPage ? d.pagination.cursor : null };
    return ok(data, postsText(posts, `bookmarks${listName ? ` in "${listName}"` : ''}`));
  }));

  server.registerTool('dailydev_bookmark_lists', {
    title: 'daily.dev: bookmark lists',
    description: 'Lists bookmark lists (id, name).',
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, guard(async () => {
    const d = await dd.api('GET', '/bookmarks/lists');
    const data = { lists: (d?.data || []).map((l) => ({ id: l.id, name: l.name, icon: l.icon })) };
    return ok(data, data.lists.length ? data.lists.map((l) => `${l.id}  ${l.name}`).join('\n') : 'no lists');
  }));

  server.registerTool('dailydev_learn_pull', {
    title: 'daily.dev: learn-loop pull',
    description: "One-call pull step of the agent's learning loop: fetches the agent feed, keeps posts created in the last sinceHours (26 for a daily run, 168 for the weekly digest), ranks by engagement, and returns the top N with daily.dev summaries — ready to read, distill into lessons, and bookmark.",
    inputSchema: z.object({ feedId: z.string().min(1), sinceHours: z.number().min(1).max(24 * 60).default(26), top: z.number().int().min(1).max(25).default(8), pages: z.number().int().min(1).max(4).default(2) }),
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, guard(async ({ feedId, sinceHours, top, pages }) => {
    const { items } = await dd.paged(`/feeds/custom/${encodeURIComponent(feedId)}`, { limit: 50, pages });
    const cutoff = Date.now() - sinceHours * 3600e3;
    const inWindow = rankPosts(items.map(normPost).filter((p) => p.createdAt && new Date(p.createdAt).getTime() >= cutoff));
    const data = { feedId, sinceHours, fetched: items.length, inWindow: inWindow.length, top: inWindow.slice(0, top), rateLimit: { ...dd.rate } };
    return ok(data, `${data.inWindow} post(s) in the last ${sinceHours}h (fetched ${data.fetched}); top ${data.top.length}:\n` + postsText(data.top, 'ranked').split('\n').slice(1).join('\n'));
  }));
}
