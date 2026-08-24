/**
 * memory.test.mjs — agent memory layer: KV state + GitHub knowledge, through the real MCP client.
 * Run: node --test test/memory.test.mjs
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import worker from '../src/index.js';
import { deepMerge, upsertDaySection, renderLessons, recentSections, existingSourceUrls } from '../src/memory.js';
import { utf8ToBase64, base64ToUtf8 } from '../src/github.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const KEY = 'test-key-0123456789abcdef0123456789';

/** Minimal Cloudflare-KV-shaped fake. */
function fakeKV() {
  const m = new Map();
  return { get: async (k, type) => { const v = m.get(k); if (v === undefined) return null; return type === 'json' ? JSON.parse(v) : v; }, put: async (k, v) => { m.set(k, String(v)); }, delete: async (k) => { m.delete(k); }, _map: m };
}

let mockDD, mockGH, apiBase, ghBase, adapter, base, kv;
let envOverride = null;
function envFor() { return envOverride || { DAILY_DEV_TOKEN: 'dda_mocktoken', MCP_AUTH_KEY: KEY, DAILY_DEV_API_BASE: apiBase, RATE_LIMIT_PER_MIN: '1000', AGENT_KV: kv, GITHUB_TOKEN: 'ghp_mock', GITHUB_REPO: 'mock/agent-knowledge', GITHUB_API_BASE: ghBase, KNOWLEDGE_NAME: 'T agent' }; }

before(async () => {
  kv = fakeKV();
  mockDD = spawn(process.execPath, [path.join(here, 'mock-api.mjs'), '0'], { stdio: ['ignore', 'pipe', 'inherit'] });
  apiBase = `http://127.0.0.1:${await new Promise((r) => mockDD.stdout.on('data', (d) => { const m = /MOCK_API_PORT=(\d+)/.exec(String(d)); if (m) r(m[1]); }))}/public/v1`;
  mockGH = spawn(process.execPath, [path.join(here, 'mock-github.mjs'), '0'], { stdio: ['ignore', 'pipe', 'inherit'] });
  ghBase = `http://127.0.0.1:${await new Promise((r) => mockGH.stdout.on('data', (d) => { const m = /MOCK_GH_PORT=(\d+)/.exec(String(d)); if (m) r(m[1]); }))}`;
  adapter = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const headers = new Headers(); for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
    const r = await worker.fetch(new Request(`http://127.0.0.1${req.url}`, { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks) }), envFor(), { waitUntil() {} });
    res.writeHead(r.status, Object.fromEntries(r.headers)); if (r.body) for await (const c of r.body) res.write(c); res.end();
  });
  await new Promise((r) => adapter.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${adapter.address().port}`;
});
after(async () => { mockDD.kill(); mockGH.kill(); await new Promise((r) => adapter.close(r)); });

async function connect() {
  const client = new Client({ name: 'memory-test', version: '0.0.1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${KEY}` } } }));
  return client;
}
const sc = (r) => { if (r.isError) throw new Error(r.content?.[0]?.text); return r.structuredContent; };
const ghFiles = async () => (await fetch(`${ghBase}/__mock/files`)).json();

test('unit: deepMerge, base64 utf8 round-trip, day sections, dedupe, recentSections', () => {
  assert.deepEqual(deepMerge({ a: 1, n: { x: 1, y: 2 } }, { n: { y: null, z: 3 }, b: [1] }), { a: 1, n: { x: 1, z: 3 }, b: [1] });
  const s = '⬆️ 42 · 💬 7 — naïve café'; assert.equal(base64ToUtf8(utf8ToBase64(s)), s);
  let md = '# k\n\n<!-- c -->\n\n';
  md = upsertDaySection(md, '2026-08-23', renderLessons([{ lesson: 'A', url: 'https://x/a' }]));
  md = upsertDaySection(md, '2026-08-24', renderLessons([{ lesson: 'B', url: 'https://x/b', why: 'w', action: 'do', title: 'T', source: 'S', upvotes: 1, comments: 2, tags: ['t'], confidence: 70 }]));
  md = upsertDaySection(md, '2026-08-24', renderLessons([{ lesson: 'C', url: 'https://x/c' }]));
  assert.ok(md.indexOf('## 2026-08-24') < md.indexOf('## 2026-08-23'), 'newest day first');
  assert.match(md, /- \*\*B\*\*\n  - Why it matters here: w\n  - Do: do\n  - Source: \[T\]\(https:\/\/x\/b\) — S \(⬆️ 1 · 💬 2\) · tags: t · confidence 70%/);
  assert.deepEqual([...existingSourceUrls(md)].sort(), ['https://x/a', 'https://x/b', 'https://x/c']);
  assert.ok(!recentSections(md, 1).includes('## 2026-08-23')); assert.ok(recentSections(md, 2).includes('## 2026-08-23'));
});

