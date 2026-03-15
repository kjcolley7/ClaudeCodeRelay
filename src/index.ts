import http from "node:http";
import { startWhatsApp, onMessage, getHealthStatus } from "./whatsapp/client.js";
import { handleMessage } from "./handlers/message.js";
import { logger } from "./utils/logger.js";
import { config } from "./config.js";
import { checkAndInitiateAuth } from "./handlers/auth.js";

process.on("unhandledRejection", (reason) => {
  logger.fatal({ err: reason }, "Unhandled promise rejection");
  process.exit(1);
});

process.on("uncaughtException", (err) => {
  logger.fatal({ err }, "Uncaught exception");
  process.exit(1);
});

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    logger.info({ signal }, "Received signal, shutting down");
    process.exit(0);
  });
}

async function main(): Promise<void> {
  logger.info({ workingDirectory: config.workingDirectory }, "Starting ClaudeCodeRelay");

  // Health check HTTP server for Docker
  const healthServer = http.createServer((_req, res) => {
    const status = getHealthStatus();
    const code = status.healthy ? 200 : 503;
    res.writeHead(code, { "Content-Type": "application/json" });
    res.end(JSON.stringify(status));
  });
  healthServer.listen(config.healthPort, () => {
    logger.info({ port: config.healthPort }, "Health check server listening");
  });

  onMessage(handleMessage);
  const sock = await startWhatsApp();

  // Check Claude auth status once WhatsApp is connected (only in bridge mode)
  if (config.claudeServiceUrl) {
    let authChecked = false;
    sock.ev.on("connection.update", (update) => {
      if (update.connection === "open" && !authChecked) {
        authChecked = true;
        // Derive self-chat JID from sock.user.id
        const selfJid = sock.user?.id;
        if (selfJid) {
          // Baileys user.id is "number:device@s.whatsapp.net", self-chat uses just "number@s.whatsapp.net"
          const selfChatJid = selfJid.replace(/:.*@/, "@");
          checkAndInitiateAuth(sock, selfChatJid).catch((err) => {
            logger.error({ err }, "Startup auth check failed");
          });
        } else {
          logger.warn("Cannot determine self JID for auth check");
        }
      }
    });
  }
}

main().catch((err) => {
  logger.fatal({ err }, "Fatal error");
  process.exit(1);
});
