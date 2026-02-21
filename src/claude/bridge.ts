import http from "node:http";
import { spawn, ChildProcess } from "node:child_process";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";

// Module-level state for the running auth login process
let authProc: ChildProcess | null = null;
let authTimer: ReturnType<typeof setTimeout> | null = null;
let authOutput = "";
// Resolve function for the code submission waiting on process exit
let authCodeResolve: ((code: number | null) => void) | null = null;

function cleanupAuthProc(): void {
  if (authTimer) {
    clearTimeout(authTimer);
    authTimer = null;
  }
  if (authProc && !authProc.killed) {
    authProc.kill("SIGTERM");
  }
  authProc = null;
  authCodeResolve = null;
}

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
    // Kill any existing auth process
    cleanupAuthProc();

    logger.info("Starting claude auth login");

    authOutput = "";
    authProc = spawn("claude", ["auth", "login"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, BROWSER: "echo" },
    });

    let oauthUrl = "";
    let responded = false;

    const sendUrl = () => {
      if (responded || !oauthUrl) return;
      responded = true;
      jsonResponse(res, 200, { oauthUrl });
    };

    // 5-minute timeout for the auth process
    authTimer = setTimeout(() => {
      logger.warn({ output: authOutput.slice(0, 1000) }, "Auth login process timed out");
      cleanupAuthProc();
      if (!responded) {
        responded = true;
        jsonResponse(res, 504, { error: "Auth login timed out" });
      }
    }, 5 * 60 * 1000);

    const handleOutput = (chunk: Buffer) => {
      const text = chunk.toString();
      authOutput += text;
      logger.info({ chunk: text.slice(0, 500) }, "Auth process output");
      // Look for URL in output
      const urlMatch = authOutput.match(/(https?:\/\/[^\s]+)/);
      if (urlMatch && !oauthUrl) {
        oauthUrl = urlMatch[1];
        logger.info({ oauthUrl }, "Captured OAuth URL");
        sendUrl();
      }
    };

    authProc.stdout?.on("data", handleOutput);
    authProc.stderr?.on("data", handleOutput);

    authProc.on("error", (err) => {
      logger.error({ err }, "Auth login process error");
      cleanupAuthProc();
      if (!responded) {
        responded = true;
        jsonResponse(res, 500, { error: err.message });
      }
    });

    authProc.on("close", (code) => {
      logger.info({ code, output: authOutput.slice(0, 1000) }, "Auth login process exited");
      if (authTimer) {
        clearTimeout(authTimer);
        authTimer = null;
      }
      authProc = null;
      // If /auth/code is waiting, resolve it
      if (authCodeResolve) {
        authCodeResolve(code);
        authCodeResolve = null;
      }
      if (!responded) {
        responded = true;
        jsonResponse(res, 500, {
          error: "Auth process exited before providing URL",
          output: authOutput.slice(0, 1000),
        });
      }
    });
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

      if (!authProc || authProc.killed || !authProc.stdin?.writable) {
        jsonResponse(res, 409, {
          error: "No auth login process running. Call POST /auth/login first.",
        });
        return;
      }

      // Clear the original 5-minute timeout and give 2 minutes for code processing
      if (authTimer) {
        clearTimeout(authTimer);
        authTimer = null;
      }
      authTimer = setTimeout(() => {
        logger.warn(
          { output: authOutput.slice(0, 1000) },
          "Auth code processing timed out"
        );
        cleanupAuthProc();
      }, 2 * 60 * 1000);

      logger.info("Writing auth code to login process stdin");
      authProc.stdin.write(payload.code + "\n");
      authProc.stdin.end();

      // Wait for the auth process to exit via promise
      const exitCode = await new Promise<number | null>((resolve) => {
        authCodeResolve = resolve;
      });

      logger.info(
        { exitCode, output: authOutput.slice(0, 1000) },
        "Auth login process completed after code submission"
      );

      // Check auth status
      try {
        const statusCode = await new Promise<unknown>((resolve, reject) => {
          const statusProc = spawn("claude", ["auth", "status", "--json"], {
            stdio: ["ignore", "pipe", "pipe"],
          });

          let stdout = "";
          statusProc.stdout.on("data", (chunk: Buffer) => {
            stdout += chunk.toString();
          });

          statusProc.on("close", () => {
            try {
              resolve(JSON.parse(stdout));
            } catch {
              resolve(null);
            }
          });

          statusProc.on("error", (err) => reject(err));
        });

        jsonResponse(res, 200, { loginExitCode: exitCode, status: statusCode });
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : "Unknown error";
        jsonResponse(res, 200, {
          loginExitCode: exitCode,
          status: null,
          error: errMsg,
        });
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
