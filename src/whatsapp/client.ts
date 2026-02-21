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
import { config } from "../config.js";
import { logger } from "../utils/logger.js";

// Create a Baileys logger that writes directly to stderr (synchronous, no buffering)
const baileysLogLevel = process.env.BAILEYS_LOG_LEVEL ?? "error";
const waLogger = pino({ level: baileysLogLevel }, pino.destination(2));

// Baileys' signal protocol code uses raw console.log to dump session data, which is
// extremely verbose. Redirect console.log through our structured logger at debug level.
const origConsoleLog = console.log.bind(console);
console.log = (...args: unknown[]) => {
  const first = typeof args[0] === "string" ? args[0] : "";
  if (first.startsWith("Closing session")) return;
  origConsoleLog(...args);
};

export type MessageHandler = (
  jid: string,
  text: string,
  sock: WASocket,
  msg: WAMessage
) => Promise<void>;

let sock: WASocket | null = null;
let messageHandler: MessageHandler | null = null;

/** Track message IDs sent by the relay so we can ignore our own messages in self-chats */
const sentMessageIds = new Set<string>();

export function onMessage(handler: MessageHandler): void {
  messageHandler = handler;
}

export function getSocket(): WASocket | null {
  return sock;
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
  const { state, saveCreds } = await useMultiFileAuthState(config.authDir);

  sock = makeWASocket({
    logger: waLogger,
    auth: state,
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      logger.info("Scan this QR code with WhatsApp:");
      qrcode.generate(qr, { small: true });
    }

    if (connection === "close") {
      const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
      if (statusCode === DisconnectReason.loggedOut) {
        logger.fatal("Logged out. Delete auth_info directory and restart to re-link.");
        process.exit(1);
      }
      logger.warn({ statusCode }, "Connection closed, reconnecting...");
      startWhatsApp();
    }

    if (connection === "open") {
      logger.info("WhatsApp connection established");
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
