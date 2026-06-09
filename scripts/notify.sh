#!/bin/bash
# Send a Telegram message or file mid-task.
# Usage: notify.sh "message text"
#        notify.sh --file /path/to/file.pdf "optional caption"
# Reads TELEGRAM_BOT_TOKEN and ALLOWED_CHAT_ID from .env in the project root.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$SCRIPT_DIR/../.env"

if [ ! -f "$ENV_FILE" ]; then
  echo "notify.sh: .env not found at $ENV_FILE" >&2
  exit 1
fi

TOKEN=$(grep -E '^TELEGRAM_BOT_TOKEN=' "$ENV_FILE" | cut -d'=' -f2- | tr -d '"' | tr -d "'")
CHAT_ID=$(grep -E '^ALLOWED_CHAT_ID=' "$ENV_FILE" | cut -d'=' -f2- | tr -d '"' | tr -d "'")

if [ -z "$TOKEN" ] || [ -z "$CHAT_ID" ]; then
  echo "notify.sh: TELEGRAM_BOT_TOKEN or ALLOWED_CHAT_ID not set in .env" >&2
  exit 1
fi

# File send mode
if [ "$1" = "--file" ]; then
  FILE_PATH="$2"
  CAPTION="${3:-}"

  if [ ! -f "$FILE_PATH" ]; then
    echo "notify.sh: file not found: $FILE_PATH" >&2
    exit 1
  fi

  if [ -n "$CAPTION" ]; then
    # Escape HTML entities in caption
    CAPTION=$(echo "$CAPTION" | sed 's/&/\&amp;/g; s/</\&lt;/g; s/>/\&gt;/g')
    curl -s -X POST "https://api.telegram.org/bot${TOKEN}/sendDocument" \
      -F chat_id="${CHAT_ID}" \
      -F document=@"${FILE_PATH}" \
      -F caption="${CAPTION}" \
      -F parse_mode="HTML" > /dev/null
  else
    curl -s -X POST "https://api.telegram.org/bot${TOKEN}/sendDocument" \
      -F chat_id="${CHAT_ID}" \
      -F document=@"${FILE_PATH}" > /dev/null
  fi
else
  # Text message mode — pipe through brand voice gate (same TS gate as bot.ts)
  GATE="$SCRIPT_DIR/../dist/brand-voice-gate.js"
  if [ -f "$GATE" ]; then
    # Determine calling agent from AGENT_ID env var or default to "notify"
    AGENT_NAME="${AGENT_ID:-notify}"
    CLEANED=$(echo "${1}" | node "$GATE" --agent "$AGENT_NAME" 2>/dev/null)
    if [ $? -eq 0 ] && [ -n "$CLEANED" ]; then
      MSG="$CLEANED"
    else
      MSG="${1}"
    fi
  else
    MSG="${1}"
  fi

  # Escape HTML entities to prevent Telegram parser rejection
  MSG=$(echo "$MSG" | sed 's/&/\&amp;/g; s/</\&lt;/g; s/>/\&gt;/g')

  curl -s -X POST "https://api.telegram.org/bot${TOKEN}/sendMessage" \
    -d chat_id="${CHAT_ID}" \
    -d text="${MSG}" \
    -d parse_mode="HTML" > /dev/null
fi
