export const config = {
  workingDirectory: "/home/claude",
  maxMessageLength: parseInt(process.env.MAX_MESSAGE_LENGTH ?? "4000", 10),
  claudeTimeout: parseInt(process.env.CLAUDE_TIMEOUT ?? "300", 10),
  authDir: "./auth_info",
  claudeServiceUrl: process.env.CLAUDE_SERVICE_URL ?? "",
  bridgePort: parseInt(process.env.BRIDGE_PORT ?? "3100", 10),
};
