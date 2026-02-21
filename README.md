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

2. Start the relay:
   ```bash
   npm run dev    # development (tsx watch)
   npm run build && npm start  # production
   ```

3. Scan the QR code displayed in the terminal with WhatsApp on your phone (Linked Devices).

## Usage

Send a message to yourself (self-chat) from the linked WhatsApp account. The relay only processes messages with `fromMe=true`, so it responds to your own messages and ignores everything else.

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

1. Build the containers:
   ```bash
   docker compose build
   ```

2. Authenticate Claude Code (one-time):
   ```bash
   docker compose run claude claude auth login
   ```

3. Start the relay:
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
│ vol: auth_info   │   NDJSON lines  │ vol: /home/claude    │
└──────────────────┘                 └─────────────────────┘
```

- The relay container sends prompts via HTTP POST to the claude container's bridge server
- The bridge streams back NDJSON events (same format as `claude --output-format stream-json`)
- A single `claude_home` Docker volume is mounted at `/home/claude`, serving as both the home directory (for Claude Code credentials) and the workspace
