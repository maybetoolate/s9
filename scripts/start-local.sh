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

# RUNTIME=node runs the compiled output on Node.js; the default uses Bun
# against the TypeScript sources.
if [ "${RUNTIME:-bun}" = "node" ]; then
  runtime_bin=node
  server_dir=packages/server/dist
  server_ext=js
else
  runtime_bin=bun
  server_dir=packages/server/src
  server_ext=ts
fi

start() {
  local name="$1"
  local entry="$2"
  nohup "$runtime_bin" "$server_dir/$entry.$server_ext" > "/tmp/opencode/$name.log" 2>&1 &
  echo "$name pid $!"
}

start api main-api
sleep 2
start worker main-worker
sleep 2
start scheduler main-scheduler

sleep 6
echo "--- health ---"
curl -s "http://localhost:${API_PORT}/health/ready"
echo
