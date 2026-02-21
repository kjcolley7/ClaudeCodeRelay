import { startWhatsApp, onMessage } from "./whatsapp/client.js";
import { handleMessage } from "./handlers/message.js";
import { logger } from "./utils/logger.js";
import { config } from "./config.js";

async function main(): Promise<void> {
  logger.info(
    {
      workingDirectory: config.workingDirectory,
      allowedNumbers: [...config.allowedNumbers],
    },
    "Starting ClaudeRelay"
  );

  onMessage(handleMessage);
  await startWhatsApp();
}

main().catch((err) => {
  logger.fatal({ err }, "Fatal error");
  process.exit(1);
});
