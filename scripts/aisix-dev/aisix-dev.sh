#!/bin/sh
# Start / stop / smoke-test the local AISIX gateway for the DSH × A2A × AISIX chain.
#
# Runs entirely inside WSL (podman 4.9.3, `--network host` — the WSL kernel here
# cannot use netavark bridges, so host networking is the only option). Both
# containers therefore share the WSL network namespace and can talk to each
# other over 127.0.0.1, which is the shortest path and avoids the "WSL container
# cannot reach the Windows host" trap entirely.
#
#   ./aisix-dev.sh up       start gateway + mock upstream
#   ./aisix-dev.sh down     stop both (configs are kept)
#   ./aisix-dev.sh status   container + port state
#   ./aisix-dev.sh smoke    full end-to-end check (card / send / stream / ACL / metrics)
#   ./aisix-dev.sh reload   SIGHUP the gateway after editing resources.yaml
#   ./aisix-dev.sh logs     follow the gateway log
#
# Everything is idempotent: `up` may be run repeatedly.

set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
DATA_DIR="${AISIX_DEV_DATA:-$HOME/aisix-dev/data}"
GATEWAY_NAME="${AISIX_DEV_GATEWAY:-aisix-dev}"
MOCK_NAME="${AISIX_DEV_MOCK:-mock-a2a}"
GATEWAY_IMAGE="${AISIX_DEV_IMAGE:-ghcr.io/api7/aisix:latest}"
NODE_IMAGE="${AISIX_DEV_NODE_IMAGE:-docker.io/library/node:22-slim}"

PROXY_PORT=3000
METRICS_PORT=9090
MOCK_PORT=3092

# DEV credentials — see resources.yaml for the matching hashes.
CALLER_KEY="${AISIX_DEV_CALLER_KEY:-dev-caller-key-not-a-secret}"
UPSTREAM_TOKEN="${AISIX_DEV_UPSTREAM_TOKEN:-mock-upstream-token-2026}"

log() { printf '%s\n' "$*"; }
fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

need_podman() {
  command -v podman >/dev/null 2>&1 || fail "podman is not on PATH (run this inside WSL)"
  podman info >/dev/null 2>&1 || fail "podman is installed but not usable — check 'podman info'"
}

sync_config() {
  mkdir -p "$DATA_DIR"
  cp -f "$SCRIPT_DIR/config.yaml" "$DATA_DIR/config.yaml"
  cp -f "$SCRIPT_DIR/resources.yaml" "$DATA_DIR/resources.yaml"
  log "configs synced to $DATA_DIR"
}

cmd_up() {
  need_podman
  sync_config

  if [ "$(podman ps -q --filter "name=^${MOCK_NAME}$" | wc -l)" -eq 0 ]; then
    podman rm -f "$MOCK_NAME" >/dev/null 2>&1 || true
    podman run -d --name "$MOCK_NAME" --network host \
      -v "$SCRIPT_DIR:/app:ro" -w /app \
      "$NODE_IMAGE" node mock-agent.mjs --port "$MOCK_PORT" --token "$UPSTREAM_TOKEN" --url "http://127.0.0.1:${MOCK_PORT}/a2a" >/dev/null
    log "mock upstream started ($MOCK_NAME on :$MOCK_PORT)"
  else
    log "mock upstream already running"
  fi

  if [ "$(podman ps -q --filter "name=^${GATEWAY_NAME}$" | wc -l)" -eq 0 ]; then
    podman rm -f "$GATEWAY_NAME" >/dev/null 2>&1 || true
    podman run -d --name "$GATEWAY_NAME" --network host \
      -v "$DATA_DIR:/etc/aisix:Z" "$GATEWAY_IMAGE" >/dev/null
    log "gateway started ($GATEWAY_NAME on :$PROXY_PORT proxy, :$METRICS_PORT metrics)"
  else
    log "gateway already running"
  fi

  printf 'waiting for the gateway'
  for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
    if curl -fsS -m 1 "http://127.0.0.1:${PROXY_PORT}/livez" >/dev/null 2>&1; then
      printf '\n'
      log "gateway is live"
      return 0
    fi
    printf '.'
    sleep 0.5
  done
  printf '\n'
  podman logs --tail 20 "$GATEWAY_NAME" 2>&1 || true
  fail "gateway did not become live within 10s"
}

cmd_down() {
  podman rm -f "$GATEWAY_NAME" >/dev/null 2>&1 || true
  podman rm -f "$MOCK_NAME" >/dev/null 2>&1 || true
  log "stopped (configs kept in $DATA_DIR)"
}

cmd_status() {
  need_podman
  podman ps -a --filter "name=^${GATEWAY_NAME}$" --filter "name=^${MOCK_NAME}$" \
    --format '{{.Names}}\t{{.Status}}\t{{.Image}}' || true
  for port in "$PROXY_PORT" "$METRICS_PORT" "$MOCK_PORT"; do
    if (exec 3<>"/dev/tcp/127.0.0.1/${port}") 2>/dev/null; then
      log "port $port: listening"
    else
      log "port $port: closed"
    fi
  done
}

cmd_reload() {
  podman kill -s HUP "$GATEWAY_NAME" >/dev/null
  sleep 1
  podman logs --tail 3 "$GATEWAY_NAME" 2>&1 | sed 's/^/  /'
}

cmd_logs() {
  podman logs -f "$GATEWAY_NAME"
}

