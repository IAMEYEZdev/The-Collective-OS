#!/usr/bin/env bash
# scripts/claw-code-docker.sh
# Start/stop/status for claw-code RAG sidecar
set -euo pipefail

COMPOSE_FILE="${CLAUDECLAW_PROJECT_ROOT:-$(dirname "$0")/..}/docker/claw-code-compose.yml"

case "${1:-help}" in
  start)
    docker compose -f "$COMPOSE_FILE" up -d
    echo "RAG sidecar started. Health: http://localhost:8787/health"
    ;;
  stop)
    docker compose -f "$COMPOSE_FILE" down
    echo "RAG sidecar stopped."
    ;;
  status)
    docker compose -f "$COMPOSE_FILE" ps
    curl -sf http://localhost:8787/health && echo " -- RAG healthy" || echo " -- RAG unreachable"
    ;;
  ingest)
    curl -sf -X POST http://localhost:8787/v1/ingest \
      -H 'Content-Type: application/json' \
      -d '{"workspaces":["/workspaces/claudeclaw","/workspaces/forks"]}'
    echo "Ingest triggered."
    ;;
  *)
    echo "Usage: $0 {start|stop|status|ingest}"
    exit 1
    ;;
esac
