#!/bin/bash
# Probe which admin routes the running gateway build serves, from the WSL side.
#
# Run from WSL, not inside the container: the container is built from a distroless-ish image with no
# curl or wget, and `--network host` means the admin listener is already reachable on 127.0.0.1.
#
# WHY THIS MATTERS
#
# The point is to find out whether a person can be added WITHOUT editing resources.yaml and sending
# SIGHUP. Editing a file is an operator action; adding a colleague is a colleague action. If the
# gateway has no writable admin route, the two cannot be separated by configuration alone and the
# answer has to come from the architecture instead.
set -u
KEY="${KEY:-admin-dev-local}"
BASE="${BASE:-http://127.0.0.1:3001}"

probe() {
  local path="$1"
  local method="${2:-GET}"
  local code body
  if [ "$method" = "GET" ]; then
    body=$(curl -s -m 4 -H "x-api-key: $KEY" "$BASE$path" 2>/dev/null)
  else
    body=$(curl -s -m 4 -X "$method" -H "x-api-key: $KEY" -H 'content-type: application/json' -d '{}' "$BASE$path" 2>/dev/null)
  fi
  code=$(curl -s -m 4 -o /dev/null -w '%{http_code}' -H "x-api-key: $KEY" "$BASE$path" 2>/dev/null)
  printf '%-38s %-6s %s\n' "$path" "$method" "$code"
  if [ -n "$body" ]; then
    printf '    %.200s\n' "$body"
  fi
}

echo "=== GET routes ==="
for p in / /status /status/config /status/ready /openapi.json /docs \
         /admin /admin/v1/resources /admin/v1/a2a_agents /admin/v1/a2a-agents; do
  probe "$p"
done

echo
echo "=== write attempts (would let a colleague self-register) ==="
probe /admin/v1/resources POST
probe /admin/v1/a2a_agents POST
