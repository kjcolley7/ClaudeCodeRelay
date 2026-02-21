import { spawn } from "child_process";
import http from "node:http";
import { createInterface } from "readline";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";

export interface ClaudeResult {
  text: string;
  sessionId: string;
}

export class ClaudeSessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClaudeSessionError";
  }
}

// --- Auth types ---

export interface AuthStatus {
  authenticated: boolean;
  account?: string;
  plan?: string;
  [key: string]: unknown;
}

export interface AuthLoginResult {
  oauthUrl: string;
}

export interface AuthCallbackResult {
  loginExitCode: number | null;
  status: AuthStatus | null;
}

// --- Auth functions ---

function authRequest(
  method: string,
  path: string,
  body?: unknown
): Promise<unknown> {
  if (config.claudeServiceUrl) {
    return authRequestRemote(method, path, body);
  }
  throw new Error("Auth functions require CLAUDE_SERVICE_URL (bridge mode)");
}

function authRequestRemote(
  method: string,
  path: string,
  body?: unknown
): Promise<unknown> {
  const url = new URL(path, config.claudeServiceUrl);
  const payload = body ? JSON.stringify(body) : undefined;

  return new Promise((resolve, reject) => {
    const req = http.request(
      url,
      {
        method,
        headers: {
          ...(payload
            ? {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(payload),
              }
            : {}),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk: Buffer) => {
          data += chunk.toString();
        });
        res.on("end", () => {
          try {
            const parsed = JSON.parse(data);
            if (res.statusCode && res.statusCode >= 400) {
              reject(
                new Error(
                  parsed.error ?? `Bridge returned ${res.statusCode}`
                )
              );
            } else {
              resolve(parsed);
            }
          } catch {
            reject(new Error(`Invalid JSON from bridge: ${data.slice(0, 200)}`));
          }
        });
      }
    );

    req.on("error", (err) => {
      reject(new Error(`Bridge request failed: ${err.message}`));
    });

    if (payload) req.write(payload);
    req.end();
  });
}

export async function checkAuthStatus(): Promise<AuthStatus> {
  const raw = (await authRequest("GET", "/auth/status")) as Record<string, unknown>;
  // claude auth status --json returns "loggedIn", normalize to "authenticated"
  const result: AuthStatus = {
    ...raw,
    authenticated: !!(raw.authenticated ?? raw.loggedIn),
  };
  logger.info({ authenticated: result.authenticated }, "Auth status checked");
  return result;
}

export async function startAuthLogin(): Promise<AuthLoginResult> {
  const result = (await authRequest(
    "POST",
    "/auth/login"
  )) as AuthLoginResult;
  logger.info("Auth login started, OAuth URL received");
  return result;
}

export async function submitAuthCode(
  code: string
): Promise<AuthCallbackResult> {
  const result = (await authRequest("POST", "/auth/code", {
    code,
  })) as AuthCallbackResult;
  logger.info(
    { loginExitCode: result.loginExitCode },
    "Auth code submitted"
  );
  return result;
}

export async function runClaude(
  prompt: string,
  sessionId?: string,
  onActivity?: () => void
): Promise<ClaudeResult> {
  if (config.claudeServiceUrl) {
    return runClaudeRemote(prompt, sessionId, onActivity);
  }
  return runClaudeLocal(prompt, sessionId, onActivity);
}

