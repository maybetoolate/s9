#!/usr/bin/env bash
# Starts the API, worker and scheduler against the local .env for a manual
# verification run. Logs go to /tmp/opencode.
set -euo pipefail

cd "$(dirname "$0")/.."
set -a
# shellcheck disable=SC1091
source ./.env
set +a

mkdir -p /tmp/opencode

start() {
  local name="$1"
  local entry="$2"
  nohup npx tsx --tsconfig tsconfig.json "packages/server/src/$entry" > "/tmp/opencode/$name.log" 2>&1 &
  echo "$name pid $!"
}

start api main-api.ts
sleep 2
start worker main-worker.ts
sleep 2
start scheduler main-scheduler.ts

sleep 6
echo "--- health ---"
curl -s "http://localhost:${API_PORT}/health/ready"
echo