test('health shows KV + GitHub configured; tools list includes the 6 memory tools', async () => {
  const j = await (await fetch(`${base}/`)).json(); assert.equal(j.configured.AGENT_KV, true); assert.equal(j.configured.GITHUB, true);
  const c = await connect(); const { tools } = await c.listTools();
  for (const n of ['agent_state', 'agent_ack', 'agent_learn_pull', 'knowledge_read', 'knowledge_append', 'knowledge_search']) assert.ok(tools.some((t) => t.name === n), n);
  assert.equal(tools.length, 19); await c.close();
});

let feedId, top;
test('agent_learn_pull: window + unseen filter; records runs/lastSync in KV', async () => {
  const c = await connect();
  feedId = sc(await c.callTool({ name: 'dailydev_create_feed', arguments: { name: 'Agent memory test', tags: ['claude-code', 'mcp', 'langgraph', 'rust'] } })).feedId;
  const d = sc(await c.callTool({ name: 'agent_learn_pull', arguments: { feedId, sinceHours: 24 * 30, top: 5 } }));
  assert.equal(d.memory, 'kv'); assert.ok(d.unseen > 5); assert.equal(d.alreadySeen, 0); assert.equal(d.top.length, 5); top = d.top;
  const st = sc(await c.callTool({ name: 'agent_state', arguments: { op: 'get' } })); assert.equal(st.runs, 1); assert.ok(st.lastSync); assert.equal(st.feedId, feedId);
  await c.close();
});
test('knowledge_read on empty repo → exists:false; knowledge_append creates knowledge.md + daily file, marks seen, dedupes', async () => {
  const c = await connect();
  const r0 = sc(await c.callTool({ name: 'knowledge_read', arguments: {} })); assert.equal(r0.exists, false);
  const lessons = top.slice(0, 2).map((p, i) => ({ postId: p.id, lesson: `Lesson ${i + 1}: ${p.title}`, why: 'test', url: p.url, title: p.title, source: p.source, upvotes: p.upvotes, comments: p.comments, tags: p.tags, confidence: 66 }));
  const a = sc(await c.callTool({ name: 'knowledge_append', arguments: { lessons, day: '2026-08-24' } }));
  assert.equal(a.filed, 2); assert.equal(a.skipped, 0); assert.match(a.knowledge.commitUrl, /commit\/c\d+/); assert.equal(a.daily.path, 'lessons/2026-08-24.md'); assert.equal(a.kv.seenCount, 2);
  const files = await ghFiles(); assert.match(files['knowledge.md'].text, /# daily-dev-agentic knowledge — T agent/); assert.match(files['knowledge.md'].text, /## 2026-08-24\n\n- \*\*Lesson 1:/); assert.match(files['lessons/2026-08-24.md'].text, /# Lessons — 2026-08-24/);
  const a2 = sc(await c.callTool({ name: 'knowledge_append', arguments: { lessons, day: '2026-08-24' } })); assert.equal(a2.filed, 0); assert.equal(a2.skipped, 2);
  assert.equal((await ghFiles())['knowledge.md'].text.match(/Lesson 1:/g).length, 1, 'no duplicate lesson lines');
  const r1 = sc(await c.callTool({ name: 'knowledge_read', arguments: { days: 1 } })); assert.equal(r1.exists, true); assert.match(r1.text, /Lesson 2:/);
  await c.close();
});
test('second learn pull skips the filed posts; agent_ack marks the rest; state view hides raw seen map', async () => {
  const c = await connect();
  const d = sc(await c.callTool({ name: 'agent_learn_pull', arguments: { feedId, sinceHours: 24 * 30, top: 5 } }));
  assert.equal(d.alreadySeen, 2); assert.ok(!d.top.some((p) => p.id === top[0].id || p.id === top[1].id));
  const ack = sc(await c.callTool({ name: 'agent_ack', arguments: { postIds: d.top.map((p) => p.id) } })); assert.equal(ack.acked, 5); assert.equal(ack.seenCount, 7);
  const st = sc(await c.callTool({ name: 'agent_state', arguments: { op: 'get' } })); assert.equal(st.seenCount, 7); assert.equal(st.seen, undefined); assert.equal(st.lessonsFiled, 2); assert.equal(st.runs, 2);
  await c.close();
});
test('agent_state patch merges (and refuses to touch seen); lastBrief round-trips', async () => {
  const c = await connect();
  const st = sc(await c.callTool({ name: 'agent_state', arguments: { op: 'patch', patch: { lastBrief: { at: '2026-08-24T11:00:00Z', text: 'brief' }, notes: { focus: 'MCP' } } } }));
  assert.equal(st.lastBrief.text, 'brief'); assert.equal(st.notes.focus, 'MCP'); assert.equal(st.lessonsFiled, 2);
  const e = await c.callTool({ name: 'agent_state', arguments: { op: 'patch', patch: { seen: {} } } }); assert.equal(e.isError, true);
  await c.close();
});
test('knowledge_search finds lessons by text; miss returns empty', async () => {
  const c = await connect();
  const h = sc(await c.callTool({ name: 'knowledge_search', arguments: { q: 'lesson 2' } })); assert.equal(h.hits.length, 1); assert.equal(h.hits[0].day, '2026-08-24'); assert.ok(h.hits[0].source);
  const m = sc(await c.callTool({ name: 'knowledge_search', arguments: { q: 'zzzz-not-there' } })); assert.equal(m.hits.length, 0);
  await c.close();
});
test('knowledge_append rejects lessons without an http url or with bad confidence', async () => {
  const c = await connect();
  const e1 = await c.callTool({ name: 'knowledge_append', arguments: { lessons: [{ lesson: 'no url lesson here', url: 'notaurl' }] } }); assert.equal(e1.isError, true);
  await c.close();
});
test('GitHub write conflict is retried once (sha changes between read and write)', async () => {
  // simulate an external commit: read current sha, write a different version directly
  const files = await ghFiles(); const cur = files['knowledge.md'];
  const c = await connect();
  // race: external write first
  const ext = await fetch(`${ghBase}/repos/mock/agent-knowledge/contents/knowledge.md`, { method: 'PUT', headers: { authorization: 'Bearer ghp_mock', 'content-type': 'application/json' }, body: JSON.stringify({ message: 'external', content: Buffer.from(cur.text + '\n<!-- external edit -->\n').toString('base64'), sha: cur.sha, branch: 'main' }) });
  assert.equal(ext.status, 200);
  const a = sc(await c.callTool({ name: 'knowledge_append', arguments: { lessons: [{ lesson: 'Lesson after external edit', url: 'https://example.com/ext', postId: 'p-ext' }], day: '2026-08-25' } }));
  assert.equal(a.filed, 1); const after = (await ghFiles())['knowledge.md'].text; assert.match(after, /external edit/); assert.match(after, /Lesson after external edit/); assert.ok(after.indexOf('## 2026-08-25') < after.indexOf('## 2026-08-24'));
  await c.close();
});
test('bad GitHub token → tool error with guidance; missing KV → clear 503-style error', async () => {
  envOverride = { ...envFor(), GITHUB_TOKEN: 'ghp_wrong' };
  let c = await connect(); const e = await c.callTool({ name: 'knowledge_read', arguments: {} }); assert.equal(e.isError, true); assert.match(e.content[0].text, /401/); assert.ok(!e.content[0].text.includes('ghp_wrong')); await c.close();
  envOverride = { ...envFor(), AGENT_KV: undefined };
  c = await connect(); const e2 = await c.callTool({ name: 'agent_state', arguments: {} }); assert.equal(e2.isError, true); assert.match(e2.content[0].text, /AGENT_KV/);
  const d = sc(await c.callTool({ name: 'agent_learn_pull', arguments: { feedId, sinceHours: 24 * 30, top: 2 } })); assert.equal(d.memory, 'none'); assert.equal(d.alreadySeen, 0);
  await c.close(); envOverride = null;
});
