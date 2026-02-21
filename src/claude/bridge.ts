import http from "node:http";
import https from "node:https";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";

// --- OAuth PKCE auth state ---

const OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const OAUTH_AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
const OAUTH_TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const OAUTH_REDIRECT_URI = "https://platform.claude.com/oauth/code/callback";
const OAUTH_SCOPES =
  "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers";

let pendingCodeVerifier: string | null = null;
let pendingState: string | null = null;

function base64url(buf: Buffer): string {
  return buf.toString("base64url");
}

function generateCodeVerifier(): string {
  return base64url(crypto.randomBytes(32));
}

function generateCodeChallenge(verifier: string): string {
  return base64url(crypto.createHash("sha256").update(verifier).digest());
}

function generateState(): string {
  return base64url(crypto.randomBytes(32));
}

function buildOAuthUrl(codeChallenge: string, state: string): string {
  const params = new URLSearchParams({
    code: "true",
    client_id: OAUTH_CLIENT_ID,
    response_type: "code",
    redirect_uri: OAUTH_REDIRECT_URI,
    scope: OAUTH_SCOPES,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    state,
  });
  return `${OAUTH_AUTHORIZE_URL}?${params}`;
}

function getCredentialsPath(): string {
  const configDir = (
    process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude")
  ).normalize("NFC");
  return path.join(configDir, ".credentials.json");
}

function httpsPost(
  url: string,
  body: string,
  contentType: string
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = https.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || 443,
        path: parsed.pathname + parsed.search,
        method: "POST",
        headers: {
          "Content-Type": contentType,
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk: Buffer) => {
          data += chunk.toString();
        });
        res.on("end", () => {
          resolve({ status: res.statusCode ?? 0, body: data });
        });
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// --- Helper functions ---

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString();
    });
    req.on("end", () => resolve(body));
  });
}

function jsonResponse(
  res: http.ServerResponse,
  status: number,
  data: unknown
): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

// --- HTTP server ---

