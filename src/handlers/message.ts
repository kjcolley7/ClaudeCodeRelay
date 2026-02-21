import { WASocket } from "@whiskeysockets/baileys";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";
import { runClaude } from "../claude/runner.js";
import { getSessionId, setSessionId, withLock } from "../claude/session.js";
import { handleCommand } from "./commands.js";
import { splitMessage } from "../utils/split.js";

/** Extract the phone number from a JID like "14155551234@s.whatsapp.net" */
function jidToNumber(jid: string): string {
  return jid.replace(/@.*$/, "");
}

export async function handleMessage(
  jid: string,
  text: string,
  sock: WASocket
): Promise<void> {
  const number = jidToNumber(jid);

  // Whitelist check — silently ignore unauthorized senders
  if (!config.allowedNumbers.has(number)) {
    logger.debug({ jid, number }, "Ignoring message from non-allowed number");
    return;
  }

  logger.info({ jid, textLen: text.length }, "Received message");

  // Check for slash commands
  if (text.startsWith("/")) {
    const { handled, response } = handleCommand(jid, text);
    if (handled && response) {
      await sock.sendMessage(jid, { text: response });
      return;
    }
    if (handled) return;
  }

  // Queue through per-chat mutex
  await withLock(jid, async () => {
    // Show typing indicator
    await sock.presenceSubscribe(jid);
    await sock.sendPresenceUpdate("composing", jid);

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
      await sock.sendPresenceUpdate("paused", jid);

      // Send response (split if needed)
      if (!result.text) {
        await sock.sendMessage(jid, { text: "(Claude returned an empty response)" });
        return;
      }

      const chunks = splitMessage(result.text);
      for (const chunk of chunks) {
        await sock.sendMessage(jid, { text: chunk });
      }
    } catch (err) {
      clearInterval(typingInterval);
      await sock.sendPresenceUpdate("paused", jid);

      logger.error({ err, jid }, "Error running Claude");
      const errMsg =
        err instanceof Error ? err.message : "Unknown error";
      await sock.sendMessage(jid, {
        text: `Error: ${errMsg}`,
      });
    }
  });
}

function prompt(text: string): string {
  return text;
}
