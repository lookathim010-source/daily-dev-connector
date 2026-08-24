/**
 * tools-memory.js — agent memory tools: KV run state + GitHub knowledge, plus the incremental learn pull.
 */
import * as z from 'zod/v4';
import { normPost, rankPosts, DailyDevError } from './dailydev.js';
import { createStateStore, createKnowledgeStore, MemoryError } from './memory.js';

function ok(data, text) { return { content: [{ type: 'text', text: text ?? JSON.stringify(data, null, 1) }], structuredContent: data }; }
function errResult(e) {
  const status = e?.status || 500;
  return { isError: true, content: [{ type: 'text', text: `error (${status}): ${e.message}` }], structuredContent: { error: e.message, status } };
}
const guard = (fn) => async (...a) => { try { return await fn(...a); } catch (e) { return errResult(e); } };

const LESSON = z.object({
  postId: z.string().optional().describe('daily.dev post id — gets marked as seen'),
  lesson: z.string().min(8).max(600).describe('one actionable sentence'),
  why: z.string().max(800).optional().describe('what it changes for the user / project'),
  action: z.string().max(400).optional(),
  url: z.string().url().describe('the post url — the evidence and the de-dup key'),
  title: z.string().max(300).optional(), source: z.string().max(120).optional(),
  upvotes: z.number().int().optional(), comments: z.number().int().optional(),
  tags: z.array(z.string()).max(10).optional(), confidence: z.number().min(0).max(100).optional(),
});

