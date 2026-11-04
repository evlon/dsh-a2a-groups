#!/bin/bash
# Confirm the admin surface is read-only, so the design decision rests on evidence.
#
# A 405 on POST means the route exists and does not accept writes; a 404 would mean it does not
# exist. The distinction matters: one says "this build deliberately removed writes", the other says
# "you have the wrong path". Only the first justifies changing the architecture.
set -u
KEY="${KEY:-admin-dev-local}"
BASE="${BASE:-http://127.0.0.1:3002}"

echo "=== one agent entry (read) ==="
ID=$(curl -s -m 4 -H "x-api-key: $KEY" "$BASE/admin/v1/a2a_agents" 2>/dev/null \
     | sed -n 's/.*"id":"\([^"]*\)".*/\1/p' | head -1)
echo "id: $ID"

echo
echo "=== every write verb on the collection ==="
for verb in POST PUT PATCH DELETE; do
  code=$(curl -s -m 4 -o /tmp/wbody -w '%{http_code}' -X "$verb" \
    -H "x-api-key: $KEY" -H 'content-type: application/json' \
    -d '{"name":"probe-should-not-exist","url":"http://127.0.0.1:9999/a2a"}' \
    "$BASE/admin/v1/a2a_agents" 2>/dev/null)
  printf '%-6s /admin/v1/a2a_agents -> %s  %s\n' "$verb" "$code" "$(head -c 120 /tmp/wbody 2>/dev/null)"
done

echo
echo "=== every write verb on a single item ==="
if [ -n "$ID" ]; then
  for verb in PUT PATCH DELETE; do
    code=$(curl -s -m 4 -o /tmp/wbody -w '%{http_code}' -X "$verb" \
      -H "x-api-key: $KEY" -H 'content-type: application/json' -d '{}' \
      "$BASE/admin/v1/a2a_agents/$ID" 2>/dev/null)
    printf '%-6s /admin/v1/a2a_agents/{id} -> %s\n' "$verb" "$code"
  done
fi

echo
echo "=== does a resources reload endpoint exist? ==="
for p in /admin/v1/reload /admin/v1/resources/reload /admin/v1/config/reload; do
  code=$(curl -s -m 4 -o /tmp/wbody -w '%{http_code}' -X POST -H "x-api-key: $KEY" "$BASE$p" 2>/dev/null)
  printf 'POST %-32s %s\n' "$p" "$code"
done
