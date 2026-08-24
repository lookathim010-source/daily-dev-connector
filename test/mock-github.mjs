#!/usr/bin/env node
/**
 * mock-github.mjs — in-memory emulation of the GitHub Contents API (GET/PUT /repos/{owner}/{repo}/contents/{path}).
 * Auth: Bearer ghp_mock (any other → 401). Repo "mock/agent-knowledge" exists with a README on main.
 * PUT requires the current sha when the file exists (409 otherwise) — like GitHub.
 * Control: GET /__mock/files → all files; POST /__mock/reset
 */
import http from 'node:http';

const TOKEN = 'ghp_mock';
const REPO = 'mock/agent-knowledge';
let files = new Map(); // path -> { content(base64), sha }
let commits = 0;
function sha(s) { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h.toString(16).padStart(8, '0') + String(commits).padStart(4, '0'); }
function reset() { files = new Map([['README.md', { content: Buffer.from('# agent-knowledge\n').toString('base64'), sha: 'readme000' }]]); commits = 0; }
reset();

function json(res, code, body) { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); }
function readBody(req) { return new Promise((r) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { try { r(b ? JSON.parse(b) : {}); } catch { r({}); } }); }); }

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/__mock/files') return json(res, 200, Object.fromEntries([...files].map(([p, f]) => [p, { text: Buffer.from(f.content, 'base64').toString('utf8'), sha: f.sha }])));
  if (u.pathname === '/__mock/reset') { reset(); return json(res, 200, { ok: true }); }
  const auth = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (auth !== TOKEN) return json(res, 401, { message: 'Bad credentials' });
  const m = /^\/repos\/([^/]+\/[^/]+)\/contents\/(.+)$/.exec(u.pathname);
  if (!m) return json(res, 404, { message: 'Not Found' });
  if (m[1] !== REPO) return json(res, 404, { message: 'Not Found (repo)' });
  const path = decodeURIComponent(m[2]);
  if (req.method === 'GET') {
    const f = files.get(path);
    if (!f) return json(res, 404, { message: 'Not Found' });
    return json(res, 200, { type: 'file', path, sha: f.sha, content: f.content, encoding: 'base64', html_url: `https://github.com/${REPO}/blob/main/${path}` });
  }
  if (req.method === 'PUT') {
    const b = await readBody(req);
    if (!b.message || typeof b.content !== 'string') return json(res, 422, { message: 'Invalid request' });
    const cur = files.get(path);
    if (cur && b.sha !== cur.sha) return json(res, 409, { message: `${path} does not match ${cur.sha}` });
    if (!cur && b.sha) return json(res, 422, { message: 'sha provided for new file' });
    commits++;
    const f = { content: b.content, sha: sha(b.content) };
    files.set(path, f);
    return json(res, cur ? 200 : 201, { content: { path, sha: f.sha, html_url: `https://github.com/${REPO}/blob/main/${path}` }, commit: { sha: `c${commits}`, html_url: `https://github.com/${REPO}/commit/c${commits}` } });
  }
  return json(res, 405, { message: 'Method not allowed' });
});
server.listen(Number(process.argv[2] || 0), '127.0.0.1', () => console.log(`MOCK_GH_PORT=${server.address().port}`));
