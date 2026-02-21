import dotenv from "dotenv";

dotenv.config();

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const config = {
  allowedNumbers: new Set(
    (process.env.ALLOWED_NUMBERS ?? "")
      .split(",")
      .map((n) => n.trim())
      .filter(Boolean)
  ),
  workingDirectory: "/workspace",
  maxMessageLength: parseInt(process.env.MAX_MESSAGE_LENGTH ?? "4000", 10),
  claudeTimeout: parseInt(process.env.CLAUDE_TIMEOUT ?? "300", 10),
  authDir: "./auth_info",
  claudeServiceUrl: process.env.CLAUDE_SERVICE_URL ?? "",
  bridgePort: parseInt(process.env.BRIDGE_PORT ?? "3100", 10),
};
