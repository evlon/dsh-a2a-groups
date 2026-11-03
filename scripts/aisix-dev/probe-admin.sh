#!/bin/sh
# Discover which admin routes this gateway build actually serves.
#
# Exists because the admin surface moved between AISIX releases (the write
# endpoints were removed and the resource view became read-only), and guessing a
# path is how a self-check ends up reporting "unreachable" for a perfectly healthy
# gateway. Probing is cheap; a wrong assumption is not.
set -u
BASE="${1:-http://127.0.0.1:3001}"
KEY="${2:-admin-dev-local}"

for path in \
  /admin/v1/a2a_agents \
  /admin/v1/a2a-agents \
  /admin/v1/resources \
  /admin/v1/resources/a2a_agents \
  /status/config \
  /status/ready \
  /openapi.json \
  /docs \
  /
do
  code=$(curl -s -m 3 -o /tmp/probe.out -w '%{http_code}' -H "x-api-key: $KEY" "$BASE$path" 2>/dev/null || echo 000)
  size=$(wc -c < /tmp/probe.out 2>/dev/null || echo 0)
  printf '%-36s %s  (%s bytes)\n' "$path" "$code" "$size"
done
