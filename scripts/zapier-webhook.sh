#!/bin/bash
# Send data to a Zapier webhook.
# Usage: zapier-webhook.sh <webhook_url> <json_payload>
#
# Example:
#   zapier-webhook.sh "https://hooks.zapier.com/hooks/catch/123/abc" \
#     '{"event":"demo_ready","prospect":"Steve","url":"cooperbuilthomes.com"}'
#
# Agents can call this to push events to Zapier, which then
# triggers downstream automations (GHL pipeline updates, emails, etc.)

WEBHOOK_URL="$1"
PAYLOAD="$2"

if [ -z "$WEBHOOK_URL" ] || [ -z "$PAYLOAD" ]; then
  echo "Usage: zapier-webhook.sh <webhook_url> <json_payload>" >&2
  exit 1
fi

RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "$WEBHOOK_URL" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD")

HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY=$(echo "$RESPONSE" | sed '$d')

if [ "$HTTP_CODE" -ge 200 ] && [ "$HTTP_CODE" -lt 300 ]; then
  echo "Zapier webhook sent (HTTP $HTTP_CODE)"
else
  echo "Zapier webhook failed (HTTP $HTTP_CODE): $BODY" >&2
  exit 1
fi
