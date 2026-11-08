#!/usr/bin/env bash
# End-to-end verification against the running local stack.
set -euo pipefail

cd "$(dirname "$0")/.."
set -a
# shellcheck disable=SC1091
source ./.env
set +a

API="http://localhost:${API_PORT}"
JAR=$(mktemp)

echo "== 1. sign in =="
curl -s -c "$JAR" -X POST "$API/api/auth/sign-in/email" \
  -H 'content-type: application/json' \
  -d "{\"email\":\"$SEED_USER_EMAIL\",\"password\":\"$SEED_USER_PASSWORD\"}" \
  | head -c 120
echo

echo "== 2. list workflows =="
WORKFLOW_ID=$(curl -s -b "$JAR" "$API/api/workflows" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["data"][0]["id"])')
echo "workflow: $WORKFLOW_ID"

echo "== 3. publish =="
PUBLISH=$(curl -s -b "$JAR" -X POST "$API/api/workflows/$WORKFLOW_ID/publish")
echo "$PUBLISH" | head -c 200; echo

SECRET=$(echo "$PUBLISH" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("webhookSecret") or "")')
if [ -z "$SECRET" ]; then
  echo "-- rotating the secret to obtain one for the demo"
  ROTATE=$(curl -s -b "$JAR" -X POST "$API/api/workflows/$WORKFLOW_ID/webhook/rotate")
  SECRET=$(echo "$ROTATE" | python3 -c 'import json,sys; print(json.load(sys.stdin)["secret"])')
fi
SLUG=$(curl -s -b "$JAR" "$API/api/workflows/$WORKFLOW_ID" | python3 -c 'import json,sys; print(json.load(sys.stdin)["webhookEndpoint"]["slug"])')
echo "slug: $SLUG"

KEY="verification-$(date +%s%N)"
echo "== 4. signed webhook =="
BODY='{"name":"Ada Lovelace","email":"ada@example.com","message":"Hello from the verification script"}'
TS=$(date +%s000)
SIG=$(printf '%s.%s' "$TS" "$BODY" | openssl dgst -sha256 -hmac "$SECRET" -hex | awk '{print $2}')
RESPONSE=$(curl -s -w '\n%{http_code}' -X POST "$API/webhooks/$SLUG" \
  -H 'content-type: application/json' \
  -H "idempotency-key: $KEY" \
  -H "x-s9-signature: t=$TS,v1=$SIG" \
  -d "$BODY")
echo "$RESPONSE"
EXECUTION_ID=$(echo "$RESPONSE" | head -1 | python3 -c 'import json,sys; print(json.load(sys.stdin)["executionId"])')

echo "== 5. duplicate delivery =="
curl -s -o /dev/null -w 'status %{http_code}\n' -X POST "$API/webhooks/$SLUG" \
  -H 'content-type: application/json' \
  -H "idempotency-key: $KEY" \
  -H "x-s9-signature: t=$TS,v1=$SIG" \
  -d "$BODY"

echo "== 6. bad signature =="
curl -s -o /dev/null -w 'status %{http_code}\n' -X POST "$API/webhooks/$SLUG" \
  -H 'content-type: application/json' \
  -H "idempotency-key: bad-$KEY" \
  -H "x-s9-signature: t=$TS,v1=$(printf '0%.0s' {1..64})" \
  -d "$BODY"

echo "== 7. wait for the worker =="
for i in $(seq 1 20); do
  STATUS=$(curl -s -b "$JAR" "$API/api/executions/$EXECUTION_ID" | python3 -c 'import json,sys; print(json.load(sys.stdin)["status"])')
  if [ "$STATUS" != "queued" ] && [ "$STATUS" != "running" ]; then break; fi
  sleep 1
done
echo "execution status: $STATUS"

echo "== 8. execution detail =="
curl -s -b "$JAR" "$API/api/executions/$EXECUTION_ID" > /tmp/opencode/execution.json
python3 - <<'PYEOF'
import json
with open('/tmp/opencode/execution.json') as handle:
    data = json.load(handle)
print("status:", data["status"], "| trigger:", data["triggerType"], "| duration:", data["durationMs"])
for step in data["steps"]:
    print("  %d. %-20s %-12s attempts=%d" % (step["stepIndex"] + 1, step["stepKey"], step["status"], step["attemptCount"]))
    if step.get("error"):
        print("      error:", step["error"]["class"], "-", step["error"]["message"])
PYEOF

echo "== 9. dashboard =="
curl -s -b "$JAR" "$API/api/dashboard" | python3 -c '
import json,sys
d = json.load(sys.stdin)
print("workflows:", d["workflows"])
print("executions:", {k:v for k,v in d["executions"].items() if k != "recentExecutions" and k != "needsAttention"})
'

rm -f "$JAR"
