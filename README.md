# daily-dev-connector — hosted MCP connector for daily.dev + agent memory (Cloudflare Worker)

Turns the daily.dev Public API into 13 typed MCP tools, adds a 6-tool **agent memory layer** (run state in
Cloudflare KV, readable lessons in a GitHub repo), and serves it all from a Cloudflare Worker you own. Secrets live
in Worker secrets — never in a prompt, config file, or chat — so **scheduled cloud runs, claude.ai web/mobile, Cowork,
and Claude Code** can run the learning loop with zero local machine. Stateless per request (no Durable Objects),
fits the Workers free tier.

Companion to the `daily-dev-agentic` plugin: same knowledge.md format, same loop —
`knowledge_read → agent_learn_pull → dailydev_post → distill → knowledge_append → agent_ack → dailydev_bookmark`.

## Tools

| Tool | What it does |
|---|---|
| `dailydev_whoami` | account, Plus status, rate-limit headroom — call first |
| `dailydev_list_feeds` / `dailydev_create_feed` | the agent's custom feeds (create is idempotent by name; tags validated; name sanitized) |
| `dailydev_feed_posts` | posts from custom / foryou / popular / discussed / tag / source feeds; `sinceHours`, ranking, cursor paging |
| `dailydev_learn_pull` | stateless pull: time window → ranked top N with summaries |
| `dailydev_post` | full post details (summary, tags, engagement, native content) |
| `dailydev_search` | semantic / keyword / posts / tags / sources |
| `dailydev_tags` | tag catalog (capped at 1,000 upstream) |
| `dailydev_feed_filters` / `dailydev_feed_tags` | read / follow / unfollow / block / unblock tags, `minUpvotes` — with live read-back |
| `dailydev_bookmark` / `dailydev_bookmarks` / `dailydev_bookmark_lists` | the "Agent picks" cross-surface store |
| **memory** `agent_state` | get / patch run state in KV (seen-count, lastSync/lastLearn, lessonsFiled, runs, lastBrief, notes) |
| **memory** `agent_ack` | mark post ids seen (read but not filed) |
| **memory** `agent_learn_pull` | incremental pull: window **and** KV seen-watermark; records runs/lastSync |
| **memory** `knowledge_read` | read `knowledge.md` from the GitHub repo (newest N day-sections) |
| **memory** `knowledge_append` | file lessons → `knowledge.md` (newest day first, de-dup by url) + `lessons/YYYY-MM-DD.md`, commit links back; marks postIds seen; bumps counters |
| **memory** `knowledge_search` | search lessons by text |

Every tool returns readable text **and** `structuredContent`; errors come back as `isError` with the upstream
status (401 → regenerate token, 403 → Plus lapsed / token scope, 404, 409 conflict retried once, 429 retried twice).

## Deploy from any cloud shell (no browser login, no local machine)

```bash
export CLOUDFLARE_API_TOKEN=…      # dashboard → My Profile → API Tokens → template "Edit Cloudflare Workers"
export CLOUDFLARE_ACCOUNT_ID=…     # dashboard → Workers & Pages → Account ID
export DAILY_DEV_TOKEN=dda_…       # daily.dev Plus token
export MCP_AUTH_KEY=…              # node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
export GITHUB_TOKEN=github_pat_…   # fine-grained, Contents: read/write on the knowledge repo
export GITHUB_REPO=owner/agent-knowledge
export WORKERS_SUBDOMAIN=yourname  # only needed the first time an account deploys a Worker
./deploy.sh                        # verifies token → subdomain → KV namespace → tests → deploy → secrets → health
node harness/verify-connector.mjs https://daily-dev-mcp.<sub>.workers.dev "$MCP_AUTH_KEY" --feed <feedId>   # expect GREEN
```

`deploy.sh` is idempotent: it reuses the KV namespace, rewrites `wrangler.jsonc` with the real ids, and re-sets secrets.
Rotate any secret with `printf '%s' "$NEW" | npx wrangler secret put NAME` (no redeploy).

### Ongoing: git-push deploys (Cloudflare Workers Builds)

Push this folder to a GitHub repo, then in the Cloudflare dashboard: Workers & Pages → `daily-dev-mcp` → Settings →
Builds → connect the repo (branch `main`, build command none, deploy command `npx wrangler deploy`). Secrets stay in the
Worker; every push redeploys. The committed `wrangler.jsonc` must carry the real KV id (deploy.sh writes it).

## Connect

- **claude.ai (web / mobile / Cowork / scheduled tasks)** — Settings → Connectors → *Add custom connector* → name
  `daily.dev`, URL `https://daily-dev-mcp.<sub>.workers.dev/mcp/<MCP_AUTH_KEY>`. The custom-connector form has no
  header field, so the key rides in the URL (a capability URL): treat the URL as a password.
- **Claude Code** — `claude mcp add --transport http daily-dev https://daily-dev-mcp.<sub>.workers.dev/mcp --header "Authorization: Bearer <MCP_AUTH_KEY>"`

## Security model

- Fail closed: no `MCP_AUTH_KEY` (or < 16 chars) → every `/mcp` request is refused with 503; no `DAILY_DEV_TOKEN` → 503;
  memory tools report "not configured" when the KV binding / GitHub secrets are absent.
- Constant-time key comparison; `401` + `WWW-Authenticate` on bad keys; per-IP soft rate limit (`RATE_LIMIT_PER_MIN`,
  default 120) in front of daily.dev's own 60/min.
- Outbound calls only to `https://api.daily.dev` and `https://api.github.com` (test overrides via `*_API_BASE`).
- No destructive tools (no feed delete, no profile edits, no personal For-You filter changes, no GitHub deletes —
  the GitHub token needs only Contents: read/write on the one knowledge repo).
- Health endpoint (`GET /`) reports booleans only.
- Upgrade path for per-client revocation: front the same handler with an OAuth 2.1 provider (Claude supports OAuth + DCR).

## Local development & tests

```bash
cp .dev.vars.example .dev.vars    # never commit (.gitignore covers it)
npx wrangler dev                  # real Cloudflare runtime (workerd), KV simulated locally
npm test                          # 28 checks: real MCP client → Worker → mock daily.dev + mock GitHub (auth, 401/503/405/429, all 19 tools, KV watermark, GitHub sha-conflict retry)
```

## daily.dev API quirks handled (verified live 2026-08-23)

`orderBy` in feed create/update → HTTP 500 (never sent) · feed names letters/digits/spaces only (sanitized) ·
`PATCH /feeds/custom/{id}` replaces all flags (full set always resent) · `/tags/` capped at 1,000 (unknown tags
confirmed via `/search/tags`) · `/recommend/semantic` is experimental and can return 0 results.

## Files

`src/index.js` (entry — handler only) · `src/core.js` (auth, rate limit, server factory) · `src/tools.js` (13 daily.dev tools)
· `src/tools-memory.js` (6 memory tools) · `src/memory.js` (KV state + knowledge rendering) · `src/github.js` (Contents API)
· `src/dailydev.js` (API client) · `wrangler.jsonc` · `deploy.sh` · `test/` · `harness/verify-connector.mjs`
