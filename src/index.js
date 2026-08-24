/**
 * index.js — Cloudflare Worker entry for the daily.dev MCP connector. Only the handler is exported here
 * (workerd rejects other named exports from the entry module); everything else lives in core.js.
 */
import { createMcpHandler } from '@modelcontextprotocol/server';
import { VERSION, authorize, buildServer, json, rateLimited } from './core.js';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/health')) {
      return json({ name: 'daily-dev-connector', version: VERSION, mcp: '/mcp', configured: { DAILY_DEV_TOKEN: !!env.DAILY_DEV_TOKEN, MCP_AUTH_KEY: !!env.MCP_AUTH_KEY, AGENT_KV: !!env.AGENT_KV, GITHUB: !!(env.GITHUB_TOKEN && env.GITHUB_REPO) } });
    }
    if (!url.pathname.startsWith('/mcp')) return json({ error: 'not found' }, 404);
    if (!env.DAILY_DEV_TOKEN) return json({ error: 'connector not configured: set the DAILY_DEV_TOKEN secret' }, 503);
    const auth = authorize(request, env);
    if (!auth.ok) return json({ error: auth.reason }, auth.status, auth.status === 401 ? { 'www-authenticate': 'Bearer realm="daily-dev-connector"' } : {});
    const ip = request.headers.get('cf-connecting-ip') || 'local';
    if (rateLimited(ip, Number(env.RATE_LIMIT_PER_MIN || 120))) return json({ error: 'rate limited' }, 429, { 'retry-after': '30' });
    if (request.method === 'GET') return new Response(null, { status: 405, headers: { allow: 'POST, DELETE' } });
    // Re-target the request at /mcp so the handler sees a clean path whichever auth form was used.
    const target = new URL(request.url); target.pathname = '/mcp'; target.search = '';
    const req = new Request(target, request);
    const handler = createMcpHandler(() => buildServer(env), { legacy: 'stateless' });
    try {
      const res = await handler.fetch(req);
      ctx?.waitUntil?.(handler.close?.());
      return res;
    } catch (e) {
      return json({ error: `connector failure: ${e.message}` }, 500);
    }
  },
};
