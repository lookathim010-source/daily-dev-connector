/**
 * core.js — daily.dev MCP connector internals (auth, rate limit, server factory).
 * Kept out of index.js because workerd only allows handler exports from the entry module.
 *
 * daily.dev MCP connector (Cloudflare Worker)
 *
 * Streamable-HTTP MCP server exposing the daily.dev Public API as tools. Stateless per request
 * (fits Workers: no Durable Objects needed). The daily.dev token lives in the Worker secret
 * DAILY_DEV_TOKEN and never leaves the Worker except to api.daily.dev.
 *
 * Auth (fail closed — MCP_AUTH_KEY secret must be set):
 *   - Authorization: Bearer <MCP_AUTH_KEY>           (Claude Code `--header`, scripts, harness)
 *   - URL path secret  /mcp/<MCP_AUTH_KEY>            (claude.ai custom connector — no header field there;
 *                                                      the URL is the credential: keep it private, rotate by changing the secret)
 * Routes:
 *   GET  /            health (no secrets)           GET /mcp/... → 405 (stateless: no SSE stream)
 *   POST /mcp         MCP JSON-RPC (bearer)         POST/DELETE /mcp/<key>  MCP JSON-RPC (path secret)
 *
 * Bindings (wrangler.jsonc): secrets DAILY_DEV_TOKEN, MCP_AUTH_KEY; optional vars DAILY_DEV_API_BASE, RATE_LIMIT_PER_MIN.
 */
import { McpServer, createMcpHandler } from '@modelcontextprotocol/server';
import { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/server/validators/cf-worker';
import { createClient } from './dailydev.js';
import { registerTools } from './tools.js';
import { registerMemoryTools } from './tools-memory.js';

export const VERSION = '0.1.0';

const enc = new TextEncoder();
export function constantTimeEqual(a, b) {
  const x = enc.encode(String(a ?? '')), y = enc.encode(String(b ?? ''));
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

// naive per-isolate rate limit (defense in depth; daily.dev enforces its own 60/min)
const buckets = new Map();
export function rateLimited(key, perMin) {
  const now = Date.now(); const win = 60_000;
  let b = buckets.get(key); if (!b || now - b.start > win) { b = { start: now, n: 0 }; buckets.set(key, b); }
  b.n++; if (buckets.size > 1000) buckets.clear();
  return b.n > perMin;
}

export function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers } });
}

/** Resolve auth: returns { ok, via } and the MCP path with the secret stripped. */
export function authorize(request, env) {
  const url = new URL(request.url);
  const key = env.MCP_AUTH_KEY;
  if (!key || key.length < 16) return { ok: false, status: 503, reason: 'connector not configured: set the MCP_AUTH_KEY secret (>= 16 chars)' };
  const auth = request.headers.get('authorization') || '';
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  if (m && constantTimeEqual(m[1].trim(), key)) return { ok: true, via: 'bearer', path: url.pathname };
  const pm = /^\/mcp\/([^/]+)\/?$/.exec(url.pathname);
  if (pm && constantTimeEqual(decodeURIComponent(pm[1]), key)) return { ok: true, via: 'path', path: '/mcp' };
  return { ok: false, status: 401, reason: 'unauthorized' };
}

export function buildServer(env) {
  const server = new McpServer({ name: 'daily-dev-connector', version: VERSION }, {
    jsonSchemaValidator: new CfWorkerJsonSchemaValidator(),
    instructions: 'daily.dev connector + agent memory. Start with dailydev_whoami. Daily learn loop: knowledge_read(days=3) → agent_learn_pull(feedId) → dailydev_post(id) per top post (WebFetch the url for the top 3) → distill ≤8 lessons → knowledge_append(lessons) → agent_ack(read-but-not-filed ids) → dailydev_bookmark(top 3) → agent_state patch {lastBrief}. Never invent lessons; every claim traces to a post url. Memory lives in Cloudflare KV (run state) and the GitHub knowledge repo (readable lessons).',
  });
  const dd = createClient({ token: env.DAILY_DEV_TOKEN, apiBase: env.DAILY_DEV_API_BASE, userAgent: `daily-dev-connector/${VERSION}` });
  registerTools(server, dd);
  registerMemoryTools(server, dd, env);
  return server;
}

