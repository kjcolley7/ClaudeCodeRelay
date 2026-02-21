import { WASocket, WAMessage } from "@whiskeysockets/baileys";
import { logger } from "../utils/logger.js";
import { runClaude } from "../claude/runner.js";
import { getSessionId, setSessionId, withLock } from "../claude/session.js";
import { handleCommand } from "./commands.js";
import { splitMessage } from "../utils/split.js";
import { trackSentMessage } from "../whatsapp/client.js";
import { isAwaitingAuth, handleAuthCode, initiateAuth } from "./auth.js";

/** Send a text message and track its ID so we don't process our own messages */
async function sendText(
  sock: WASocket,
  jid: string,
  text: string,
  quoted?: WAMessage
): Promise<void> {
  const sent = await sock.sendMessage(jid, { text }, { quoted });
  if (sent?.key.id) {
    trackSentMessage(sent.key.id);
  }
}

export async function handleMessage(
  jid: string,
  text: string,
  sock: WASocket,
  msg: WAMessage
): Promise<void> {
  logger.info({ jid, text: text.slice(0, 200) }, "Received message");

  // Handle /login command
  if (text.trim().toLowerCase() === "/login") {
    await initiateAuth(sock, jid);
    return;
  }

  // If awaiting auth code, treat message as the code
  if (isAwaitingAuth()) {
    await handleAuthCode(text, sock, jid);
    return;
  }

  // Check for slash commands
  if (text.startsWith("/")) {
    const { handled, response } = handleCommand(jid, text);
    if (handled && response) {
      await sendText(sock, jid, response, msg);
      return;
    }
    if (handled) return;
  }

  // Queue through per-chat mutex
  await withLock(jid, async () => {
    // Show typing indicator
    try {
      await sock.presenceSubscribe(jid);
      await sock.sendPresenceUpdate("composing", jid);
    } catch {
      // Ignore presence errors (e.g. self-chat)
    }

    // Refresh typing indicator every 8 seconds
    const typingInterval = setInterval(async () => {
      try {
        await sock.sendPresenceUpdate("composing", jid);
      } catch {
        // Ignore errors refreshing typing
      }
    }, 8000);

    try {
      const sessionId = getSessionId(jid);
      const result = await runClaude(prompt(text), sessionId, () => {
        // onActivity callback — typing indicator already handled by interval
      });

      // Save session for continuity
      if (result.sessionId) {
        setSessionId(jid, result.sessionId);
      }

      // Clear typing
      clearInterval(typingInterval);
      try {
        await sock.sendPresenceUpdate("paused", jid);
      } catch {
        // Ignore presence errors
      }

      // Send response (split if needed)
      if (!result.text) {
        await sendText(sock, jid, "(Claude returned an empty response)", msg);
        return;
      }

      const chunks = splitMessage(result.text);
      // Quote the original message on the first chunk only
      for (let i = 0; i < chunks.length; i++) {
        await sendText(sock, jid, chunks[i], i === 0 ? msg : undefined);
      }
    } catch (err) {
      clearInterval(typingInterval);
      try {
        await sock.sendPresenceUpdate("paused", jid);
      } catch {
        // Ignore presence errors
      }

      logger.error({ err, jid }, "Error running Claude");
      const errMsg =
        err instanceof Error ? err.message : "Unknown error";
      await sendText(sock, jid, `Error: ${errMsg}`, msg);
    }
  });
}

function prompt(text: string): string {
  return text;
}