async function runClaudeLocal(
  prompt: string,
  sessionId?: string,
  onActivity?: () => void
): Promise<ClaudeResult> {
  return new Promise((resolve, reject) => {
    const args = [
      "-p",
      prompt,
      "--verbose",
      "--output-format",
      "stream-json",
      "--dangerously-skip-permissions",
    ];
    if (sessionId) {
      args.push("--resume", sessionId);
    }

    logger.info({ sessionId, promptLen: prompt.length }, "Spawning Claude (local)");

    const proc = spawn("claude", args, {
      cwd: config.workingDirectory,
    });

    let resultText = "";
    let resultSessionId = sessionId ?? "";
    let errorMessage = "";
    const events: unknown[] = [];
    let settled = false;

    const timer = setTimeout(() => {
      proc.kill("SIGTERM");
      if (!settled) {
        settled = true;
        reject(new Error("Claude process timed out"));
      }
    }, config.claudeTimeout * 1000);

    const rl = createInterface({ input: proc.stdout });

    rl.on("line", (line) => {
      if (!line.trim()) return;
      try {
        const event = JSON.parse(line);
        events.push(event);
        onActivity?.();

        if (event.type === "result") {
          resultText = event.result ?? "";
          resultSessionId = event.session_id ?? resultSessionId;
          if (event.is_error) {
            const errors = Array.isArray(event.errors) ? event.errors.join("; ") : "";
            errorMessage = errors || resultText || "Unknown error";
          }
        } else if (event.type === "error") {
          errorMessage = event.error?.message ?? JSON.stringify(event);
        }
      } catch {
        // Non-JSON line, ignore
      }
    });

    let stderr = "";
    proc.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    proc.on("close", (code) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;

      if (errorMessage) {
        logger.error({ code, errorMessage, events }, "Claude returned an error");
        const ErrorClass = /session\s*ID/i.test(errorMessage) ? ClaudeSessionError : Error;
        reject(new ErrorClass(`Claude error: ${errorMessage}`));
      } else if (code !== 0 || !resultText) {
        logger.error({ code, events, stderr: stderr.slice(0, 500) }, "Claude exited with error");
        reject(new Error(resultText || `Claude exited with code ${code}`));
      } else {
        logger.info(
          { sessionId: resultSessionId, resultLen: resultText.length },
          "Claude finished"
        );
        resolve({ text: resultText, sessionId: resultSessionId });
      }
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
}

async function runClaudeRemote(
  prompt: string,
  sessionId?: string,
  onActivity?: () => void
): Promise<ClaudeResult> {
  const url = new URL("/invoke", config.claudeServiceUrl);

  logger.info({ sessionId, promptLen: prompt.length }, "Invoking Claude (remote)");

  const payload = JSON.stringify({
    prompt,
    sessionId,
    timeout: config.claudeTimeout,
  });

  return new Promise((resolve, reject) => {
    const req = http.request(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        if (res.statusCode !== 200) {
          let body = "";
          res.on("data", (chunk: Buffer) => {
            body += chunk.toString();
          });
          res.on("end", () => {
            reject(new Error(`Bridge returned ${res.statusCode}: ${body}`));
          });
          return;
        }

        let resultText = "";
        let resultSessionId = sessionId ?? "";
        let errorMessage = "";
        const events: unknown[] = [];

        const rl = createInterface({ input: res });

        rl.on("line", (line) => {
          if (!line.trim()) return;
          try {
            const event = JSON.parse(line);
            events.push(event);
            onActivity?.();

            if (event.type === "result") {
              resultText = event.result ?? "";
              resultSessionId = event.session_id ?? resultSessionId;
              if (event.is_error) {
                const errors = Array.isArray(event.errors) ? event.errors.join("; ") : "";
                errorMessage = errors || resultText || "Unknown error";
              }
            } else if (event.type === "error") {
              errorMessage = event.error?.message ?? JSON.stringify(event);
            }
          } catch {
            // Non-JSON line, ignore
          }
        });

        res.on("end", () => {
          if (errorMessage) {
            logger.error({ errorMessage, events }, "Claude returned an error (remote)");
            const ErrorClass = /session\s*ID/i.test(errorMessage) ? ClaudeSessionError : Error;
            reject(new ErrorClass(`Claude error: ${errorMessage}`));
          } else if (!resultText) {
            logger.error({ events }, "Claude returned empty result (remote)");
            reject(new Error("Claude returned an empty response"));
          } else {
            logger.info(
              { sessionId: resultSessionId, resultLen: resultText.length },
              "Claude finished (remote)"
            );
            resolve({ text: resultText, sessionId: resultSessionId });
          }
        });
      }
    );

    req.on("error", (err) => {
      reject(new Error(`Bridge request failed: ${err.message}`));
    });

    req.write(payload);
    req.end();
  });
}
