# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build and Run

```bash
npm run build          # Compile TypeScript (tsc)
npm run dev            # Hot-reload relay (tsx watch)
npm run dev:bridge     # Hot-reload bridge server (tsx watch)
```

Docker (primary deployment):
```bash
docker compose build
docker compose run relay
```

There are no tests or linting configured.

## Architecture

Two-process system: a **relay** (WhatsApp client) and a **bridge** (HTTP server that wraps the Claude Code CLI). In Docker these run as separate containers; locally the relay can spawn `claude` directly (when `CLAUDE_SERVICE_URL` is unset).

### Relay (src/index.ts)

Connects to WhatsApp via Baileys, listens for self-chat messages (`fromMe=true`), and routes them through the handler chain:

1. `/login`, `/status` — async handlers in `message.ts`
2. Auth code input — when `awaitingAuth` flag is set (`auth.ts`)
3. `/help`, `/reset` — synchronous handlers in `commands.ts`
4. Everything else — forwarded to Claude Code via `runClaude()`

Sent message IDs are tracked in a Set (5-minute TTL) to filter out echo from self-chat.

### Bridge (src/claude/bridge.ts)

HTTP server on port 3100 inside the claude container. Endpoints:

- `POST /invoke` — spawns `claude` CLI with `--output-format stream-json`, streams NDJSON back. Kills process on timeout or client disconnect.
- `GET /auth/status` — runs `claude auth status --json`
- `POST /auth/login` — generates PKCE challenge, returns OAuth URL
- `POST /auth/code` — exchanges auth code for tokens, fetches profile from platform API, writes credentials to `~/.claude/.credentials.json`
- `GET /health` — Docker healthcheck

### Session Management (src/claude/session.ts)

Per-chat state keyed by WhatsApp JID. Each entry holds a Claude session ID (for `--resume`), a promise-chain mutex (prevents concurrent Claude calls per chat), and cumulative token usage. Session IDs persist to `auth_info/sessions.json` across restarts.

### Message Splitting (src/utils/split.ts)

Splits long responses at natural boundaries (paragraph > line > sentence > word > hard cut), with a 30% minimum threshold to avoid tiny fragments. `repairCodeFences` tracks open triple-backtick fences across chunks, closing/reopening them at split boundaries.

## Key Patterns

- **Bridge vs. local mode**: `config.claudeServiceUrl` being non-empty selects remote (HTTP to bridge) vs. local (direct `claude` subprocess). `runner.ts` has parallel implementations for both paths.
- **Session error recovery**: `ClaudeSessionError` (detected by `/session\s*ID/i` in error text) triggers an automatic retry without `--resume` in `message.ts`.
- **Auth field normalization**: `claude auth status --json` returns `loggedIn`/`email`/`subscriptionType`, which `checkAuthStatus()` in `runner.ts` normalizes to `authenticated`/`account`/`plan`.
- **suppress-logs.ts** must be imported before Baileys to monkey-patch away noisy libsignal console output.
- ESM throughout — all local imports use `.js` extensions.

## Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `CLAUDE_SERVICE_URL` | `""` | Bridge URL; empty = local mode |
| `CLAUDE_TIMEOUT` | `300` | Max seconds per Claude invocation |
| `BRIDGE_PORT` | `3100` | Bridge HTTP port |
| `MAX_MESSAGE_LENGTH` | `4000` | Max chars per WhatsApp message chunk |
| `LOG_LEVEL` | `info` | Pino log level |
| `BAILEYS_LOG_LEVEL` | `error` | Baileys library log level |
| `CLAUDE_CONFIG_DIR` | `~/.claude` | Claude credentials directory (bridge) |
