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
    required("ALLOWED_NUMBERS")
      .split(",")
      .map((n) => n.trim())
  ),
  workingDirectory: required("WORKING_DIRECTORY"),
  maxMessageLength: parseInt(process.env.MAX_MESSAGE_LENGTH ?? "4000", 10),
  claudeTimeout: parseInt(process.env.CLAUDE_TIMEOUT ?? "300", 10),
  authDir: process.env.AUTH_DIR ?? "./auth_info",
};
