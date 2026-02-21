import { WASocket } from "@whiskeysockets/baileys";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";
import { runClaude } from "../claude/runner.js";
import { getSessionId, setSessionId, withLock } from "../claude/session.js";
import { handleCommand } from "./commands.js";
import { splitMessage } from "../utils/split.js";
import { trackSentMessage, resolveJidToNumber } from "../whatsapp/client.js";

/** Send a text message and track its ID so we don't process our own messages */
async function sendText(sock: WASocket, jid: string, text: string): Promise<void> {
  const sent = await sock.sendMessage(jid, { text });
  if (sent?.key.id) {
    trackSentMessage(sent.key.id);
  }
}

export async function handleMessage(
  jid: string,
  text: string,
  sock: WASocket
): Promise<void> {
  const number = resolveJidToNumber(jid);

  // Whitelist check — silently ignore unauthorized senders
  if (!number || !config.allowedNumbers.has(number)) {
    logger.debug({ jid, number }, "Ignoring message from non-allowed number");
    return;
  }

  logger.info({ jid, textLen: text.length }, "Received message");

  // Check for slash commands
  if (text.startsWith("/")) {
    const { handled, response } = handleCommand(jid, text);
    if (handled && response) {
      await sendText(sock, jid, response);
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
        await sendText(sock, jid, "(Claude returned an empty response)");
        return;
      }

      const chunks = splitMessage(result.text);
      for (const chunk of chunks) {
        await sendText(sock, jid, chunk);
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
      await sendText(sock, jid, `Error: ${errMsg}`);
    }
  });
}

function prompt(text: string): string {
  return text;
}
