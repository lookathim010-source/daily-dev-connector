/**
 * dailydev.js — minimal client for the daily.dev Public API (https://api.daily.dev/public/v1)
 * used by the hosted connector. Web-standard fetch only (Cloudflare Workers / Node >= 18).
 *
 * Verified live 2026-08-23:
 *  - `orderBy` in POST/PATCH /feeds/custom → HTTP 500 → never sent
 *  - feed names: letters/digits/spaces only → sanitized
 *  - PATCH /feeds/custom/{id} replaces all flags → always resend the full set
 *  - GET /tags/ capped at 1,000 names → unknown tags confirmed via /search/tags
 */

export const DEFAULT_API_BASE = 'https://api.daily.dev/public/v1';
export const DEFAULT_ICON = '🤖';
export const DEFAULT_BOOKMARK_LIST = 'Agent picks';

export class DailyDevError extends Error {
  constructor(message, status, extra = {}) { super(message); this.status = status; Object.assign(this, extra); }
}

export function sanitizeFeedName(name) {
  return String(name || '').replace(/[^A-Za-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 50) || 'Agent';
}

export function normPost(p) {
  return {
    id: p.id, title: p.title, url: p.url,
    summary: p.summary ? String(p.summary).slice(0, 600) : '',
    type: p.type, publishedAt: p.publishedAt || null, createdAt: p.createdAt || null,
    source: p.source?.name || p.source?.handle || null, tags: p.tags || [],
    readTime: p.readTime ?? null, upvotes: p.numUpvotes ?? 0, comments: p.numComments ?? 0,
    commentsPermalink: p.commentsPermalink || null,
  };
}

export function score(p) { return (p.upvotes ?? 0) * 3 + (p.comments ?? 0) * 2; }
export function rankPosts(posts) {
  return [...posts].sort((a, b) => score(b) - score(a) || String(b.createdAt).localeCompare(String(a.createdAt)));
}

export function createClient({ token, apiBase = DEFAULT_API_BASE, fetchImpl = globalThis.fetch, timeoutMs = 20000, userAgent = 'daily-dev-connector/0.1.0' } = {}) {
  if (!token) throw new DailyDevError('DAILY_DEV_TOKEN is not configured on the server', 503);
  const base = apiBase.replace(/\/+$/, '');
  const rate = { limit: null, remaining: null, reset: null, calls: 0 };

  async function api(method, route, { body, query, retries = 2 } = {}) {
    const url = new URL(base + route);
    if (query) for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json', 'User-Agent': userAgent };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    let res;
    try {
      res = await fetchImpl(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      throw new DailyDevError(`daily.dev unreachable: ${e.message}`, 502);
    }
    rate.calls++;
    for (const h of ['limit', 'remaining', 'reset']) { const v = res.headers.get(`x-ratelimit-${h}`); if (v !== null) rate[h] = Number(v); }
    if (res.status === 429) {
      const ra = Number(res.headers.get('retry-after') || 2);
      if (retries > 0) { await new Promise((r) => setTimeout(r, Math.min(Math.max(ra, 1), 10) * 1000)); return api(method, route, { body, query, retries: retries - 1 }); }
      throw new DailyDevError(`daily.dev rate limit exceeded (60/min); retry after ${ra}s`, 429, { retryAfter: ra });
    }
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
    if (res.status === 401) throw new DailyDevError('daily.dev token invalid or expired (401) — regenerate at https://app.daily.dev/settings/api and update the Worker secret', 401);
    if (res.status === 403) throw new DailyDevError(`daily.dev refused (403): ${data?.message || 'Plus subscription required'}`, 403);
    if (res.status === 404) throw new DailyDevError(`not found: ${route}`, 404);
    if (!res.ok) throw new DailyDevError(`daily.dev ${res.status} on ${method} ${route}: ${data?.message || data?.error || text.slice(0, 200) || '(empty body)'}`, res.status);
    return data;
  }

  async function paged(route, { limit = 50, pages = 2, query = {} } = {}) {
    const items = []; let cursor; let hasNext = false;
    for (let i = 0; i < pages; i++) {
      const d = await api('GET', route, { query: { ...query, limit, cursor } });
      items.push(...(d?.data || []));
      hasNext = !!(d?.pagination?.hasNextPage && d?.pagination?.cursor);
      if (!hasNext) break;
      cursor = d.pagination.cursor;
    }
    return { items, nextCursor: hasNext ? cursor : null };
  }

  let catalog = null;
  async function tagCatalog() {
    if (!catalog) { const d = await api('GET', '/tags/'); catalog = new Set((d?.data || []).map((t) => t.name)); }
    return catalog;
  }
  async function validateTags(tags) {
    const cat = await tagCatalog();
    const valid = [], invalid = [];
    for (const t of [...new Set((tags || []).map((x) => String(x).toLowerCase().trim()).filter(Boolean))]) {
      if (cat.has(t)) { valid.push(t); continue; }
      const d = await api('GET', '/search/tags', { query: { q: t } });
      if ((d?.data || []).some((x) => x.name === t)) valid.push(t); else invalid.push(t);
    }
    return { valid, invalid };
  }

  function feedFlagsBody(info, overrides = {}) {
    const f = info?.flags || {};
    const body = { name: f.name, icon: f.icon || DEFAULT_ICON, disableEngagementFilter: f.disableEngagementFilter ?? true, minDayRange: f.minDayRange, minUpvotes: f.minUpvotes, minViews: f.minViews, ...overrides };
    for (const k of Object.keys(body)) if (body[k] === null || body[k] === undefined) delete body[k];
    delete body.orderBy;
    return body;
  }

  async function ensureBookmarkList(name = DEFAULT_BOOKMARK_LIST) {
    const lists = await api('GET', '/bookmarks/lists');
    let hit = (lists?.data || []).find((l) => l.name === name);
    if (!hit) { const created = await api('POST', '/bookmarks/lists', { body: { name, icon: DEFAULT_ICON } }); hit = created?.data || created; }
    return { listId: hit.id, name: hit.name };
  }

  return { api, paged, validateTags, feedFlagsBody, ensureBookmarkList, rate, base };
}