const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    jsonResponse(res, 200, { status: "ok" });
    return;
  }

  // --- Auth endpoints ---

  if (req.method === "GET" && req.url === "/auth/status") {
    const proc = spawn("claude", ["auth", "status", "--json"], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    proc.on("close", (code) => {
      try {
        const parsed = JSON.parse(stdout);
        jsonResponse(res, 200, parsed);
      } catch {
        logger.error(
          { code, stdout: stdout.slice(0, 500), stderr: stderr.slice(0, 500) },
          "Failed to parse auth status"
        );
        jsonResponse(res, 500, {
          error: "Failed to parse auth status",
          stdout: stdout.slice(0, 500),
        });
      }
    });

    proc.on("error", (err) => {
      logger.error({ err }, "Failed to spawn claude auth status");
      jsonResponse(res, 500, { error: err.message });
    });
    return;
  }

  if (req.method === "POST" && req.url === "/auth/login") {
    // Generate PKCE values and build OAuth URL
    const codeVerifier = generateCodeVerifier();
    const codeChallenge = generateCodeChallenge(codeVerifier);
    const state = generateState();
    const oauthUrl = buildOAuthUrl(codeChallenge, state);

    pendingCodeVerifier = codeVerifier;
    pendingState = state;

    logger.info("Generated OAuth PKCE login URL");
    jsonResponse(res, 200, { oauthUrl });
    return;
  }

  if (req.method === "POST" && req.url === "/auth/code") {
    readBody(req).then(async (body) => {
      let payload: { code: string };
      try {
        payload = JSON.parse(body);
      } catch {
        jsonResponse(res, 400, { error: "Invalid JSON" });
        return;
      }

      if (!payload.code) {
        jsonResponse(res, 400, { error: "Missing code" });
        return;
      }

      if (!pendingCodeVerifier) {
        jsonResponse(res, 409, {
          error: "No pending login. Call POST /auth/login first.",
        });
        return;
      }

      // The code from the browser is in format "AUTH_CODE#STATE"
      const rawCode = payload.code.trim();
      const hashIdx = rawCode.indexOf("#");
      const authorizationCode = hashIdx >= 0 ? rawCode.slice(0, hashIdx) : rawCode;
      const stateFromCode = hashIdx >= 0 ? rawCode.slice(hashIdx + 1) : pendingState;
      const codeVerifier = pendingCodeVerifier;
      pendingCodeVerifier = null;
      pendingState = null;

      logger.info("Exchanging auth code for tokens");

      try {
        // Exchange the authorization code for tokens (JSON body, not form-encoded)
        const tokenBody = JSON.stringify({
          grant_type: "authorization_code",
          code: authorizationCode,
          redirect_uri: OAUTH_REDIRECT_URI,
          client_id: OAUTH_CLIENT_ID,
          code_verifier: codeVerifier,
          state: stateFromCode,
        });

        const tokenRes = await httpsPost(
          OAUTH_TOKEN_URL,
          tokenBody,
          "application/json"
        );

        logger.info(
          { status: tokenRes.status },
          "Token exchange response"
        );

        if (tokenRes.status !== 200) {
          logger.error(
            { status: tokenRes.status, body: tokenRes.body.slice(0, 500) },
            "Token exchange failed"
          );
          jsonResponse(res, 502, {
            error: "Token exchange failed",
            detail: tokenRes.body.slice(0, 500),
          });
          return;
        }

        const tokens = JSON.parse(tokenRes.body);

        logger.info(
          { keys: Object.keys(tokens) },
          "Token exchange response keys"
        );

        // Save tokens to ~/.claude/.credentials.json
        const credPath = getCredentialsPath();
        const credDir = path.dirname(credPath);
        if (!fs.existsSync(credDir)) {
          fs.mkdirSync(credDir, { recursive: true });
        }

        let creds: Record<string, unknown> = {};
        if (fs.existsSync(credPath)) {
          try {
            creds = JSON.parse(fs.readFileSync(credPath, "utf8"));
          } catch {
            // Start fresh
          }
        }

        creds.claudeAiOauth = {
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token,
          expiresAt: Date.now() + (tokens.expires_in ?? 3600) * 1000,
          scopes: tokens.scope ? tokens.scope.split(" ") : [],
          subscriptionType: tokens.subscription_type ?? null,
          rateLimitTier: tokens.rate_limit_tier ?? null,
        };

        fs.writeFileSync(credPath, JSON.stringify(creds), "utf8");
        fs.chmodSync(credPath, 0o600);

        logger.info("Saved OAuth tokens to credentials file");

        // Check auth status to confirm and get account info
        const status = await new Promise<unknown>((resolve) => {
          const statusProc = spawn("claude", ["auth", "status", "--json"], {
            stdio: ["ignore", "pipe", "pipe"],
          });
          let stdout = "";
          let stderr = "";
          statusProc.stdout.on("data", (chunk: Buffer) => {
            stdout += chunk.toString();
          });
          statusProc.stderr.on("data", (chunk: Buffer) => {
            stderr += chunk.toString();
          });
          statusProc.on("close", (code) => {
            logger.info(
              { code, stdout: stdout.slice(0, 500), stderr: stderr.slice(0, 500) },
              "Auth status check after token save"
            );
            try {
              resolve(JSON.parse(stdout));
            } catch {
              resolve(null);
            }
          });
          statusProc.on("error", (err) => {
            logger.error({ err }, "Failed to spawn auth status check");
            resolve(null);
          });
        });

        jsonResponse(res, 200, { loginExitCode: 0, status });
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : "Unknown error";
        logger.error({ err }, "Auth code exchange failed");
        jsonResponse(res, 500, { error: errMsg });
      }
    });
    return;
  }

  // --- Invoke endpoint ---

  if (req.method === "POST" && req.url === "/invoke") {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString();
    });
    req.on("end", () => {
      let payload: { prompt: string; sessionId?: string; timeout?: number };
      try {
        payload = JSON.parse(body);
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid JSON" }));
        return;
      }

      if (!payload.prompt) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Missing prompt" }));
        return;
      }

      const args = [
        "-p",
        payload.prompt,
        "--verbose",
        "--output-format",
        "stream-json",
        "--dangerously-skip-permissions",
      ];
      if (payload.sessionId) {
        args.push("--resume", payload.sessionId);
      }

      const timeout = payload.timeout ?? config.claudeTimeout;

      logger.info(
        { sessionId: payload.sessionId, promptLen: payload.prompt.length },
        "Spawning Claude"
      );

      const proc = spawn("claude", args, {
        cwd: config.workingDirectory,
        stdio: ["ignore", "pipe", "pipe"],
      });

      res.writeHead(200, {
        "Content-Type": "application/x-ndjson",
        "Transfer-Encoding": "chunked",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });

      const timer = setTimeout(() => {
        proc.kill("SIGTERM");
        logger.warn({ timeout }, "Claude process timed out");
      }, timeout * 1000);

      let stdoutBytes = 0;
      proc.stdout.on("data", (chunk: Buffer) => {
        stdoutBytes += chunk.length;
        res.write(chunk);
      });

      let stderr = "";
      proc.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      proc.on("close", (code, signal) => {
        clearTimeout(timer);
        if (code !== 0) {
          logger.error(
            { code, signal, stderr: stderr.slice(0, 500), stdoutBytes },
            "Claude exited with error"
          );
        } else {
          logger.info({ stdoutBytes }, "Claude finished");
        }
        res.end();
      });

      proc.on("error", (err) => {
        clearTimeout(timer);
        logger.error({ err }, "Failed to spawn Claude");
        res.end();
      });

      // Kill subprocess if client disconnects before response finishes
      res.on("close", () => {
        if (!res.writableFinished && !proc.killed) {
          proc.kill("SIGTERM");
          clearTimeout(timer);
        }
      });
    });
    return;
  }

  jsonResponse(res, 404, { error: "Not found" });
});

const port = config.bridgePort;
server.listen(port, () => {
  logger.info({ port }, "Claude bridge server listening");
});
