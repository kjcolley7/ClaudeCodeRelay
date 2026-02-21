import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  WASocket,
  proto,
  makeCacheableSignalKeyStore,
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import qrcode from "qrcode-terminal";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";

const waLogger = logger.child({ module: "baileys" });
waLogger.level = "warn";

export type MessageHandler = (
  jid: string,
  text: string,
  sock: WASocket
) => Promise<void>;

let sock: WASocket | null = null;
let messageHandler: MessageHandler | null = null;

export function onMessage(handler: MessageHandler): void {
  messageHandler = handler;
}

export function getSocket(): WASocket | null {
  return sock;
}

export async function startWhatsApp(): Promise<WASocket> {
  const { state, saveCreds } = await useMultiFileAuthState(config.authDir);

  sock = makeWASocket({
    logger: waLogger,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, waLogger),
    },
    generateHighQualityLinkPreview: false,
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
      if (msg.key.fromMe) continue;
      if (!msg.message) continue;

      const jid = msg.key.remoteJid;
      if (!jid) continue;

      const text = extractText(msg.message);
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
    message.extendedTextMessage?.text
  );
}
