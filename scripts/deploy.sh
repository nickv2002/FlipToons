#!/usr/bin/env bash
# Deploys apps/worker (the Worker + Durable Object) to Cloudflare, then
# verifies the live site is actually serving what was just built — a lesson
# from ../nick-scripts/restraunt-week/burger-week-2026's deploy/purge/verify
# split: `wrangler deploy` reporting success doesn't guarantee stale content
# is gone from the edge.
#
# That project needed a cache-purge step because it deployed a single
# un-hashed index.html — a stale edge cache kept serving old content
# indefinitely. apps/web's Vite build content-hashes its JS/CSS filenames
# (assets/index-XXXXXXXX.js), so a stale cached index.html can only ever
# point at an OLD hashed bundle that still exists and still works, never a
# missing or wrong one — there's nothing here that needs a manual purge. This
# script still verifies rather than trusting `wrangler deploy`'s exit code,
# because "deployed" and "edge is serving it" are different claims.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SITE_URL="https://fliptoons.win/"

echo "Building apps/web..."
(cd "$ROOT/apps/web" && bun run build)

echo "Deploying apps/worker..."
(cd "$ROOT/apps/worker" && bunx wrangler deploy)

# Vite/Rollup's content hash uses the base64url alphabet (letters, digits,
# `_`, `-`), not just alphanumerics — a hash like index-G4Q_oCpy.js needs the
# underscore in the class or the match truncates before `.js` and silently
# fails to match at all (this bit a deploy: the old [A-Za-z0-9]-only class
# matched "index-G4Q" and stopped, so `grep -o` returned nothing and `set -e`
# killed the script right here with no "Verifying..." line ever printed).
local_hash="$(grep -oE 'assets/index-[A-Za-z0-9_-]+\.js' "$ROOT/apps/web/dist/index.html")"
echo "Verifying $SITE_URL serves $local_hash..."
# A first-ever deploy of a NEW custom domain also has to wait on the DNS
# record itself, not just the deployed content — Cloudflare's custom_domain
# route creates it automatically, but propagation to a local resolver has
# taken up to a minute or two in practice. 24 attempts / ~2 minutes gives that
# room; a re-deploy of an already-live domain typically succeeds on the first
# or second attempt.
attempts=24
for i in $(seq 1 "$attempts"); do
  response="$(curl -s --max-time 5 "$SITE_URL" || true)"
  if [[ -z "$response" ]]; then
    echo "  attempt $i/$attempts: not resolving/reachable yet, retrying..."
  else
    live_hash="$(grep -oE 'assets/index-[A-Za-z0-9_-]+\.js' <<<"$response" || true)"
    if [[ "$live_hash" == "$local_hash" ]]; then
      echo "verified: live site matches ($live_hash)"
      exit 0
    fi
    echo "  attempt $i/$attempts: reachable, but serving [${live_hash:-no matching asset}] instead of [$local_hash], retrying..."
  fi
  sleep 5
done
echo "! live site still doesn't match the local build after $attempts attempts."
echo "  If every attempt above said 'not resolving/reachable': this machine's local DNS cache may just be slow to pick up a brand-new custom domain — check with 'dig +short ${SITE_URL#https://}' against a public resolver (e.g. 'dig +short ${SITE_URL#https://} @1.1.1.1'); if THAT resolves, the deploy is fine and this is a local caching artifact, not a deploy problem."
echo "  If attempts showed a wrong/different hash: check wrangler's deploy output above, or the custom domain route in the Cloudflare dashboard."
exit 1
