import { WASocket } from "@whiskeysockets/baileys";
import { logger } from "../utils/logger.js";
import {
  startAuthLogin,
  submitAuthCode,
  checkAuthStatus,
} from "../claude/runner.js";
import { trackSentMessage } from "../whatsapp/client.js";

let awaitingAuth = false;

export function isAwaitingAuth(): boolean {
  return awaitingAuth;
}

async function sendText(
  sock: WASocket,
  jid: string,
  text: string
): Promise<void> {
  const sent = await sock.sendMessage(jid, { text });
  if (sent?.key.id) {
    trackSentMessage(sent.key.id);
  }
}

export async function initiateAuth(
  sock: WASocket,
  selfJid: string
): Promise<void> {
  try {
    await sendText(sock, selfJid, "Claude Code is not authenticated. Starting login...");

    const { oauthUrl } = await startAuthLogin();
    awaitingAuth = true;

    await sendText(
      sock,
      selfJid,
      `Open this link to authenticate:\n\n${oauthUrl}\n\nAfter logging in, paste the authentication code here.`
    );
  } catch (err) {
    logger.error({ err }, "Failed to start auth login");
    const msg = err instanceof Error ? err.message : "Unknown error";
    await sendText(sock, selfJid, `Failed to start login: ${msg}`);
  }
}

export async function handleAuthCode(
  code: string,
  sock: WASocket,
  selfJid: string
): Promise<void> {
  try {
    await sendText(sock, selfJid, "Submitting authentication code...");

    const result = await submitAuthCode(code.trim());
    awaitingAuth = false;

    if (result.loginExitCode === 0) {
      const account = result.status?.account ?? "unknown";
      const plan = result.status?.plan ?? "unknown";
      if (result.status?.authenticated || result.status?.loggedIn) {
        await sendText(
          sock,
          selfJid,
          `Authenticated successfully!\n\nAccount: ${account}\nPlan: ${plan}\n\nYou can now send messages to Claude.`
        );
      } else {
        await sendText(
          sock,
          selfJid,
          `Authentication tokens saved. You can now send messages to Claude.`
        );
      }
    } else {
      await sendText(
        sock,
        selfJid,
        `Authentication failed (exit code ${result.loginExitCode}). Use /login to try again.`
      );
    }
  } catch (err) {
    logger.error({ err }, "Failed to submit auth code");
    const msg = err instanceof Error ? err.message : "Unknown error";
    awaitingAuth = false;
    await sendText(
      sock,
      selfJid,
      `Authentication failed: ${msg}\n\nUse /login to try again.`
    );
  }
}

export async function checkAndInitiateAuth(
  sock: WASocket,
  selfJid: string
): Promise<void> {
  try {
    const status = await checkAuthStatus();
    if (!status.authenticated) {
      logger.info("Claude not authenticated, initiating login flow");
      await initiateAuth(sock, selfJid);
    } else {
      logger.info(
        { account: status.account, plan: status.plan },
        "Claude already authenticated"
      );
    }
  } catch (err) {
    logger.error({ err }, "Failed to check auth status on startup");
  }
}
