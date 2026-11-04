#!/bin/bash
# Probe the gateway admin surface now that it binds on 3002.
#
# The question this answers: can a PERSON be added by an API call? If yes, adding a colleague needs
# no operator. If no, the answer has to come from the architecture instead of from configuration.
set -u
KEY="${KEY:-admin-dev-local}"
BASE="${BASE:-http://127.0.0.1:3002}"

status() {
  curl -s -m 4 -o /tmp/probe-body -w '%{http_code}' -H "x-api-key: $KEY" "$BASE$1" 2>/dev/null
}

echo "=== reads ==="
for p in / /admin /admin/v1/resources /admin/v1/a2a_agents /admin/v1/a2a-agents \
         /status /status/ready /status/config /openapi.json /metrics; do
  code=$(status "$p")
  size=$(wc -c < /tmp/probe-body 2>/dev/null || echo 0)
  printf '%-30s %s  %s bytes\n' "$p" "$code" "$size"
done

echo
echo "=== bodies worth reading ==="
for p in /admin/v1/resources /admin/v1/a2a_agents /openapi.json; do
  code=$(status "$p")
  if [ "$code" = "200" ]; then
    echo "--- $p ---"
    head -c 600 /tmp/probe-body
    echo
  fi
done

echo
echo "=== write attempts ==="
for p in /admin/v1/resources /admin/v1/a2a_agents; do
  code=$(curl -s -m 4 -o /tmp/probe-body -w '%{http_code}' -X POST \
    -H "x-api-key: $KEY" -H 'content-type: application/json' -d '{}' "$BASE$p" 2>/dev/null)
  printf 'POST %-28s %s\n' "$p" "$code"
  head -c 200 /tmp/probe-body 2>/dev/null
  echo
done
