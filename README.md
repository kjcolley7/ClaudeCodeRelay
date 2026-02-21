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
   | `WORKING_DIRECTORY` | CWD for Claude Code subprocess | *required* |
   | `MAX_MESSAGE_LENGTH` | Max chars per WhatsApp message before splitting | `4000` |
   | `CLAUDE_TIMEOUT` | Seconds before killing a Claude process | `300` |
   | `AUTH_DIR` | Directory for WhatsApp auth state | `./auth_info` |

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
