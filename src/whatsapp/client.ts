import "../utils/suppress-logs.js";
import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  WASocket,
  WAMessage,
  proto,
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import pino from "pino";
import qrcode from "qrcode-terminal";
import fs from "fs/promises";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";

// Create a Baileys logger that writes directly to stderr (synchronous, no buffering)
const baileysLogLevel = process.env.BAILEYS_LOG_LEVEL ?? "error";
const waLogger = pino({ level: baileysLogLevel }, pino.destination(2));

export type MessageHandler = (
  jid: string,
  text: string,
  sock: WASocket,
  msg: WAMessage
) => Promise<void>;

let sock: WASocket | null = null;
let messageHandler: MessageHandler | null = null;

/** Exponential backoff state for reconnection */
let reconnectDelay = 1000; // start at 1s
const MAX_RECONNECT_DELAY = 60_000; // cap at 60s

/** Track consecutive logouts to handle pairing failures gracefully */
let logoutRetryCount = 0;
const MAX_LOGOUT_RETRIES = 3;
let stabilityTimer: ReturnType<typeof setTimeout> | null = null;
const CONNECTION_STABILITY_MS = 30_000; // 30s = connection is "stable"

/** Connection health tracking */
let lastConnectedAt = 0;
let connectionOpen = false;
/** Debounce window: connection must be down this long before reporting unhealthy */
const HEALTH_DEBOUNCE_MS = 120_000; // 2 minutes

/** Track message IDs sent by the relay so we can ignore our own messages in self-chats */
const sentMessageIds = new Set<string>();

export function onMessage(handler: MessageHandler): void {
  messageHandler = handler;
}

export function getSocket(): WASocket | null {
  return sock;
}

export interface HealthStatus {
  healthy: boolean;
  connected: boolean;
  lastConnectedAt: number;
  disconnectedForMs: number | null;
}

/**
 * Returns relay health status with debouncing.
 * Healthy if: connected, OR disconnected for less than the debounce window,
 * OR never connected yet (still starting up).
 */
export function getHealthStatus(): HealthStatus {
  const now = Date.now();
  const disconnectedForMs = connectionOpen ? null : (lastConnectedAt > 0 ? now - lastConnectedAt : null);
  const healthy = connectionOpen
    || lastConnectedAt === 0  // still starting up, not unhealthy yet
    || (disconnectedForMs !== null && disconnectedForMs < HEALTH_DEBOUNCE_MS);
  return { healthy, connected: connectionOpen, lastConnectedAt, disconnectedForMs };
}

/**
 * Record a message ID as sent by the relay.
 * Call this after every sock.sendMessage() to prevent echo loops in self-chats.
 */
export function trackSentMessage(id: string): void {
  sentMessageIds.add(id);
  // Clean up after 5 minutes to prevent unbounded growth
  setTimeout(() => sentMessageIds.delete(id), 5 * 60 * 1000);
}

export async function startWhatsApp(): Promise<WASocket> {
  // Clean up old socket to prevent listener/memory leaks on reconnect
  if (sock) {
    sock.ev.removeAllListeners("creds.update");
    sock.ev.removeAllListeners("connection.update");
    sock.ev.removeAllListeners("messages.upsert");
    sock.end(new Error("Reconnecting"));
    sock = null;
  }

  const { state, saveCreds } = await useMultiFileAuthState(config.authDir);

  sock = makeWASocket({
    logger: waLogger,
    auth: state,
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      logger.info("Scan this QR code with WhatsApp:");
      qrcode.generate(qr, { small: true });
    }

    if (connection === "close") {
      connectionOpen = false;
      if (stabilityTimer) {
        clearTimeout(stabilityTimer);
        stabilityTimer = null;
      }

      const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;

      if (statusCode === DisconnectReason.loggedOut) {
        logoutRetryCount++;
        if (logoutRetryCount > MAX_LOGOUT_RETRIES) {
          logger.fatal(
            "Logged out after %d retries. Delete auth_info directory and restart to re-link.",
            MAX_LOGOUT_RETRIES,
          );
          process.exit(1);
        }
        logger.warn(
          { attempt: logoutRetryCount, maxRetries: MAX_LOGOUT_RETRIES },
          "Logged out (possible pairing failure). Clearing auth state and retrying...",
        );
        try {
          const entries = await fs.readdir(config.authDir);
          await Promise.all(
            entries.map((e) =>
              fs.rm(`${config.authDir}/${e}`, { recursive: true, force: true }),
            ),
          );
        } catch (err) {
          logger.error({ err }, "Failed to clear auth state");
        }
      }

      logger.warn({ statusCode, reconnectDelay }, "Connection closed, reconnecting...");
      const delay = reconnectDelay;
      reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
      setTimeout(() => startWhatsApp(), delay);
    }

    if (connection === "open") {
      connectionOpen = true;
      lastConnectedAt = Date.now();
      reconnectDelay = 1000; // reset backoff on successful connection
      logger.info("WhatsApp connection established");
      // Once connection is stable for 30s, reset the logout retry counter
      if (stabilityTimer) clearTimeout(stabilityTimer);
      stabilityTimer = setTimeout(() => {
        logoutRetryCount = 0;
        stabilityTimer = null;
      }, CONNECTION_STABILITY_MS);
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;

    for (const msg of messages) {
      const jid = msg.key.remoteJid;
      if (!msg.message) continue;
      if (!jid) continue;

      // Only process messages from ourselves (self-chat)
      if (!msg.key.fromMe) continue;

      // Skip messages sent by the relay (prevents echo loops)
      if (msg.key.id && sentMessageIds.has(msg.key.id)) {
        continue;
      }

      const text = extractText(msg.message);
      if (!text) continue;

      if (messageHandler) {
        try {
          await messageHandler(jid, text, sock!, msg as WAMessage);
        } catch (err) {
          logger.error({ err, jid }, "Error in message handler");
        }
      }
    }
  });

  return sock;
}

function extractText(
  message: proto.IMessage
): string | null | undefined {
  return (
    message.conversation ||
    message.extendedTextMessage?.text ||
    message.ephemeralMessage?.message?.conversation ||
    message.ephemeralMessage?.message?.extendedTextMessage?.text ||
    message.viewOnceMessage?.message?.conversation ||
    message.viewOnceMessage?.message?.extendedTextMessage?.text
  );
}
