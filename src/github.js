/**
 * github.js — minimal GitHub Contents API client (web-standard fetch) for the knowledge repo.
 * One file per commit (Contents API); sha-based optimistic concurrency with one retry on conflict.
 */
export class GitHubError extends Error {
  constructor(message, status, extra = {}) { super(message); this.status = status; Object.assign(this, extra); }
}

const enc = new TextEncoder();
const dec = new TextDecoder();
export function utf8ToBase64(str) {
  const bytes = enc.encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
export function base64ToUtf8(b64) {
  const bin = atob(String(b64).replace(/\s+/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return dec.decode(bytes);
}

export function createGitHub({ token, repo, branch = 'main', apiBase = 'https://api.github.com', fetchImpl = globalThis.fetch, timeoutMs = 20000, userAgent = 'daily-dev-connector' } = {}) {
  if (!token) throw new GitHubError('GITHUB_TOKEN is not configured on the server', 503);
  if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new GitHubError('GITHUB_REPO must be "owner/repo"', 503);
  const base = apiBase.replace(/\/+$/, '');

  async function api(method, route, { body } = {}) {
    let res;
    try {
      res = await fetchImpl(`${base}${route}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': userAgent, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) { throw new GitHubError(`GitHub unreachable: ${e.message}`, 502); }
    const text = await res.text();
    let data = null; try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
    if (res.status === 401) throw new GitHubError('GitHub token invalid or expired (401) — regenerate the fine-grained token and update the GITHUB_TOKEN secret', 401);
    if (res.status === 403) throw new GitHubError(`GitHub refused (403): ${data?.message || 'token lacks Contents: read/write on this repo'}`, 403);
    if (res.status === 404) throw new GitHubError(`GitHub 404: ${route}`, 404, { data });
    if (res.status === 409 || res.status === 422) throw new GitHubError(`GitHub conflict (${res.status}): ${data?.message || 'sha mismatch'}`, 409, { data });
    if (!res.ok) throw new GitHubError(`GitHub ${res.status} on ${method} ${route}: ${data?.message || text.slice(0, 200)}`, res.status);
    return data;
  }

  const contentsRoute = (path) => `/repos/${repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}`;

  /** Returns { text, sha, htmlUrl } or null if the file does not exist. */
  async function readFile(path) {
    try {
      const d = await api('GET', `${contentsRoute(path)}?ref=${encodeURIComponent(branch)}`);
      if (Array.isArray(d)) throw new GitHubError(`${path} is a directory`, 400);
      return { text: base64ToUtf8(d.content || ''), sha: d.sha, htmlUrl: d.html_url };
    } catch (e) { if (e.status === 404) return null; throw e; }
  }

  /** Create or update a file. `sha` must be the current sha when updating. */
  async function writeFile(path, text, message, sha) {
    const d = await api('PUT', contentsRoute(path), { body: { message, content: utf8ToBase64(text), branch, ...(sha ? { sha } : {}) } });
    return { sha: d?.content?.sha, htmlUrl: d?.content?.html_url, commitUrl: d?.commit?.html_url, commitSha: d?.commit?.sha };
  }

  /** Read-modify-write with one retry on sha conflict. `mutate(currentTextOrNull) -> newText | null (no change)`. */
  async function update(path, message, mutate) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const cur = await readFile(path);
      const next = await mutate(cur?.text ?? null);
      if (next === null || next === cur?.text) return { changed: false, htmlUrl: cur?.htmlUrl || null };
      try { const w = await writeFile(path, next, message, cur?.sha); return { changed: true, ...w }; }
      catch (e) { if (e.status === 409 && attempt === 0) continue; throw e; }
    }
    throw new GitHubError('GitHub write conflict persisted after retry', 409);
  }

  return { api, readFile, writeFile, update, repo, branch };
}
