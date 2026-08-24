#!/usr/bin/env node
/**
 * verify-connector.mjs — PASS/FAIL harness for a deployed daily.dev MCP connector.
 *
 *   node harness/verify-connector.mjs https://daily-dev-mcp.<you>.workers.dev <MCP_AUTH_KEY> [--feed <feedId>] [--write]
 *
 * Read-only by default (whoami, list feeds, feed posts, learn_pull, post, search, tags, bookmarks).
 * --write additionally bookmarks one post into "Agent picks". Never prints the key or the daily.dev token.
 * Exit 0 only if every check passed.
 */
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const [urlArg, key, ...rest] = process.argv.slice(2);
if (!urlArg || !key) { console.error('usage: node harness/verify-connector.mjs <worker-url> <MCP_AUTH_KEY> [--feed <feedId>] [--write]'); process.exit(2); }
const flag = (n) => { const i = rest.indexOf(`--${n}`); return i === -1 ? null : (rest[i + 1] && !rest[i + 1].startsWith('--') ? rest[i + 1] : true); };
let FEED = flag('feed'); const WRITE = !!flag('write');
const origin = urlArg.replace(/\/+$/, '').replace(/\/mcp.*$/, '');

const results = [];
async function check(name, fn) {
  const t0 = Date.now();
  try { const d = await fn(); results.push({ name, ok: true }); console.log(`PASS  ${name}${d ? ` — ${d}` : ''}  (${Date.now() - t0} ms)`); }
  catch (e) { results.push({ name, ok: false }); console.log(`FAIL  ${name} — ${e.message}`); }
}
const must = (c, m) => { if (!c) throw new Error(m); };
const sc = (r) => { if (r.isError) throw new Error(r.content?.[0]?.text || 'tool error'); return r.structuredContent; };

console.log(`daily.dev connector verification · ${origin} · ${new Date().toISOString()}\n`);

await check('health endpoint reachable, secrets configured', async () => {
  const r = await fetch(`${origin}/`); must(r.status === 200, `HTTP ${r.status}`); const j = await r.json();
  must(j.configured?.DAILY_DEV_TOKEN, 'DAILY_DEV_TOKEN secret not set (wrangler secret put DAILY_DEV_TOKEN)'); must(j.configured?.MCP_AUTH_KEY, 'MCP_AUTH_KEY secret not set');
  return `v${j.version}`;
});
await check('unauthenticated request rejected (401)', async () => { const r = await fetch(`${origin}/mcp`, { method: 'POST', body: '{}' }); must(r.status === 401, `HTTP ${r.status}`); return 'ok'; });
await check('wrong key rejected (401)', async () => { const r = await fetch(`${origin}/mcp`, { method: 'POST', body: '{}', headers: { authorization: 'Bearer wrong-key-000000000000000000' } }); must(r.status === 401, `HTTP ${r.status}`); return 'ok'; });

