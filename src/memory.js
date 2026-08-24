/**
 * memory.js — the agent's memory layer for the connector.
 *   - run state in Cloudflare KV (seen post ids / watermarks, last run, counters, last brief)
 *   - readable knowledge in a GitHub repo (knowledge.md newest-day-first + lessons/YYYY-MM-DD.md)
 * Rendering matches the daily-dev-agentic plugin's knowledge.md format exactly, so both loops share one shape.
 */
import { createGitHub } from './github.js';

export const STATE_KEY = 'state:v1';
export const MAX_SEEN = 3000;
export const KNOWLEDGE_PATH = 'knowledge.md';

export class MemoryError extends Error { constructor(message, status = 500) { super(message); this.status = status; } }

function today() { return new Date().toISOString().slice(0, 10); }
function nowIso() { return new Date().toISOString(); }

// ---------------------------------------------------------------------------
// KV state
// ---------------------------------------------------------------------------

export function emptyState() {
  return { version: 1, seen: {}, lastSync: null, lastLearn: null, lessonsFiled: 0, runs: 0, lastBrief: null, feedId: null, notes: {} };
}

export function createStateStore(kv) {
  if (!kv || typeof kv.get !== 'function') throw new MemoryError('AGENT_KV binding is not configured on the Worker (add the kv_namespaces binding and redeploy)', 503);
  async function get() {
    const raw = await kv.get(STATE_KEY, 'json');
    return { ...emptyState(), ...(raw || {}) };
  }
  function bound(state) {
    const entries = Object.entries(state.seen || {});
    if (entries.length > MAX_SEEN) { entries.sort((a, b) => (a[1] < b[1] ? 1 : -1)); state.seen = Object.fromEntries(entries.slice(0, MAX_SEEN)); }
    return state;
  }
  async function put(state) { await kv.put(STATE_KEY, JSON.stringify(bound(state))); return state; }
  async function patch(p) { const s = await get(); const next = deepMerge(s, p); return put(next); }
  async function markSeen(ids) { const s = await get(); const at = nowIso(); for (const id of ids || []) if (id) s.seen[id] = at; return put(s); }
  return { get, put, patch, markSeen };
}

export function deepMerge(base, patch) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return patch;
  const out = { ...(base && typeof base === 'object' && !Array.isArray(base) ? base : {}) };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete out[k];
    else if (typeof v === 'object' && !Array.isArray(v)) out[k] = deepMerge(out[k], v);
    else out[k] = v;
  }
  return out;
}

// ---------------------------------------------------------------------------
// knowledge.md rendering (same format as the plugin's dda.mjs `note`)
// ---------------------------------------------------------------------------

export function knowledgeHeader(name) {
  return `# daily-dev-agentic knowledge — ${name}\n\n<!-- Managed by the daily-dev-agentic connector. Newest day first. Each lesson is distilled from a daily.dev post; the link is the evidence. -->\n\n`;
}

export function renderLessons(lessons) {
  return lessons.map((l) => {
    const conf = l.confidence != null ? ` · confidence ${Math.round(Number(l.confidence))}%` : '';
    const tags = (l.tags || []).length ? ` · tags: ${(l.tags || []).slice(0, 5).join(', ')}` : '';
    const eng = (l.upvotes != null || l.comments != null) ? ` (⬆️ ${l.upvotes ?? 0} · 💬 ${l.comments ?? 0})` : '';
    const why = l.why ? `\n  - Why it matters here: ${l.why}` : '';
    const action = l.action ? `\n  - Do: ${l.action}` : '';
    return `- **${String(l.lesson).trim()}**${why}${action}\n  - Source: [${String(l.title || l.url).trim()}](${l.url})${l.source ? ` — ${l.source}` : ''}${eng}${tags}${conf}`;
  }).join('\n');
}

export function upsertDaySection(md, day, block) {
  const heading = `## ${day}`;
  const lines = md.split('\n');
  const idx = lines.findIndex((l) => l.trim() === heading);
  if (idx === -1) {
    const firstDay = lines.findIndex((l) => /^## \d{4}-\d{2}-\d{2}/.test(l));
    const insertAt = firstDay === -1 ? lines.length : firstDay;
    const before = lines.slice(0, insertAt).join('\n').replace(/\s+$/, '');
    const after = lines.slice(insertAt).join('\n');
    return `${before}\n\n${heading}\n\n${block}\n${after ? '\n' + after : ''}`.replace(/\n{3,}/g, '\n\n');
  }
  let end = lines.findIndex((l, i) => i > idx && /^## /.test(l));
  if (end === -1) end = lines.length;
  const section = lines.slice(idx, end).join('\n').replace(/\s+$/, '');
  const rest = lines.slice(end).join('\n');
  return `${lines.slice(0, idx).join('\n')}\n${section}\n${block}\n${rest ? '\n' + rest : ''}`.replace(/\n{3,}/g, '\n\n');
}

export function existingSourceUrls(md) {
  const urls = new Set(); const re = /- Source: \[[^\]]*\]\(([^)]+)\)/g; let m;
  while ((m = re.exec(md))) urls.add(m[1]);
  return urls;
}

