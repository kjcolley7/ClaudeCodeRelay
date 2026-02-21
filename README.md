# ClaudeCodeRelay

Relay WhatsApp messages to a Claude Code CLI instance. Designed for interacting with Claude Code from airplane "free texting" wifi, where WhatsApp works but full internet doesn't.

## Architecture

```
Phone (airplane wifi) → WhatsApp → WhatsApp Servers →
  Server → Baileys → Message Handler →
    Claude Code CLI subprocess →
      Response → Baileys → WhatsApp → Phone
```

## Setup

1. Install dependencies:
   ```bash
   npm install
   ```

2. Copy `.env.example` to `.env` and configure:
   ```bash
   cp .env.example .env
   ```

   | Variable | Description | Default |
   |----------|-------------|---------|
   | `ALLOWED_NUMBERS` | Comma-separated E.164 phone numbers (without `+`) | *required* |
   | `MAX_MESSAGE_LENGTH` | Max chars per WhatsApp message before splitting | `4000` |
   | `CLAUDE_TIMEOUT` | Seconds before killing a Claude process | `300` |

3. Start the relay:
   ```bash
   npm run dev    # development (tsx watch)
   npm run build && npm start  # production
   ```

4. Scan the QR code displayed in the terminal with WhatsApp on your phone (Linked Devices).

## Usage

Send a message from a whitelisted number to the linked WhatsApp account. The message is forwarded to Claude Code and the response is sent back.

### Commands

- `/help` — Show available commands
- `/status` — Show current session info
- `/reset` — Clear conversation history and start fresh

### Features

- **Conversation continuity** — Messages within a chat maintain context via Claude Code session IDs
- **Per-chat concurrency control** — Messages queue per-chat to prevent session corruption; different chats run in parallel
- **Auto-reconnection** — Reconnects automatically on disconnect (re-scan QR if logged out)
- **Message splitting** — Long responses split at paragraph/line/sentence boundaries with code fence repair
- **Typing indicators** — Shows "composing" while Claude is working

## Docker

A two-container setup is available via Docker Compose:

- **relay** — WhatsApp/Baileys relay (Node.js)
- **claude** — HTTP bridge server that spawns the Claude Code CLI

### Quick start

1. Copy `.env.example` to `.env` and set `ALLOWED_NUMBERS`:
   ```bash
   cp .env.example .env
   ```

2. Build the containers:
   ```bash
   docker compose build
   ```

3. Authenticate Claude Code (one-time):
   ```bash
   docker compose run claude claude login
   ```

4. Start the relay:
   ```bash
   docker compose run relay
   ```
   Scan the QR code with WhatsApp, then messages will flow through.

### Architecture

```
relay container                      claude container
┌──────────────────┐   HTTP stream   ┌─────────────────────┐
│ WhatsApp/Baileys │───────────────►│ bridge server :3100  │
│ runner.ts        │◄───────────────│ spawns `claude` CLI  │
│ vol: auth_info   │   NDJSON lines  │ vol: /workspace      │
└──────────────────┘                 └─────────────────────┘
```

- The relay container sends prompts via HTTP POST to the claude container's bridge server
- The bridge streams back NDJSON events (same format as `claude --output-format stream-json`)
- Claude Code credentials persist in a `claude_home` Docker volume
- The working directory is bind-mounted at `/workspace` in the claude container
