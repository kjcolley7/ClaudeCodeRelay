import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";

const SESSIONS_FILE = join(config.authDir, "sessions.json");

export interface SessionUsage {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

interface ChatSession {
  sessionId?: string;
  mutex: Promise<void>;
  usage: SessionUsage;
}

const sessions = new Map<string, ChatSession>();

/** Load persisted session IDs from disk on startup */
function loadSessions(): void {
  try {
    const data = JSON.parse(readFileSync(SESSIONS_FILE, "utf-8"));
    for (const [jid, sessionId] of Object.entries(data)) {
      if (typeof sessionId === "string") {
        getOrCreate(jid).sessionId = sessionId;
      }
    }
    logger.info({ count: Object.keys(data).length }, "Restored sessions from disk");
  } catch {
    // File doesn't exist or is invalid — start fresh
  }
}

/** Persist session IDs to disk */
function saveSessions(): void {
  const data: Record<string, string> = {};
  for (const [jid, session] of sessions) {
    if (session.sessionId) {
      data[jid] = session.sessionId;
    }
  }
  try {
    writeFileSync(SESSIONS_FILE, JSON.stringify(data), "utf-8");
  } catch (err) {
    logger.error({ err }, "Failed to persist sessions");
  }
}

loadSessions();

function getOrCreate(jid: string): ChatSession {
  let session = sessions.get(jid);
  if (!session) {
    session = { mutex: Promise.resolve(), usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 } };
    sessions.set(jid, session);
  }
  return session;
}

export function getSessionId(jid: string): string | undefined {
  return sessions.get(jid)?.sessionId;
}

export function setSessionId(jid: string, sessionId: string): void {
  getOrCreate(jid).sessionId = sessionId;
  saveSessions();
}

export function resetSession(jid: string): void {
  sessions.delete(jid);
  saveSessions();
}

export function activeSessionCount(): number {
  return sessions.size;
}

export function addUsage(jid: string, input: number, output: number, cost: number): void {
  const session = getOrCreate(jid);
  session.usage.inputTokens += input;
  session.usage.outputTokens += output;
  session.usage.costUsd += cost;
}

export function getUsage(jid: string): SessionUsage {
  return getOrCreate(jid).usage;
}

/**
 * Per-chat mutex. Prevents concurrent Claude invocations on the same session.
 * Messages queue per-chat, but different chats run in parallel.
 */
export async function withLock<T>(
  jid: string,
  fn: () => Promise<T>
): Promise<T> {
  const session = getOrCreate(jid);

  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  const prev = session.mutex;
  session.mutex = gate;

  await prev;
  try {
    return await fn();
  } finally {
    release();
  }
}
