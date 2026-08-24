#!/usr/bin/env bash
# deploy.sh — one-shot, non-interactive deploy of the daily.dev MCP connector to Cloudflare Workers.
# Works from any cloud shell: no browser login, no local machine. Idempotent (safe to re-run).
#
# Required env:
#   CLOUDFLARE_API_TOKEN     API token from the "Edit Cloudflare Workers" template
#   CLOUDFLARE_ACCOUNT_ID    Cloudflare account id
#   DAILY_DEV_TOKEN          daily.dev Plus token (dda_…)
#   MCP_AUTH_KEY             connector key (>= 16 chars; generate: node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))")
#   GITHUB_TOKEN             fine-grained PAT with Contents: read/write on the knowledge repo
#   GITHUB_REPO              owner/agent-knowledge
# Optional env:
#   WORKERS_SUBDOMAIN        workers.dev subdomain to register if the account has none yet
#   GITHUB_BRANCH (main)     KNOWLEDGE_NAME ("T agent")     SKIP_TESTS=1
set -euo pipefail
cd "$(dirname "$0")"

need() { [ -n "${!1:-}" ] || { echo "missing env $1" >&2; exit 2; }; }
for v in CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID DAILY_DEV_TOKEN MCP_AUTH_KEY GITHUB_TOKEN GITHUB_REPO; do need "$v"; done
[ "${#MCP_AUTH_KEY}" -ge 16 ] || { echo "MCP_AUTH_KEY must be >= 16 chars" >&2; exit 2; }
export CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID
CF="https://api.cloudflare.com/client/v4"
cfapi() { curl -sS -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H "Content-Type: application/json" "$@"; }

echo "== 1/7 dependencies"; [ -d node_modules ] || npm ci --no-audit --no-fund >/dev/null
echo "== 2/7 token check"
# user tokens verify at /user/tokens/verify; account-owned tokens (cfat_…) at /accounts/{id}/tokens/verify — accept either
VER=$(cfapi "$CF/user/tokens/verify"); echo "$VER" | grep -q '"status":"active"' || VER=$(cfapi "$CF/accounts/$CLOUDFLARE_ACCOUNT_ID/tokens/verify")
echo "$VER" | grep -q '"status":"active"' && echo "   token active" || { echo "Cloudflare token not active: $VER" >&2; exit 1; }

echo "== 3/7 workers.dev subdomain"
SUB=$(cfapi "$CF/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/subdomain" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const j=JSON.parse(d);process.stdout.write((j.result&&j.result.subdomain)||"")})' || true)
if [ -n "${WORKERS_SUBDOMAIN:-}" ] && [ "$SUB" != "$WORKERS_SUBDOMAIN" ]; then SUB=""; fi   # explicit subdomain wins
if [ -z "$SUB" ]; then
  [ -n "${WORKERS_SUBDOMAIN:-}" ] || { echo "account has no workers.dev subdomain yet — set WORKERS_SUBDOMAIN=<name> and re-run" >&2; exit 3; }
  cfapi -X PUT "$CF/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/subdomain" -d "{\"subdomain\":\"$WORKERS_SUBDOMAIN\"}" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const j=JSON.parse(d);if(!j.success){console.error(JSON.stringify(j.errors));process.exit(1)}console.log("   registered",j.result.subdomain)})'
  SUB="$WORKERS_SUBDOMAIN"
else echo "   $SUB.workers.dev"; fi

echo "== 4/7 KV namespace"
KV_ID=$(npx wrangler kv namespace list 2>/dev/null | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const a=JSON.parse(d);const h=a.find(n=>/AGENT_KV$/.test(n.title));process.stdout.write(h?h.id:"")}catch{process.stdout.write("")}})' || true)
if [ -z "$KV_ID" ]; then
  KV_ID=$(npx wrangler kv namespace create AGENT_KV 2>&1 | tee /tmp/kv-create.log | grep -oE '"?id"?\s*[:=]\s*"[0-9a-f]{32}"' | grep -oE '[0-9a-f]{32}' | head -1)
  [ -n "$KV_ID" ] || { echo "could not create KV namespace:"; cat /tmp/kv-create.log; exit 4; }
  echo "   created $KV_ID"
else echo "   exists $KV_ID"; fi
KV_ID="$KV_ID" GITHUB_REPO="$GITHUB_REPO" GITHUB_BRANCH="${GITHUB_BRANCH:-main}" KNOWLEDGE_NAME="${KNOWLEDGE_NAME:-T agent}" node -e '
const fs=require("fs");let c=fs.readFileSync("wrangler.jsonc","utf8");
if(!/^[0-9a-f]{32}$/.test(process.env.KV_ID||"")) { console.error("bad KV_ID"); process.exit(1); }
c=c.replace(/"id":\s*"[^"]*"/, `"id": "${process.env.KV_ID}"`).replace(/"GITHUB_REPO":\s*"[^"]*"/, `"GITHUB_REPO": "${process.env.GITHUB_REPO}"`).replace(/"GITHUB_BRANCH":\s*"[^"]*"/, `"GITHUB_BRANCH": "${process.env.GITHUB_BRANCH}"`).replace(/"KNOWLEDGE_NAME":\s*"[^"]*"/, `"KNOWLEDGE_NAME": "${process.env.KNOWLEDGE_NAME}"`);
fs.writeFileSync("wrangler.jsonc",c);'
echo "   wrangler.jsonc updated (kv id + GITHUB_REPO)"

if [ -z "${SKIP_TESTS:-}" ]; then echo "== 5/7 tests"; npm test 2>&1 | grep -E "^# (tests|pass|fail)" | tr '\n' ' '; echo; fi

echo "== 6/7 deploy"; npx wrangler deploy 2>&1 | grep -vE "^\s*$" | tail -6
NAME=$(node -e 'const c=require("fs").readFileSync("wrangler.jsonc","utf8");console.log(/"name":\s*"([^"]+)"/.exec(c)[1])')
URL="https://$NAME.$SUB.workers.dev"

echo "== 7/7 secrets"
for s in DAILY_DEV_TOKEN MCP_AUTH_KEY GITHUB_TOKEN; do printf '%s' "${!s}" | npx wrangler secret put "$s" > "/tmp/secret-$s.log" 2>&1 && echo "   $s set" || { echo "   FAILED to set $s:" >&2; cat "/tmp/secret-$s.log" >&2; exit 5; }; done

echo; echo "deployed: $URL"
echo "health:   $(curl -s "$URL/")"
echo "next:     node harness/verify-connector.mjs $URL <MCP_AUTH_KEY> --feed <feedId>"