export function registerMemoryTools(server, dd, env) {
  const kvReady = !!env.AGENT_KV;
  const ghReady = !!(env.GITHUB_TOKEN && env.GITHUB_REPO);
  const state = () => createStateStore(env.AGENT_KV);
  const knowledge = () => createKnowledgeStore(env);

  server.registerTool('agent_state', {
    title: 'agent memory: run state (KV)',
    description: `Read or patch the agent's run state in Cloudflare KV: seen-post watermark size, lastSync/lastLearn, lessonsFiled, runs, lastBrief, feedId, free-form notes. op=get returns it; op=patch deep-merges a JSON object (set a key to null to delete it). ${kvReady ? '' : 'NOT CONFIGURED on this deployment.'}`,
    inputSchema: z.object({ op: z.enum(['get', 'patch']).default('get'), patch: z.record(z.string(), z.any()).optional().describe('for op=patch: keys to merge, e.g. {"lastBrief":{"at":"…","text":"…"},"notes":{"focus":"MCP transports"}}') }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, guard(async ({ op, patch }) => {
    const st = state();
    if (op === 'patch') { if (!patch || typeof patch !== 'object') throw new MemoryError('patch object required', 400); if ('seen' in patch) throw new MemoryError('seen is managed by knowledge_append / agent_ack', 400); }
    const s = op === 'patch' ? await st.patch(patch) : await st.get();
    const view = { ...s, seen: undefined, seenCount: Object.keys(s.seen || {}).length };
    return ok(view, `state: seen ${view.seenCount} · runs ${s.runs} · lessons filed ${s.lessonsFiled} · last learn ${s.lastLearn || '-'} · last sync ${s.lastSync || '-'}${s.lastBrief?.at ? ` · last brief ${s.lastBrief.at}` : ''}`);
  }));

  server.registerTool('agent_ack', {
    title: 'agent memory: mark posts seen',
    description: 'Marks daily.dev post ids as seen so incremental learn pulls skip them (use for posts you read but did not file as lessons). knowledge_append marks filed posts automatically.',
    inputSchema: z.object({ postIds: z.array(z.string()).min(1).max(200) }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, guard(async ({ postIds }) => {
    const s = await state().markSeen(postIds);
    return ok({ acked: postIds.length, seenCount: Object.keys(s.seen).length }, `acked ${postIds.length}; seen total ${Object.keys(s.seen).length}`);
  }));

  server.registerTool('agent_learn_pull', {
    title: 'agent memory: incremental learn pull',
    description: "The pull step of the learning loop with memory: fetches the agent feed, drops posts already seen (KV watermark), keeps posts created in the last sinceHours, ranks by engagement, returns the top N with summaries, and records lastSync + runs in KV. Nothing is marked seen here — file lessons with knowledge_append and ack the rest with agent_ack. Without KV it degrades to a window-only pull.",
    inputSchema: z.object({ feedId: z.string().min(1), sinceHours: z.number().min(1).max(24 * 60).default(26), top: z.number().int().min(1).max(25).default(8), pages: z.number().int().min(1).max(4).default(2) }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, guard(async ({ feedId, sinceHours, top, pages }) => {
    const { items } = await dd.paged(`/feeds/custom/${encodeURIComponent(feedId)}`, { limit: 50, pages });
    const cutoff = Date.now() - sinceHours * 3600e3;
    let seen = {}; let s = null;
    if (kvReady) { s = await state().get(); seen = s.seen || {}; }
    const all = items.map(normPost);
    const inWindow = all.filter((p) => p.createdAt && new Date(p.createdAt).getTime() >= cutoff);
    const unseen = rankPosts(inWindow.filter((p) => !seen[p.id]));
    if (kvReady) { s.lastSync = new Date().toISOString(); s.runs = (s.runs || 0) + 1; s.feedId = feedId; await state().put(s); }
    const data = { feedId, sinceHours, fetched: items.length, inWindow: inWindow.length, unseen: unseen.length, alreadySeen: inWindow.length - unseen.length, memory: kvReady ? 'kv' : 'none', top: unseen.slice(0, top), rateLimit: { ...dd.rate } };
    const lines = data.top.map((p, i) => `${i + 1}. ${p.title} — ${p.source || '?'} (⬆️ ${p.upvotes} · 💬 ${p.comments}) [${(p.tags || []).slice(0, 4).join(', ')}]\n   ${p.url}  id=${p.id}`);
    return ok(data, `${data.unseen} unseen of ${data.inWindow} in the last ${sinceHours}h (fetched ${data.fetched}, ${data.alreadySeen} already seen). Top ${data.top.length}:\n${lines.join('\n') || '(nothing new)'}`);
  }));

  server.registerTool('knowledge_read', {
    title: 'agent memory: read knowledge (GitHub)',
    description: `Reads the agent's knowledge file from the GitHub knowledge repo (newest day first). days=N returns only the newest N day-sections. Use before answering stack questions and at the start of a learn run. ${ghReady ? '' : 'NOT CONFIGURED on this deployment.'}`,
    inputSchema: z.object({ days: z.number().int().min(1).max(60).optional(), path: z.string().max(200).default('knowledge.md') }),
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, guard(async ({ days, path }) => {
    const r = await knowledge().read({ days, path });
    return ok(r, r.exists ? r.text : `(${path} does not exist yet — the first knowledge_append creates it)`);
  }));

  server.registerTool('knowledge_append', {
    title: 'agent memory: file lessons (GitHub + KV)',
    description: 'Files distilled lessons into the knowledge repo: appends under today\'s date in knowledge.md (newest day first), writes lessons/YYYY-MM-DD.md, de-duplicates by source url, then marks the lessons\' postIds as seen and bumps counters in KV. Every lesson needs a url (the evidence). Returns commit links.',
    inputSchema: z.object({ lessons: z.array(LESSON).min(1).max(20), day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), dailyFile: z.boolean().default(true) }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, guard(async ({ lessons, day, dailyFile }) => {
    const r = await knowledge().append({ lessons, day, dailyFile });
    let seenCount = null;
    if (kvReady) {
      const st = state(); const s = await st.get();
      const at = new Date().toISOString();
      for (const l of lessons) if (l.postId) s.seen[l.postId] = at;
      s.lastLearn = at; s.lessonsFiled = (s.lessonsFiled || 0) + r.filed;
      await st.put(s); seenCount = Object.keys(s.seen).length;
    }
    const data = { ...r, kv: kvReady ? { seenCount } : null };
    return ok(data, `📝 filed ${r.filed} lesson(s)${r.skipped ? ` (${r.skipped} duplicate source(s) skipped)` : ''} → ${r.knowledge.htmlUrl || r.knowledge.path}${r.knowledge.commitUrl ? `\ncommit: ${r.knowledge.commitUrl}` : ''}${kvReady ? `\nKV: seen ${seenCount}` : ''}`);
  }));

  server.registerTool('knowledge_search', {
    title: 'agent memory: search knowledge',
    description: 'Case-insensitive search over the lessons in knowledge.md (lesson text, why, action, source). Returns matching lessons with their day and source url.',
    inputSchema: z.object({ q: z.string().min(2).max(120), limit: z.number().int().min(1).max(50).default(10) }),
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, guard(async ({ q, limit }) => {
    const r = await knowledge().search({ q, limit });
    return ok(r, r.hits.length ? r.hits.map((h, i) => `${i + 1}. (${h.day}) ${h.lesson}${h.source ? ` — ${h.source}` : ''}`).join('\n') : `no lessons match "${q}"`);
  }));
}
