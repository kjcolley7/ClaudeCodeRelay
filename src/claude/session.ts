interface ChatSession {
  sessionId?: string;
  mutex: Promise<void>;
}

const sessions = new Map<string, ChatSession>();

function getOrCreate(jid: string): ChatSession {
  let session = sessions.get(jid);
  if (!session) {
    session = { mutex: Promise.resolve() };
    sessions.set(jid, session);
  }
  return session;
}

export function getSessionId(jid: string): string | undefined {
  return sessions.get(jid)?.sessionId;
}

export function setSessionId(jid: string, sessionId: string): void {
  getOrCreate(jid).sessionId = sessionId;
}

export function resetSession(jid: string): void {
  sessions.delete(jid);
}

export function activeSessionCount(): number {
  return sessions.size;
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
