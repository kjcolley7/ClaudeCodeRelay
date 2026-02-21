import { spawn } from "child_process";
import { createInterface } from "readline";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";

export interface ClaudeResult {
  text: string;
  sessionId: string;
}

export async function runClaude(
  prompt: string,
  sessionId?: string,
  onActivity?: () => void
): Promise<ClaudeResult> {
  return new Promise((resolve, reject) => {
    const args = [
      "-p",
      prompt,
      "--output-format",
      "stream-json",
      "--dangerously-skip-permissions",
    ];
    if (sessionId) {
      args.push("--resume", sessionId);
    }

    logger.info({ sessionId, promptLen: prompt.length }, "Spawning Claude");

    const proc = spawn("claude", args, {
      cwd: config.workingDirectory,
    });

    let resultText = "";
    let resultSessionId = sessionId ?? "";
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
        onActivity?.();

        if (event.type === "result") {
          resultText = event.result ?? "";
          resultSessionId = event.session_id ?? resultSessionId;
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

      if (code !== 0 && !resultText) {
        logger.error({ code, stderr: stderr.slice(0, 500) }, "Claude exited with error");
        reject(new Error(`Claude exited with code ${code}: ${stderr.slice(0, 500)}`));
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
