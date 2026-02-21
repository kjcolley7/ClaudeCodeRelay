import { WASocket, WAMessage } from "@whiskeysockets/baileys";
import { logger } from "../utils/logger.js";
import { runClaude, ClaudeSessionError, checkAuthStatus } from "../claude/runner.js";
import { getSessionId, setSessionId, resetSession, addUsage, getUsage, withLock } from "../claude/session.js";
import { handleCommand } from "./commands.js";
import { splitMessage } from "../utils/split.js";
import { trackSentMessage } from "../whatsapp/client.js";
import { isAwaitingAuth, handleAuthCode, initiateAuth } from "./auth.js";
import { config } from "../config.js";

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

  // Handle /status command (async — needs bridge call)
  if (text.trim().toLowerCase() === "/status") {
    await handleStatus(jid, sock, msg);
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
      let sessionId = getSessionId(jid);
      let result;
      try {
        result = await runClaude(prompt(text), sessionId, () => {
          // onActivity callback — typing indicator already handled by interval
        });
      } catch (err) {
        if (err instanceof ClaudeSessionError && sessionId) {
          // Session no longer exists — reset and retry without resume
          logger.warn({ jid, sessionId }, "Session not found, starting fresh");
          resetSession(jid);
          result = await runClaude(prompt(text), undefined, () => {});
        } else {
          throw err;
        }
      }

      // Save session for continuity
      if (result.sessionId) {
        setSessionId(jid, result.sessionId);
      }

      // Track token usage
      if (result.usage) {
        addUsage(jid, result.usage.inputTokens, result.usage.outputTokens, result.usage.costUsd);
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

async function handleStatus(
  jid: string,
  sock: WASocket,
  msg: WAMessage
): Promise<void> {
  const lines: string[] = ["*Status*"];

  // Session info
  const sessionId = getSessionId(jid);
  lines.push(`Session: ${sessionId ?? "none"}`);

  // Usage for this session
  const usage = getUsage(jid);
  if (usage.inputTokens > 0 || usage.outputTokens > 0) {
    lines.push(
      `Tokens: ${usage.inputTokens.toLocaleString()} in / ${usage.outputTokens.toLocaleString()} out`
    );
    if (usage.costUsd > 0) {
      lines.push(`Cost: $${usage.costUsd.toFixed(4)}`);
    }
  }

  lines.push(`Working dir: ${config.workingDirectory}`);

  // Auth status from bridge
  if (config.claudeServiceUrl) {
    try {
      const auth = await checkAuthStatus();
      if (auth.authenticated) {
        const account = auth.account ?? "unknown";
        const plan = auth.plan ?? "unknown";
        lines.push(`Account: ${account}`);
        lines.push(`Plan: ${plan}`);
      } else {
        lines.push("Auth: not logged in");
      }
    } catch {
      lines.push("Auth: unavailable");
    }
  }

  await sendText(sock, jid, lines.join("\n"), msg);
}

function prompt(text: string): string {
  return text;
}
