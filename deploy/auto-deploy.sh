#!/bin/sh
# Deploys origin/main on this box once GitHub Actions has passed on it. Run every minute by the
# devin4discord-deploy systemd timer (see deploy/install-auto-deploy.sh); safe to run by hand.
set -eu

cd "$(dirname "$0")/.."
REPO="${REPO:-fmflex/devin4discord}"
BRANCH="${BRANCH:-main}"
SKIP_FILE="$(git rev-parse --git-dir)/auto-deploy-skip"

[ "$(git rev-parse --abbrev-ref HEAD)" = "$BRANCH" ] || { echo "not on $BRANCH, not deploying" >&2; exit 1; }

git fetch --quiet origin "$BRANCH"
target="$(git rev-parse "origin/$BRANCH")"
[ "$(git rev-parse HEAD)" = "$target" ] && exit 0
[ -f "$SKIP_FILE" ] && [ "$(cat "$SKIP_FILE")" = "$target" ] && exit 0

# All of the commit's check runs must have finished, at least one, and none failed.
auth=""
[ -n "${GITHUB_TOKEN:-}" ] && auth="Authorization: Bearer $GITHUB_TOKEN"
ci="$(curl -fsS -H "Accept: application/vnd.github+json" ${auth:+-H "$auth"} \
  "https://api.github.com/repos/$REPO/commits/$target/check-runs?per_page=100" |
  python3 -c '
import json, sys
runs = json.load(sys.stdin)["check_runs"]
if not runs or any(r["status"] != "completed" for r in runs):
    print("pending")
elif all(r["conclusion"] in ("success", "neutral", "skipped") for r in runs):
    print("success")
else:
    print("failure")
' 2>/dev/null)" || { echo "could not read CI status for $target, retrying next run" >&2; exit 0; }

case "$ci" in
  pending) exit 0 ;;
  failure)
    echo "CI failed on $target, not deploying it" >&2
    echo "$target" > "$SKIP_FILE"
    exit 0 ;;
esac

echo "deploying $target: $(git log -1 --format=%s "$target")"
git merge --quiet --ff-only "origin/$BRANCH"
docker compose up -d --build --remove-orphans
docker image prune -f >/dev/null
echo "deployed $target"
