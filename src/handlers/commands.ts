import { resetSession } from "../claude/session.js";

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
        "*ClaudeCodeRelay Commands*",
        "/help — Show this message",
        "/status — Show session and auth info",
        "/reset — Clear conversation history",
        "/login — Authenticate Claude Code",
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
