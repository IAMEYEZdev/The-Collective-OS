# CLI Reference

## Scheduling Tasks

Create scheduled tasks using the Bash tool. The env var `$CLAUDECLAW_PROJECT_ROOT` gives the absolute path. **Never use `find` to locate schedule-cli.js.**

```bash
PROJECT_ROOT="$CLAUDECLAW_PROJECT_ROOT"
node "$PROJECT_ROOT/dist/schedule-cli.js" create "PROMPT" "CRON"
node "$PROJECT_ROOT/dist/schedule-cli.js" list
node "$PROJECT_ROOT/dist/schedule-cli.js" delete <id>
node "$PROJECT_ROOT/dist/schedule-cli.js" pause <id>
node "$PROJECT_ROOT/dist/schedule-cli.js" resume <id>
```

**Agent routing:** The schedule-cli auto-detects which agent you are via the `CLAUDECLAW_AGENT_ID` environment variable. Tasks you create will automatically be assigned to your agent. If you need to override, use `--agent <id>`.

Common cron patterns:
- Daily at 9am: `0 9 * * *`
- Every Monday at 9am: `0 9 * * 1`
- Every weekday at 8am: `0 8 * * 1-5`
- Every Sunday at 6pm: `0 18 * * 0`
- Every 4 hours: `0 */4 * * *`

## Mission Tasks (Delegating to Other Agents)

Mission tasks are async: you queue them and the target agent picks them up within 60 seconds.

```bash
PROJECT_ROOT="$CLAUDECLAW_PROJECT_ROOT"
node "$PROJECT_ROOT/dist/mission-cli.js" create --agent research --title "Short label" "Full detailed prompt"
node "$PROJECT_ROOT/dist/mission-cli.js" list
node "$PROJECT_ROOT/dist/mission-cli.js" result <task-id>
node "$PROJECT_ROOT/dist/mission-cli.js" cancel <task-id>
```

Available agents: main, research, comms, content, ops. Use `--priority 10` for high priority, `--priority 0` for low (default is 5).

## Sending Files via Telegram

Include file markers in your response. The bot parses them and sends as Telegram attachments.

- `[SEND_FILE:/absolute/path/to/file.pdf]` — document attachment
- `[SEND_PHOTO:/absolute/path/to/image.png]` — inline photo
- `[SEND_FILE:/absolute/path/to/file.pdf|Optional caption]` — with caption

Rules: absolute paths only, create file first, markers on own line, max 50MB.
