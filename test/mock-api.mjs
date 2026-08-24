#!/usr/bin/env node
/**
 * mock-api.mjs — in-memory emulation of the daily.dev Public API surface used by dda.mjs.
 * Shapes follow https://api.daily.dev/public/v1/docs/json (fetched 2026-08-23).
 *
 * Auth:  Bearer dda_mocktoken  -> Plus user
 *        Bearer dda_noplus     -> non-Plus (403 on API, /profile shows isPlus=false)
 *        anything else         -> 401
 * Control endpoint (tests only): POST /__mock/config {"rateLimit429Next": n}  -> next n requests get 429
 *                                GET  /__mock/state  -> full in-memory state
 * Start: node mock-api.mjs [port]  (prints "MOCK_API_PORT=<port>" when listening)
 */
import http from 'node:http';
import { URL } from 'node:url';

const PLUS = 'dda_mocktoken';
const NOPLUS = 'dda_noplus';

const TAGS = ['claude', 'claude-code', 'anthropic', 'mcp', 'ai-agents', 'agentic-ai', 'ai-coding', 'langgraph', 'langchain', 'firebase', 'python', 'rust', 'llm', 'local-ai', 'fintech', 'crypto', 'fastapi', 'docker', 'javascript', 'nodejs', 'typescript', 'react', 'testing', 'kubernetes', 'golang', 'devops'];

function isoDaysAgo(d, h = 0) { return new Date(Date.now() - d * 86400e3 - h * 3600e3).toISOString(); }
const SOURCES = [{ id: 's1', name: 'Anthropic', handle: 'anthropic', image: '' }, { id: 's2', name: 'daily.dev', handle: 'daily', image: '' }, { id: 's3', name: 'The Pragmatic Engineer', handle: 'pragmatic', image: '' }];

const POSTS = [];
const tagSets = [['claude-code', 'claude', 'ai-coding'], ['mcp', 'ai-agents'], ['langgraph', 'langchain'], ['firebase', 'javascript'], ['python', 'fastapi'], ['rust'], ['llm', 'local-ai'], ['fintech', 'crypto'], ['agentic-ai', 'ai-agents'], ['docker', 'devops'], ['react', 'typescript'], ['golang', 'kubernetes']];
for (let i = 0; i < 36; i++) {
  const tags = tagSets[i % tagSets.length];
  POSTS.push({
    id: `p${String(i + 1).padStart(3, '0')}`,
    title: `Post ${i + 1}: ${tags[0]} in practice`,
    url: `https://example.com/posts/${i + 1}`,
    image: '', summary: `Summary of post ${i + 1} about ${tags.join(' & ')}. Key point: do X before Y.`,
    type: 'article',
    publishedAt: isoDaysAgo(i * 0.25), createdAt: isoDaysAgo(i * 0.25, 1),
    commentsPermalink: `https://app.daily.dev/posts/p${i + 1}`,
    source: SOURCES[i % SOURCES.length], tags, readTime: 3 + (i % 9), numUpvotes: (i * 37) % 200, numComments: (i * 7) % 40,
    author: { id: 'a1', name: 'Author', image: '', username: 'author' }, bookmarked: false, content: i % 5 === 0 ? `Full content for post ${i + 1}.` : null,
  });
}

const state = { feeds: new Map(), filters: new Map(), lists: [], bookmarks: [], globalFilter: { includeTags: [], blockedTags: [] }, calls: [], rateLimit429Next: 0, nextId: 1 };