let client;
await check('MCP connect via Authorization: Bearer (Claude Code style)', async () => {
  client = new Client({ name: 'verify-connector', version: '0.1.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${key}` } } }));
  const { tools } = await client.listTools(); must(tools.length >= 19, `only ${tools.length} tools`); return `${tools.length} tools`;
});
await check('MCP connect via path secret (claude.ai custom-connector URL)', async () => {
  const c = new Client({ name: 'verify-connector-path', version: '0.1.0' });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${origin}/mcp/${encodeURIComponent(key)}`)));
  const w = sc(await c.callTool({ name: 'dailydev_whoami', arguments: {} })); await c.close(); return `@${w.username}`;
});
if (!client) { console.log('\nRED — cannot connect; stopping'); process.exit(1); }

let whoami;
await check('LIVE dailydev_whoami: Plus active, rate-limit headers', async () => { whoami = sc(await client.callTool({ name: 'dailydev_whoami', arguments: {} })); must(whoami.isPlus, 'account is not Plus'); return `@${whoami.username} plus=${whoami.isPlus} remaining=${whoami.rateLimit.remaining}/${whoami.rateLimit.limit}`; });
await check('LIVE dailydev_list_feeds', async () => { const d = sc(await client.callTool({ name: 'dailydev_list_feeds', arguments: {} })); if (!FEED && d.feeds.length) FEED = d.feeds[0].id; return d.feeds.map((f) => `${f.id}:${f.name}`).join(', ') || 'no custom feeds'; });
if (FEED) {
  let top;
  await check(`LIVE dailydev_learn_pull(${FEED}, 7d)`, async () => { const d = sc(await client.callTool({ name: 'dailydev_learn_pull', arguments: { feedId: FEED, sinceHours: 168, top: 5 } })); top = d.top[0]; return `${d.inWindow} in window of ${d.fetched} fetched; top: ${top?.title?.slice(0, 50) || '(none)'}`; });
  await check('LIVE dailydev_feed_filters', async () => { const d = sc(await client.callTool({ name: 'dailydev_feed_filters', arguments: { feedId: FEED } })); return `${d.includeTags.length} tags followed, ${d.blockedTags.length} blocked`; });
  if (top) {
    await check('LIVE dailydev_post', async () => { const d = sc(await client.callTool({ name: 'dailydev_post', arguments: { id: top.id } })); must(d.url, 'no url'); return d.title.slice(0, 60); });
    if (WRITE) await check('LIVE dailydev_bookmark (the only write)', async () => { const d = sc(await client.callTool({ name: 'dailydev_bookmark', arguments: { postIds: [top.id] } })); return `bookmarked ${d.bookmarked.length} into "${d.list.name}"`; });
  }
} else console.log('SKIP  feed checks — no custom feed found (create one with dailydev_create_feed or pass --feed)');
await check('LIVE dailydev_search semantic', async () => { const d = sc(await client.callTool({ name: 'dailydev_search', arguments: { mode: 'semantic', q: 'how do AI agents keep themselves current', limit: 3 } })); return `${d.posts.length} results`; });
await check('LIVE dailydev_tags contains=claude', async () => { const d = sc(await client.callTool({ name: 'dailydev_tags', arguments: { contains: 'claude' } })); must(d.tags.includes('claude-code'), 'claude-code missing'); return d.tags.join(', '); });
await check('LIVE dailydev_bookmark_lists', async () => { const d = sc(await client.callTool({ name: 'dailydev_bookmark_lists', arguments: {} })); return d.lists.map((l) => l.name).join(', ') || 'none'; });
// memory layer (present only when the deployment has the KV binding / GitHub secrets)
const health = await (await fetch(`${origin}/`)).json();
if (health.configured?.AGENT_KV) {
  await check('MEMORY agent_state (KV) readable', async () => { const d = sc(await client.callTool({ name: 'agent_state', arguments: { op: 'get' } })); return `runs=${d.runs} lessons=${d.lessonsFiled} seen=${d.seenCount} lastLearn=${d.lastLearn || '-'}`; });
  if (FEED) await check('MEMORY agent_learn_pull (incremental, 7d)', async () => { const d = sc(await client.callTool({ name: 'agent_learn_pull', arguments: { feedId: FEED, sinceHours: 168, top: 3 } })); return `${d.unseen} unseen / ${d.inWindow} in window (${d.alreadySeen} already seen), memory=${d.memory}`; });
} else console.log('SKIP  memory KV checks — AGENT_KV not configured');
if (health.configured?.GITHUB) {
  await check('MEMORY knowledge_read (GitHub repo reachable with the token)', async () => { const d = sc(await client.callTool({ name: 'knowledge_read', arguments: { days: 2 } })); return d.exists ? `${d.htmlUrl} (${d.text.length} chars, newest 2 days)` : 'repo reachable; knowledge.md not created yet'; });
  await check('MEMORY knowledge_search', async () => { const d = sc(await client.callTool({ name: 'knowledge_search', arguments: { q: 'agent', limit: 3 } })); return `${d.hits.length} hit(s)`; });
} else console.log('SKIP  memory GitHub checks — GITHUB_TOKEN/GITHUB_REPO not configured');
await client.close();

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${failed ? 'RED' : 'GREEN'} — ${results.length - failed}/${results.length} checks passed${failed ? `, ${failed} FAILED` : ''}`);
process.exit(failed ? 1 : 0);
