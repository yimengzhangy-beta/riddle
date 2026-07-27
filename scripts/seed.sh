#!/usr/bin/env bash
#
# Seeds the riddle bank to TARGET riddles per difficulty via POST /admin/generate.
#
#   ./scripts/seed.sh <ApiUrl> <admin-email> <admin-password>
#
# The admin user must already be in the Cognito `admins` group (README §3), and must
# have logged in *after* being added — group membership is baked into the token.
#
# Generation runs in batches of BATCH so each call stays inside API Gateway's
# 30-second integration timeout. The script re-reads the reported bank size after
# every batch, so re-running it top-ups rather than duplicating: the API dedupes on
# normalised answer+topic, and a batch that lands only partially is simply topped up
# on the next pass.

set -euo pipefail

API="${1:?usage: seed.sh <ApiUrl> <admin-email> <admin-password>}"
EMAIL="${2:?usage: seed.sh <ApiUrl> <admin-email> <admin-password>}"
PASSWORD="${3:?usage: seed.sh <ApiUrl> <admin-email> <admin-password>}"

TARGET="${TARGET:-10}"
BATCH="${BATCH:-5}"
MAX_ROUNDS="${MAX_ROUNDS:-6}"

API="${API%/}"

json_field() { python3 -c 'import sys,json; print(json.load(sys.stdin).get(sys.argv[1],""))' "$1"; }

echo "Logging in as $EMAIL..."
TOKEN=$(curl -sS -X POST "$API/login" \
  -H 'Content-Type: application/json' \
  -d "$(python3 -c 'import json,sys; print(json.dumps({"email":sys.argv[1],"password":sys.argv[2]}))' "$EMAIL" "$PASSWORD")" \
  | json_field idToken)

if [ -z "$TOKEN" ]; then
  echo "Login failed — check the email and password." >&2
  exit 1
fi

for DIFFICULTY in easy medium hard; do
  echo
  echo "=== $DIFFICULTY (target $TARGET) ==="
  round=0

  while [ "$round" -lt "$MAX_ROUNDS" ]; do
    round=$((round + 1))

    response=$(curl -sS -X POST "$API/admin/generate" \
      -H "Authorization: Bearer $TOKEN" \
      -H 'Content-Type: application/json' \
      -d "{\"count\":$BATCH,\"difficulty\":\"$DIFFICULTY\"}")

    written=$(printf '%s' "$response" | json_field written)
    duplicates=$(printf '%s' "$response" | json_field duplicates)
    size=$(printf '%s' "$response" | json_field bankSize)

    if [ -z "$size" ]; then
      echo "  batch $round failed: $response" >&2
      exit 1
    fi

    echo "  batch $round: +$written written, $duplicates duplicate(s), bank now $size"

    [ "$size" -ge "$TARGET" ] && break

    if [ "$written" -eq 0 ]; then
      echo "  batch produced nothing new — stopping to avoid burning tokens." >&2
      break
    fi
  done
done

echo
echo "Done."
