/**
 * connector.test.mjs — end-to-end tests: real MCP client → Node adapter → Worker fetch handler → mock daily.dev API.
 * Run: node --test test/connector.test.mjs
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import worker from '../src/index.js';
import { authorize, constantTimeEqual } from '../src/core.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const KEY = 'test-key-0123456789abcdef0123456789';
let mock, apiBase, adapter, base;
let envOverride = null;

function envFor() { return envOverride || { DAILY_DEV_TOKEN: 'dda_mocktoken', MCP_AUTH_KEY: KEY, DAILY_DEV_API_BASE: apiBase, RATE_LIMIT_PER_MIN: '1000' }; }

before(async () => {
  mock = spawn(process.execPath, [path.join(here, 'mock-api.mjs'), '0'], { stdio: ['ignore', 'pipe', 'inherit'] });
  const port = await new Promise((resolve) => mock.stdout.on('data', (d) => { const m = /MOCK_API_PORT=(\d+)/.exec(String(d)); if (m) resolve(m[1]); }));
  apiBase = `http://127.0.0.1:${port}/public/v1`;
  adapter = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const headers = new Headers(); for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
    const r = await worker.fetch(new Request(`http://127.0.0.1${req.url}`, { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks) }), envFor(), { waitUntil() {} });
    res.writeHead(r.status, Object.fromEntries(r.headers));
    if (r.body) for await (const c of r.body) res.write(c);
    res.end();
  });
  await new Promise((resolve) => adapter.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${adapter.address().port}`;
});
after(async () => { mock.kill(); await new Promise((r) => adapter.close(r)); });

async function connect({ key = KEY, viaPath = false } = {}) {
  const client = new Client({ name: 'test-client', version: '0.0.1' });
  const url = new URL(viaPath ? `${base}/mcp/${key}` : `${base}/mcp`);
  const transport = new StreamableHTTPClientTransport(url, viaPath ? {} : { requestInit: { headers: { Authorization: `Bearer ${key}` } } });
  await client.connect(transport);
  return { client, close: () => client.close() };
}
const sc = (r) => r.structuredContent;

test('constantTimeEqual', () => { assert.ok(constantTimeEqual('abc', 'abc')); assert.ok(!constantTimeEqual('abc', 'abd')); assert.ok(!constantTimeEqual('abc', 'abcd')); assert.ok(!constantTimeEqual(undefined, 'x')); assert.ok(constantTimeEqual('', '')); });
test('authorize: bearer, path secret, wrong key, short key (fail closed)', () => {
  const env = { MCP_AUTH_KEY: KEY };
  assert.equal(authorize(new Request('http://x/mcp', { headers: { authorization: `Bearer ${KEY}` } }), env).via, 'bearer');
  assert.equal(authorize(new Request(`http://x/mcp/${KEY}`), env).via, 'path');
  assert.equal(authorize(new Request(`http://x/mcp/${KEY}`), env).path, '/mcp');
  assert.equal(authorize(new Request('http://x/mcp', { headers: { authorization: 'Bearer nope' } }), env).status, 401);
  assert.equal(authorize(new Request('http://x/mcp/nope'), env).status, 401);
  assert.equal(authorize(new Request('http://x/mcp'), { MCP_AUTH_KEY: 'short' }).status, 503);
  assert.equal(authorize(new Request('http://x/mcp'), {}).status, 503);
});

test('health endpoint exposes config flags only (no secret values)', async () => {
  const r = await fetch(`${base}/`); const j = await r.json();
  assert.equal(r.status, 200); assert.equal(j.configured.DAILY_DEV_TOKEN, true); assert.equal(j.configured.MCP_AUTH_KEY, true);
  assert.ok(!JSON.stringify(j).includes(KEY) && !JSON.stringify(j).includes('dda_mocktoken'));
});
test('unauthenticated / wrong key → 401 with WWW-Authenticate; GET /mcp → 405; unknown path → 404', async () => {
  const r = await fetch(`${base}/mcp`, { method: 'POST', body: '{}' }); assert.equal(r.status, 401); assert.match(r.headers.get('www-authenticate') || '', /Bearer/);
  const r2 = await fetch(`${base}/mcp`, { method: 'POST', body: '{}', headers: { authorization: 'Bearer wrong' } }); assert.equal(r2.status, 401);
  const r3 = await fetch(`${base}/mcp`, { headers: { authorization: `Bearer ${KEY}` } }); assert.equal(r3.status, 405);
  const r4 = await fetch(`${base}/nope`); assert.equal(r4.status, 404);
});
test('missing secrets → 503 (fail closed)', async () => {
  envOverride = { DAILY_DEV_TOKEN: 'dda_mocktoken', DAILY_DEV_API_BASE: apiBase };
  const r = await fetch(`${base}/mcp`, { method: 'POST', body: '{}', headers: { authorization: `Bearer ${KEY}` } }); assert.equal(r.status, 503);
  envOverride = { MCP_AUTH_KEY: KEY, DAILY_DEV_API_BASE: apiBase };
  const r2 = await fetch(`${base}/mcp`, { method: 'POST', body: '{}', headers: { authorization: `Bearer ${KEY}` } }); assert.equal(r2.status, 503);
  envOverride = null;
});

test('MCP client connects with bearer and lists all 19 tools (13 daily.dev + 6 memory)', async () => {
  const { client, close } = await connect();
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  for (const n of ['dailydev_bookmark', 'dailydev_bookmark_lists', 'dailydev_bookmarks', 'dailydev_create_feed', 'dailydev_feed_filters', 'dailydev_feed_posts', 'dailydev_feed_tags', 'dailydev_learn_pull', 'dailydev_list_feeds', 'dailydev_post', 'dailydev_search', 'dailydev_tags', 'dailydev_whoami']) assert.ok(names.includes(n), n);
  assert.equal(names.length, 19, 'tool count');
  for (const t of tools) { assert.ok(t.description?.length > 20, `${t.name} description`); assert.ok(t.inputSchema, `${t.name} schema`); }
  await close();
});
test('MCP client connects via path secret (claude.ai custom-connector style)', async () => {
  const { client, close } = await connect({ viaPath: true });
  const r = await client.callTool({ name: 'dailydev_whoami', arguments: {} });
  assert.equal(r.isError, undefined); assert.equal(sc(r).isPlus, true); assert.equal(sc(r).username, 'mock'); assert.equal(sc(r).rateLimit.limit, 60);
  await close();
});
test('MCP client with wrong key cannot connect', async () => { await assert.rejects(connect({ key: 'wrong-key-0123456789abcdef' })); });

let feedId;
test('create_feed: sanitizes name, validates tags, follows valid ones, idempotent on re-run', async () => {
  const { client, close } = await connect();
  const r = await client.callTool({ name: 'dailydev_create_feed', arguments: { name: 'Agent: T-test', tags: ['claude-code', 'mcp', 'bogus-tag'] } });
  assert.equal(r.isError, undefined, JSON.stringify(r)); const d = sc(r);
  assert.equal(d.name, 'Agent T test'); assert.equal(d.created, true); assert.deepEqual(d.followed, ['claude-code', 'mcp']); assert.deepEqual(d.invalidTags, ['bogus-tag']); assert.deepEqual(d.liveIncludeTags, ['claude-code', 'mcp']);
  feedId = d.feedId;
  const r2 = await client.callTool({ name: 'dailydev_create_feed', arguments: { name: 'Agent: T-test', tags: ['langgraph'] } }); const d2 = sc(r2);
  assert.equal(d2.created, false); assert.equal(d2.feedId, feedId); assert.deepEqual(d2.liveIncludeTags, ['claude-code', 'mcp', 'langgraph']);
  const lf = sc(await client.callTool({ name: 'dailydev_list_feeds', arguments: {} })); assert.equal(lf.feeds.length, 1); assert.equal(lf.feeds[0].disableEngagementFilter, true);
  await close();
});
test('feed_posts: custom feed, ranked, sinceHours filter, ids present', async () => {
  const { client, close } = await connect();
  const d = sc(await client.callTool({ name: 'dailydev_feed_posts', arguments: { kind: 'custom', feedId, limit: 50, pages: 2 } }));
  assert.ok(d.posts.length > 0); for (let i = 1; i < d.posts.length; i++) assert.ok(d.posts[i - 1].upvotes * 3 + d.posts[i - 1].comments * 2 >= d.posts[i].upvotes * 3 + d.posts[i].comments * 2);
  const d2 = sc(await client.callTool({ name: 'dailydev_feed_posts', arguments: { kind: 'custom', feedId, sinceHours: 48 } }));
  const cutoff = Date.now() - 48 * 3600e3; for (const p of d2.posts) assert.ok(new Date(p.createdAt).getTime() >= cutoff);
  const err = await client.callTool({ name: 'dailydev_feed_posts', arguments: { kind: 'custom' } }); assert.equal(err.isError, true); assert.match(err.content[0].text, /feedId is required/);
  await close();
});
test('learn_pull: window + top N with rate-limit info', async () => {
  const { client, close } = await connect();
  const d = sc(await client.callTool({ name: 'dailydev_learn_pull', arguments: { feedId, sinceHours: 72, top: 3 } }));
  assert.equal(d.top.length, 3); assert.ok(d.inWindow >= 3); assert.equal(d.rateLimit.limit, 60);
  await close();
});
test('post: details incl. content; unknown id → isError', async () => {
  const { client, close } = await connect();
  const d = sc(await client.callTool({ name: 'dailydev_post', arguments: { id: 'p001' } })); assert.equal(d.id, 'p001'); assert.equal(d.content, 'Full content for post 1.');
  const e = await client.callTool({ name: 'dailydev_post', arguments: { id: 'nope' } }); assert.equal(e.isError, true); assert.match(e.content[0].text, /404/);
  await close();
});
test('search: semantic + tags', async () => {
  const { client, close } = await connect();
  const s = sc(await client.callTool({ name: 'dailydev_search', arguments: { mode: 'semantic', q: 'how do agents learn', limit: 5 } })); assert.equal(s.posts.length, 5);
  const t = sc(await client.callTool({ name: 'dailydev_search', arguments: { mode: 'tags', q: 'claude' } })); assert.ok(t.results.some((x) => x.name === 'claude-code'));
  const tags = sc(await client.callTool({ name: 'dailydev_tags', arguments: { contains: 'lang' } })); assert.ok(tags.tags.includes('langgraph'));
  await close();
});
test('feed_tags: follow/unfollow/block + minUpvotes; live read-back; PATCH keeps icon and engagement flag', async () => {
  const { client, close } = await connect();
  const d = sc(await client.callTool({ name: 'dailydev_feed_tags', arguments: { feedId, follow: ['rust', 'bogus'], unfollow: ['mcp'], block: ['golang'], minUpvotes: 5 } }));
  assert.deepEqual(d.follow.applied, ['rust']); assert.deepEqual(d.follow.invalid, ['bogus']); assert.ok(!d.liveIncludeTags.includes('mcp')); assert.ok(d.liveIncludeTags.includes('rust')); assert.deepEqual(d.liveBlockedTags, ['golang']);
  const lf = sc(await client.callTool({ name: 'dailydev_list_feeds', arguments: {} })); assert.equal(lf.feeds[0].minUpvotes, 5); assert.equal(lf.feeds[0].icon, '🤖'); assert.equal(lf.feeds[0].disableEngagementFilter, true);
  const f = sc(await client.callTool({ name: 'dailydev_feed_filters', arguments: { feedId } })); assert.deepEqual(f.blockedTags, ['golang']);
  const e = await client.callTool({ name: 'dailydev_feed_tags', arguments: { feedId } }); assert.equal(e.isError, true);
  await close();
});
test('bookmark → list auto-created; bookmarks read back by listName; unknown list → isError', async () => {
  const { client, close } = await connect();
  const b = sc(await client.callTool({ name: 'dailydev_bookmark', arguments: { postIds: ['p001', 'p002'] } })); assert.equal(b.bookmarked.length, 2); assert.equal(b.list.name, 'Agent picks');
  const lists = sc(await client.callTool({ name: 'dailydev_bookmark_lists', arguments: {} })); assert.equal(lists.lists.length, 1);
  const bm = sc(await client.callTool({ name: 'dailydev_bookmarks', arguments: { listName: 'Agent picks' } })); assert.equal(bm.posts.length, 2); assert.ok(bm.posts[0].bookmarkedAt);
  const e = await client.callTool({ name: 'dailydev_bookmarks', arguments: { listName: 'nope' } }); assert.equal(e.isError, true);
  await close();
});
test('daily.dev 429 once → transparently retried', async () => {
  await fetch(`${apiBase}/__mock/config`, { method: 'POST', body: JSON.stringify({ rateLimit429Next: 1 }) });
  const { client, close } = await connect();
  const d = sc(await client.callTool({ name: 'dailydev_whoami', arguments: {} })); assert.equal(d.isPlus, true);
  await close();
});
test('bad daily.dev token → tool error with regeneration guidance (connector auth still fine)', async () => {
  envOverride = { DAILY_DEV_TOKEN: 'dda_badtoken', MCP_AUTH_KEY: KEY, DAILY_DEV_API_BASE: apiBase, RATE_LIMIT_PER_MIN: '1000' };
  const { client, close } = await connect();
  const e = await client.callTool({ name: 'dailydev_whoami', arguments: {} }); assert.equal(e.isError, true); assert.match(e.content[0].text, /401/); assert.match(e.content[0].text, /settings\/api/);
  assert.ok(!e.content[0].text.includes('dda_badtoken'), 'token must not be echoed');
  await close(); envOverride = null;
});
test('connector rate limit → 429 with retry-after', async () => {
  envOverride = { DAILY_DEV_TOKEN: 'dda_mocktoken', MCP_AUTH_KEY: KEY, DAILY_DEV_API_BASE: apiBase, RATE_LIMIT_PER_MIN: '2' };
  const hit = async () => (await fetch(`${base}/mcp`, { method: 'POST', body: '{}', headers: { authorization: `Bearer ${KEY}`, 'x-test-ip': '1' } })).status;
  const codes = [await hit(), await hit(), await hit()];
  assert.equal(codes[2], 429);
  envOverride = null;
});
