# Building and Running ClaudeClaw

**CRITICAL: Do NOT recreate or rewrite any source files.** The entire codebase is already complete: the Mission Control dashboard, all API routes, the bot, the agent system, and every CLI tool. Your job is to configure and compile, not to generate code.

## First-time setup (clone to working bot + dashboard)

```bash
# 1. Install dependencies
npm install

# 2. Run the interactive setup wizard
npm run setup
```

The setup wizard will:
- Validate that Node.js 20+ and Claude CLI are installed
- Ask for your Telegram bot token (get one from @BotFather)
- Auto-detect your Telegram chat ID
- Generate DASHBOARD_TOKEN, DB_ENCRYPTION_KEY, and SECURITY_PIN automatically
- Ask which optional features to enable (voice, video, War Room)
- Write everything to `.env`
- Build the project

```bash
# 3. If the wizard didn't build, or after any code change:
npm run build

# 4. Start the bot + dashboard
npm start
```

You should see these log lines confirming everything is running:
- `Telegram bot started`
- `Dashboard server running` (port 3141 by default)
- `Orchestrator initialized` (if multi-agent is configured)

## API keys the user may need

Ask the user for these when enabling the corresponding features. Do NOT skip or leave blank if the feature requires them.

| Key | Required for | Where to get it |
|-----|-------------|----------------|
| `TELEGRAM_BOT_TOKEN` | Core (always required) | @BotFather on Telegram |
| `GOOGLE_API_KEY` | Video analysis, memory consolidation, auto-assign tasks, War Room | [aistudio.google.com](https://aistudio.google.com) (free) |
| `GROQ_API_KEY` | Voice input (transcription) | [console.groq.com](https://console.groq.com) (free tier) |
| `ELEVENLABS_API_KEY` | Voice output (TTS) | [elevenlabs.io](https://elevenlabs.io) |
| `ANTHROPIC_API_KEY` | Pay-per-token billing (optional, uses `claude login` by default) | [console.anthropic.com](https://console.anthropic.com) |
| `SLACK_USER_TOKEN` | Slack integration | Slack app OAuth page (starts with `xoxp-`) |

## What NOT to do

- **Do NOT rewrite `src/dashboard-html.ts` or `src/dashboard.ts`.** The Mission Control dashboard is fully built with all panels, charts, modals, and interactive features. It renders as an inline HTML string with Tailwind CSS and Chart.js.
- **Do NOT create new HTML files.** The dashboard is self-contained in TypeScript.
- **Do NOT skip `npm run build`.** The bot runs compiled JS from `dist/`, not source from `src/`.
- **Do NOT hardcode tokens, paths, or personal data.** Everything comes from `.env`.
- **Do NOT run `find` to locate project files.** The project root is always available as `$CLAUDECLAW_PROJECT_ROOT`.

## Rebuilding after changes

```bash
npm run build && npm start
```

## Verifying the dashboard works

```bash
# Should return 200 if the token is correct
curl -s -o /dev/null -w "%{http_code}" "http://localhost:3141/?token=YOUR_TOKEN&chatId=YOUR_CHAT_ID"
```

Or send `/dashboard` to the bot in Telegram for a clickable link.