# ---------------------------------------------------------------------------
# smoke — every assertion is a real HTTP call through the gateway.
# ---------------------------------------------------------------------------
cmd_smoke() {
  need_podman
  base="http://127.0.0.1:${PROXY_PORT}"
  card="${base}/a2a/mock-a2a/.well-known/agent-card.json"
  passed=0
  failed=0

  check() {
    label="$1"; actual="$2"; expected="$3"
    if [ "$actual" = "$expected" ]; then
      log "  PASS  $label ($actual)"
      passed=$((passed + 1))
    else
      log "  FAIL  $label — expected '$expected', got '$actual'"
      failed=$((failed + 1))
    fi
  }

  log "1. agent card served through the gateway and rewritten to it"
  # X-Forwarded-Proto decides the scheme the card advertises: without it the
  # gateway must assume https, because it cannot know no TLS terminator sits in
  # front of it. Local http development therefore sends the header explicitly —
  # this is a real behaviour of the gateway, not a local quirk.
  body=$(curl -fsS -m 10 -H "x-api-key: $CALLER_KEY" -H 'X-Forwarded-Proto: http' "$card" 2>/dev/null || echo '')
  expected_url="http://127.0.0.1:${PROXY_PORT}/a2a/mock-a2a"
  check "card top-level url points at the gateway" \
    "$(printf '%s' "$body" | grep -c "\"url\":\"${expected_url}\"")" "1"
  check "supportedInterfaces url rewritten too" \
    "$(printf '%s' "$body" | grep -o "\"url\":\"${expected_url}\"" | wc -l | tr -d ' ')" "2"
  check "protocolVersion is 1.0" "$(printf '%s' "$body" | grep -c '"protocolVersion":"1.0"')" "1"
  check "skills present" "$(printf '%s' "$body" | grep -c '"id":"echo"')" "1"
  check "upstream address not leaked" "$(printf '%s' "$body" | grep -c '127.0.0.1:3092')" "0"

  log "1b. without X-Forwarded-Proto the advertised scheme defaults to https"
  https_body=$(curl -fsS -m 10 -H "x-api-key: $CALLER_KEY" "$card" 2>/dev/null || echo '')
  check "default scheme is https" \
    "$(printf '%s' "$https_body" | grep -c "\"url\":\"https://127.0.0.1:${PROXY_PORT}/a2a/mock-a2a\"")" "1"

  log "2. credential gates: no key / wrong key / unknown agent"
  check "no key → 401" "$(curl -s -o /dev/null -w '%{http_code}' -m 5 "$card")" "401"
  check "wrong key → 401" "$(curl -s -o /dev/null -w '%{http_code}' -m 5 -H 'x-api-key: sk-wrong' "$card")" "401"
  check "unknown agent → 404" \
    "$(curl -s -o /dev/null -w '%{http_code}' -m 5 -H "x-api-key: $CALLER_KEY" "${base}/a2a/does-not-exist/.well-known/agent-card.json")" "404"

  log "3. SendMessage (unary, A2A 1.0 oneof payload)"
  unary=$(curl -fsS -m 20 -H "x-api-key: $CALLER_KEY" -H 'content-type: application/json' \
    -H 'A2A-Version: 1.0' --data-binary "@${SCRIPT_DIR}/send.json" "${base}/a2a/mock-a2a" 2>/dev/null || echo '')
  check "result carries a task" "$(printf '%s' "$unary" | grep -c '"result":{"task"')" "1"
  check "task completed" "$(printf '%s' "$unary" | grep -c 'TASK_STATE_COMPLETED')" "1"
  check "upstream saw the pinned A2A-Version" "$(printf '%s' "$unary" | grep -c 'a2a-version=1.0')" "1"
  check "upstream saw the gateway-held x-api-key" "$(printf '%s' "$unary" | grep -c 'api-key-present=true')" "1"
  check "caller key not forwarded upstream" "$(printf '%s' "$unary" | grep -c "$CALLER_KEY")" "0"

  log "4. SendStreamingMessage (SSE relayed event by event)"
  stream=$(curl -fsSN -m 30 -H "x-api-key: $CALLER_KEY" -H 'content-type: application/json' \
    -H 'A2A-Version: 1.0' --data-binary "@${SCRIPT_DIR}/stream.json" "${base}/a2a/mock-a2a" 2>/dev/null || echo '')
  check "stream carried events" "$(printf '%s' "$stream" | grep -c '^data: ')" "6"
  check "stream opened with SUBMITTED" "$(printf '%s' "$stream" | grep -c 'TASK_STATE_SUBMITTED')" "1"
  check "stream carried WORKING progress" "$(printf '%s' "$stream" | grep -c 'TASK_STATE_WORKING')" "3"
  check "stream delivered the artifact" "$(printf '%s' "$stream" | grep -c 'artifactUpdate')" "1"
  check "stream ended COMPLETED" "$(printf '%s' "$stream" | grep -c 'TASK_STATE_COMPLETED')" "1"

  log "5. gateway observability saw the calls"
  metrics=$(curl -fsS -m 5 "http://127.0.0.1:${METRICS_PORT}/metrics" 2>/dev/null || echo '')
  check "requests counted per operation" "$(printf '%s' "$metrics" | grep -c 'aisix_a2a_requests_total{agent="mock-a2a"')" "2"
  check "stream events counted" "$(printf '%s' "$metrics" | grep -c 'aisix_a2a_stream_events_total{agent="mock-a2a"')" "1"
  check "task states counted" "$(printf '%s' "$metrics" | grep -c 'aisix_a2a_task_state_total{agent="mock-a2a"')" "1"

  log ""
  log "smoke: $passed passed, $failed failed"
  [ "$failed" -eq 0 ] || exit 1
}

case "${1:-}" in
  up) cmd_up ;;
  down) cmd_down ;;
  status) cmd_status ;;
  smoke) cmd_smoke ;;
  reload) cmd_reload ;;
  logs) cmd_logs ;;
  *) fail "usage: $0 {up|down|status|smoke|reload|logs}" ;;
esac
