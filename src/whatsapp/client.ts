import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  WASocket,
  proto,
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import pino from "pino";
import qrcode from "qrcode-terminal";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";

// Create a Baileys logger that writes directly to stderr (synchronous, no buffering)
const baileysLogLevel = process.env.BAILEYS_LOG_LEVEL ?? "warn";
const waLogger = pino({ level: baileysLogLevel }, pino.destination(2));

export type MessageHandler = (
  jid: string,
  text: string,
  sock: WASocket
) => Promise<void>;

let sock: WASocket | null = null;
let messageHandler: MessageHandler | null = null;

/** Track message IDs sent by the relay so we can ignore our own messages in self-chats */
const sentMessageIds = new Set<string>();

/** Map LID identifiers to phone numbers (populated from creds and lid-mapping events) */
const lidToPhone = new Map<string, string>();

/** Reference to current auth creds for LID resolution */
let currentCreds: any = null;

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

/**
 * Resolve a JID to a phone number for whitelist checking.
 * Handles both phone-based JIDs (@s.whatsapp.net) and LID JIDs (@lid).
 */
export function resolveJidToNumber(jid: string): string | undefined {
  // Phone number JID: "15551234567@s.whatsapp.net" → "15551234567"
  if (jid.endsWith("@s.whatsapp.net")) {
    return jid.replace(/@.*$/, "");
  }

  // LID JID: "123456789012345@lid" → look up phone number
  if (jid.endsWith("@lid")) {
    const lid = jid.replace(/@.*$/, "");
    return lidToPhone.get(lid);
  }

  // Group or other JID type — return raw identifier
  return jid.replace(/@.*$/, "");
}

function updateLidMapping(): void {
  const me = currentCreds?.me;
  if (!me) return;

  // me.id is like "15551234567:123@s.whatsapp.net" or "15551234567@s.whatsapp.net"
  // me.lid is like "123456789012345@lid"
  const phoneJid = me.id;
  const lidJid = me.lid;

  if (phoneJid && lidJid) {
    // Strip device suffix and domain: "15551234567:123@s.whatsapp.net" → "15551234567"
    const phone = phoneJid.replace(/:.*$/, "").replace(/@.*$/, "");
    const lid = lidJid.replace(/@.*$/, "").replace(/:.*$/, "");

    if (phone && lid) {
      lidToPhone.set(lid, phone);
      dbg(`LID mapping: ${lid} → ${phone}`);
    }
  }
}

function dbg(msg: string): void {
  process.stderr.write(`[DEBUG ${new Date().toISOString()}] ${msg}\n`);
}

export async function startWhatsApp(): Promise<WASocket> {
  dbg("startWhatsApp() called");
  const { state, saveCreds } = await useMultiFileAuthState(config.authDir);
  currentCreds = state.creds;

  dbg(`Auth state loaded, has creds.me: ${!!state.creds.me}`);
  updateLidMapping();

  sock = makeWASocket({
    logger: waLogger,
    auth: state,
  });

  dbg("WASocket created, registering event handlers");

  sock.ev.on("creds.update", () => {
    saveCreds();
    updateLidMapping();
  });

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      logger.info("Scan this QR code with WhatsApp:");
      qrcode.generate(qr, { small: true });
    } else {
      dbg(`connection.update: ${JSON.stringify(update, null, 2)}`);
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
    dbg(`messages.upsert: type=${type}, count=${messages.length}`);

    if (type !== "notify") return;

    for (const msg of messages) {
      const jid = msg.key.remoteJid;
      dbg(`Message: jid=${jid}, fromMe=${msg.key.fromMe}, id=${msg.key.id}, hasMessage=${!!msg.message}, keys=${msg.message ? Object.keys(msg.message).join(",") : "none"}`);

      if (!msg.message) continue;
      if (!jid) continue;

      // Skip messages sent by the relay (prevents echo loops in self-chats)
      if (msg.key.id && sentMessageIds.has(msg.key.id)) {
        dbg(`Skipping relay-sent message ${msg.key.id}`);
        continue;
      }

      const text = extractText(msg.message);
      dbg(`Extracted text: ${text ? `"${text.slice(0, 100)}"` : "null"}`);
      if (!text) continue;

      if (messageHandler) {
        try {
          await messageHandler(jid, text, sock!);
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