/** Return only the newest `days` day-sections of a knowledge.md (header kept). */
export function recentSections(md, days) {
  if (!days) return md;
  const lines = md.split('\n');
  const out = []; let count = 0;
  for (const line of lines) {
    if (/^## \d{4}-\d{2}-\d{2}/.test(line)) { count++; if (count > days) break; }
    out.push(line);
  }
  return out.join('\n').replace(/\s+$/, '') + '\n';
}

export function validateLessons(lessons) {
  if (!Array.isArray(lessons) || !lessons.length) throw new MemoryError('lessons must be a non-empty array', 400);
  for (const l of lessons) {
    if (!l || typeof l.lesson !== 'string' || !l.lesson.trim()) throw new MemoryError('each lesson needs a non-empty "lesson"', 400);
    if (typeof l.url !== 'string' || !/^https?:\/\//.test(l.url)) throw new MemoryError('each lesson needs an http(s) "url" (the evidence)', 400);
    if (l.confidence != null && (Number(l.confidence) < 0 || Number(l.confidence) > 100)) throw new MemoryError('confidence must be 0..100', 400);
  }
}

// ---------------------------------------------------------------------------
// knowledge store (GitHub)
// ---------------------------------------------------------------------------

export function createKnowledgeStore(env) {
  const gh = createGitHub({ token: env.GITHUB_TOKEN, repo: env.GITHUB_REPO, branch: env.GITHUB_BRANCH || 'main', apiBase: env.GITHUB_API_BASE, userAgent: 'daily-dev-connector' });
  const name = env.KNOWLEDGE_NAME || 'agent memory';

  async function read({ days, path = KNOWLEDGE_PATH } = {}) {
    const f = await gh.readFile(path);
    if (!f) return { path, exists: false, text: '', htmlUrl: null };
    return { path, exists: true, text: days ? recentSections(f.text, days) : f.text, htmlUrl: f.htmlUrl, sha: f.sha };
  }

  async function append({ lessons, day = today(), path = KNOWLEDGE_PATH, dailyFile = true }) {
    validateLessons(lessons);
    let filed = 0, skipped = 0, filedLessons = [];
    const r = await gh.update(path, `daily-dev-agentic: ${lessons.length} lesson(s) ${day}`, (cur) => {
      let md = cur ?? knowledgeHeader(name);
      const have = existingSourceUrls(md);
      filedLessons = lessons.filter((l) => !have.has(l.url));
      filed = filedLessons.length; skipped = lessons.length - filed;
      if (!filed) return null;
      return upsertDaySection(md, day, renderLessons(filedLessons));
    });
    let daily = null;
    if (dailyFile && filed) {
      const dpath = `lessons/${day}.md`;
      daily = await gh.update(dpath, `daily-dev-agentic: ${day} lessons`, (cur) => {
        const head = cur ?? `# Lessons — ${day}\n\n`;
        const have = existingSourceUrls(head);
        const fresh = filedLessons.filter((l) => !have.has(l.url));
        return fresh.length ? head.replace(/\s+$/, '') + '\n\n' + renderLessons(fresh) + '\n' : null;
      });
    }
    return { day, filed, skipped, knowledge: { path, htmlUrl: r.htmlUrl, commitUrl: r.commitUrl || null }, daily: daily ? { path: `lessons/${day}.md`, htmlUrl: daily.htmlUrl, commitUrl: daily.commitUrl || null } : null, filedPostIds: filedLessons.map((l) => l.postId).filter(Boolean) };
  }

  async function search({ q, limit = 10, path = KNOWLEDGE_PATH }) {
    const f = await gh.readFile(path);
    if (!f) return { q, hits: [] };
    const needle = q.toLowerCase();
    const hits = [];
    let day = null; let current = null;
    const flush = () => { if (current && current.text.toLowerCase().includes(needle)) hits.push(current); current = null; };
    for (const line of f.text.split('\n')) {
      const d = /^## (\d{4}-\d{2}-\d{2})/.exec(line); if (d) { flush(); day = d[1]; continue; }
      if (/^- \*\*/.test(line)) { flush(); current = { day, text: line }; continue; }
      if (current && /^\s+- /.test(line)) current.text += '\n' + line;
    }
    flush();
    return { q, hits: hits.slice(0, limit).map((h) => ({ day: h.day, lesson: /^- \*\*(.+?)\*\*/.exec(h.text)?.[1] || h.text.slice(0, 200), source: /- Source: \[[^\]]*\]\(([^)]+)\)/.exec(h.text)?.[1] || null })) };
  }

  return { read, append, search, repo: gh.repo, branch: gh.branch };
}