function id(prefix) { return `${prefix}${state.nextId++}`; }
function json(res, code, body, extra = {}) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'x-ratelimit-limit': '60', 'x-ratelimit-remaining': String(Math.max(0, 60 - (state.calls.length % 60))), 'x-ratelimit-reset': '60', ...extra });
  res.end(body === undefined ? '' : JSON.stringify(body));
}
function readBody(req) { return new Promise((r) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { try { r(b ? JSON.parse(b) : {}); } catch { r({}); } }); }); }
function page(items, q) {
  const limit = Math.min(Math.max(Number(q.get('limit') || 20), 1), 50);
  const off = q.get('cursor') ? Number(Buffer.from(q.get('cursor'), 'base64').toString()) : 0;
  const slice = items.slice(off, off + limit);
  const hasNextPage = off + limit < items.length;
  return { data: slice, pagination: { hasNextPage, cursor: hasNextPage ? Buffer.from(String(off + limit)).toString('base64') : null } };
}
function feedPosts(feedId) {
  const f = state.filters.get(feedId) || { includeTags: [], blockedTags: [] };
  return POSTS.filter((p) => (f.includeTags.length ? p.tags.some((t) => f.includeTags.includes(t)) : true) && !p.tags.some((t) => f.blockedTags.includes(t)))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const p = u.pathname.replace(/\/public\/v1/, '');
  const m = req.method;
  if (p === '/__mock/config' && m === 'POST') { Object.assign(state, await readBody(req)); return json(res, 200, { ok: true }); }
  if (p === '/__mock/state' && m === 'GET') return json(res, 200, { feeds: [...state.feeds.values()], filters: Object.fromEntries(state.filters), lists: state.lists, bookmarks: state.bookmarks, calls: state.calls.length });
  if (p === '/__mock/reset' && m === 'POST') { state.feeds.clear(); state.filters.clear(); state.lists = []; state.bookmarks = []; state.calls = []; state.rateLimit429Next = 0; return json(res, 200, { ok: true }); }
  state.calls.push(`${m} ${p}`);
  if (state.rateLimit429Next > 0) { state.rateLimit429Next--; return json(res, 429, { error: 'rate_limited', message: 'Rate limit exceeded' }, { 'retry-after': '1' }); }
  const auth = req.headers.authorization || '';
  const tok = auth.replace(/^Bearer\s+/i, '');
  if (tok !== PLUS && tok !== NOPLUS) return json(res, 401, { error: 'unauthorized', message: 'Invalid or missing token' });
  const plus = tok === PLUS;
  if (p === '/profile/' && m === 'GET') return json(res, 200, { id: 'u1', name: 'Mock User', username: 'mock', isPlus: plus, reputation: 10, createdAt: isoDaysAgo(100), permalink: 'https://app.daily.dev/mock', experienceLevel: 'MORE_THAN_4_YEARS', socialLinks: [], location: {} });
  if (!plus) return json(res, 403, { error: 'forbidden', message: 'Plus subscription required' });
  if (p === '/tags/' && m === 'GET') return json(res, 200, { data: TAGS.map((name) => ({ name })) });
  if (p === '/search/tags' && m === 'GET') { const q = (u.searchParams.get('q') || '').toLowerCase(); return json(res, 200, { data: TAGS.filter((t) => t.includes(q)).map((name) => ({ name })) }); }
  if (p === '/feeds/custom/' && m === 'POST') {
    const b = await readBody(req); if (!b.name) return json(res, 400, { error: 'bad_request', message: 'name required' });
    if (/[^A-Za-z0-9 ]/.test(b.name)) return json(res, 400, { error: 'validation_error', message: 'Feed name should not contain special characters' }); // live behaviour 2026-08-23
    if (b.orderBy !== undefined) { res.writeHead(500); return res.end(''); } // live behaviour 2026-08-23: orderBy -> HTTP 500 empty body
    const f = { id: id('feed_'), userId: 'u1', slug: b.name.toLowerCase().replace(/[^a-z0-9]+/g, '-'), createdAt: new Date().toISOString(), flags: { name: b.name, icon: b.icon ?? null, orderBy: null, minDayRange: b.minDayRange ?? null, minUpvotes: b.minUpvotes ?? null, minViews: b.minViews ?? null, disableEngagementFilter: b.disableEngagementFilter ?? null } };
    state.feeds.set(f.id, f); state.filters.set(f.id, { id: f.id, userId: 'u1', includeTags: [], blockedTags: [], includeSources: [], excludeSources: [], advancedSettings: [] });
    return json(res, 200, f);
  }
  if (p === '/feeds/custom/' && m === 'GET') return json(res, 200, page([...state.feeds.values()], u.searchParams));
  let mm;
  if ((mm = /^\/feeds\/custom\/([^/]+)\/info$/.exec(p)) && m === 'GET') { const f = state.feeds.get(mm[1]); return f ? json(res, 200, f) : json(res, 404, { error: 'not_found', message: 'Feed not found' }); }
  if ((mm = /^\/feeds\/custom\/([^/]+)$/.exec(p))) {
    const f = state.feeds.get(mm[1]); if (!f) return json(res, 404, { error: 'not_found', message: 'Feed not found' });
    if (m === 'GET') return json(res, 200, page(feedPosts(f.id), u.searchParams));
    if (m === 'PATCH') { // live behaviour: PATCH REPLACES all flags (unsent -> null); orderBy -> 500
      const b = await readBody(req); if (b.orderBy !== undefined) { res.writeHead(500); return res.end(''); }
      if (!b.name || /[^A-Za-z0-9 ]/.test(b.name)) return json(res, 400, { error: 'validation_error', message: 'Feed name should not contain special characters' });
      f.flags = { name: b.name, icon: b.icon ?? null, orderBy: null, minDayRange: b.minDayRange ?? null, minUpvotes: b.minUpvotes ?? null, minViews: b.minViews ?? null, disableEngagementFilter: b.disableEngagementFilter ?? null }; return json(res, 200, f); }
    if (m === 'DELETE') { state.feeds.delete(f.id); state.filters.delete(f.id); return json(res, 200, { success: true }); }
  }
  if (p === '/feeds/filters/' && m === 'GET') return json(res, 200, { ...state.globalFilter, includeSources: [], excludeSources: [], advancedSettings: [] });
  if ((mm = /^\/feeds\/filters\/([^/]+)\/tags\/(follow|unfollow|block|unblock)$/.exec(p)) && m === 'POST') {
    const f = state.filters.get(mm[1]); if (!f) return json(res, 404, { error: 'not_found', message: 'Feed not found' });
    const b = await readBody(req); const tags = (b.tags || []).filter((t) => TAGS.includes(t));
    const op = mm[2];
    if (op === 'follow') f.includeTags = [...new Set([...f.includeTags, ...tags])];
    if (op === 'unfollow') f.includeTags = f.includeTags.filter((t) => !tags.includes(t));
    if (op === 'block') f.blockedTags = [...new Set([...f.blockedTags, ...tags])];
    if (op === 'unblock') f.blockedTags = f.blockedTags.filter((t) => !tags.includes(t));
    return json(res, 200, { success: true });
  }
  if ((mm = /^\/feeds\/filters\/([^/]+)$/.exec(p)) && m === 'GET') { const f = state.filters.get(mm[1]); return f ? json(res, 200, f) : json(res, 404, { error: 'not_found', message: 'Feed not found' }); }
  if ((mm = /^\/posts\/([^/]+)$/.exec(p)) && m === 'GET') { const post = POSTS.find((x) => x.id === mm[1]); return post ? json(res, 200, { data: { ...post, bookmarked: state.bookmarks.some((b) => b.postId === post.id), userState: { vote: 0 } } }) : json(res, 404, { error: 'not_found', message: 'Post not found' }); }
  if (p === '/bookmarks/lists' && m === 'GET') return json(res, 200, { data: state.lists });
  if (p === '/bookmarks/lists' && m === 'POST') { const b = await readBody(req); const l = { id: id('list_'), name: b.name, icon: b.icon, createdAt: new Date().toISOString() }; state.lists.push(l); return json(res, 200, { data: l }); }
  if (p === '/bookmarks/' && m === 'POST') { const b = await readBody(req); const outArr = []; for (const pid of b.postIds || []) { if (!POSTS.find((x) => x.id === pid)) continue; const e = { postId: pid, createdAt: new Date().toISOString(), listId: b.listId || null }; state.bookmarks.push(e); outArr.push(e); } return json(res, 200, { data: outArr }); }
  if (p === '/bookmarks/' && m === 'GET') { const lid = u.searchParams.get('listId'); const items = state.bookmarks.filter((b) => !lid || b.listId === lid).map((b) => ({ ...POSTS.find((x) => x.id === b.postId), bookmarkedAt: b.createdAt })); return json(res, 200, page(items, u.searchParams)); }
  if (p === '/recommend/semantic' && m === 'GET') return json(res, 200, { data: POSTS.slice(0, Number(u.searchParams.get('limit') || 10)) });
  return json(res, 404, { error: 'not_found', message: `no route ${m} ${p}` });
});

const port = Number(process.argv[2] || 0);
server.listen(port, '127.0.0.1', () => { console.log(`MOCK_API_PORT=${server.address().port}`); });
