#!/bin/sh
# Probe the mock upstream from INSIDE the aisix container (same netns as WSL with
# --network host), so a gateway-side failure can be told apart from a network one.
set -u
URL="${1:-http://192.168.3.7:3092/.well-known/agent-card.json}"
KEY="${2:-mock-upstream-token-2026}"

echo "== wget card =="
wget -T 5 -O /tmp/card.json --header="x-api-key: $KEY" "$URL" 2>&1 | tail -3
echo "== size =="
wc -c < /tmp/card.json 2>/dev/null || echo "(no file)"
echo "== first 300 bytes =="
cut -c1-300 /tmp/card.json 2>/dev/null
