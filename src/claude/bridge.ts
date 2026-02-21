import http from "node:http";
import { spawn } from "node:child_process";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";

const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok" }));
    return;
  }

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

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not found" }));
});

const port = config.bridgePort;
server.listen(port, () => {
  logger.info({ port }, "Claude bridge server listening");
});
