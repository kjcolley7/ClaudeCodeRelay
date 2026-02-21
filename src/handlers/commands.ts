import { resetSession, getSessionId, activeSessionCount } from "../claude/session.js";
import { config } from "../config.js";

export interface CommandResult {
  handled: boolean;
  response?: string;
}

export function handleCommand(jid: string, text: string): CommandResult {
  const cmd = text.trim().toLowerCase();

  if (cmd === "/help") {
    return {
      handled: true,
      response: [
        "*ClaudeRelay Commands*",
        "/help — Show this message",
        "/status — Show session info",
        "/reset — Clear conversation history",
      ].join("\n"),
    };
  }

  if (cmd === "/status") {
    const sessionId = getSessionId(jid);
    return {
      handled: true,
      response: [
        "*Status*",
        `Session: ${sessionId ? sessionId.slice(0, 8) + "..." : "none"}`,
        `Active chats: ${activeSessionCount()}`,
        `Working dir: ${config.workingDirectory}`,
      ].join("\n"),
    };
  }

  if (cmd === "/reset") {
    resetSession(jid);
    return {
      handled: true,
      response: "Session cleared. Next message starts a fresh conversation.",
    };
  }

  return { handled: false };
}
