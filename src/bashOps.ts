import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { CodexBridgeConfig } from "./config.js";
import type { Workspace } from "./guard.js";
import { CodexBridgeError, PathGuard } from "./guard.js";
import { decideCommandPolicy } from "./policy.js";
import { redactSensitiveText } from "./redact.js";

export interface BashResult {
  command: string;
  cwd: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  durationMs: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
  bashSessionId?: string;
}

function assertSafeCommand(config: CodexBridgeConfig, command: string): void {
  const decision = decideCommandPolicy(config, command);
  if (decision.decision === "deny") throw new CodexBridgeError(decision.reason);
}

function assertBashSession(config: CodexBridgeConfig, sessionId?: string): string | undefined {
  const requested = sessionId?.trim();
  if (!config.bashSessionId) {
    if (config.requireBashSession) {
      throw new CodexBridgeError("bash session guard is enabled but no server bash session id is configured.");
    }
    return undefined;
  }
  if (!requested) {
    if (config.requireBashSession) {
      throw new CodexBridgeError(`bash session id is required. Retry with session_id="${config.bashSessionId}".`);
    }
    return config.bashSessionId;
  }
  if (requested !== config.bashSessionId) {
    throw new CodexBridgeError(`bash session id mismatch. This CodexBridge server accepts session_id="${config.bashSessionId}".`);
  }
  return config.bashSessionId;
}

function makeEnv(config: CodexBridgeConfig): NodeJS.ProcessEnv {
  if (config.inheritEnv) {
    return { ...process.env, NO_COLOR: "1", CI: process.env.CI ?? "1" };
  }
  return {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: process.env.HOME ?? "",
    USER: process.env.USER ?? "",
    SHELL: process.env.SHELL ?? "/bin/bash",
    TMPDIR: process.env.TMPDIR ?? "/tmp",
    TERM: "dumb",
    NO_COLOR: "1",
    CI: "1"
  };
}

function bashExecutable(): string {
  return fs.existsSync("/bin/bash") ? "/bin/bash" : "bash";
}

function trimOutput(value: string, maxBytes: number): { value: string; truncated: boolean } {
  const buffer = Buffer.from(value, "utf8");
  if (buffer.byteLength <= maxBytes) return { value, truncated: false };
  const sliced = buffer.subarray(0, maxBytes).toString("utf8");
  return { value: `${sliced}\n...[output truncated to ${maxBytes} bytes]`, truncated: true };
}

export async function runBash(
  config: CodexBridgeConfig,
  guard: PathGuard,
  workspace: Workspace,
  command: string,
  options: { cwd?: string; timeoutMs?: number; sessionId?: string } = {}
): Promise<BashResult> {
  if (!command?.trim()) throw new CodexBridgeError("command is required.");
  const bashSessionId = assertBashSession(config, options.sessionId);
  assertSafeCommand(config, command);
  const cwdResolved = guard.resolve(workspace, options.cwd ?? ".");
  const cwd = cwdResolved.absPath;
  const timeoutMs = Math.max(1_000, Math.min(options.timeoutMs ?? 30_000, 180_000));
  const start = Date.now();

  return new Promise((resolve, reject) => {
    const child = spawn(bashExecutable(), ["-lc", command], {
      cwd,
      env: makeEnv(config),
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    let killedByTimeout = false;

    const timer = setTimeout(() => {
      killedByTimeout = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!child.killed) child.kill("SIGKILL");
      }, 1_500).unref();
    }, timeoutMs);
    timer.unref();

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
      if (Buffer.byteLength(stdout, "utf8") > config.maxOutputBytes * 2) child.kill("SIGTERM");
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
      if (Buffer.byteLength(stderr, "utf8") > config.maxOutputBytes * 2) child.kill("SIGTERM");
    });
    child.on("error", reject);
    child.on("close", (exitCode, signal) => {
      clearTimeout(timer);
      if (killedByTimeout) {
        stderr += `\n[codexbridge] Command timed out after ${timeoutMs} ms.`;
      }
      const out = trimOutput(redactSensitiveText(stdout), config.maxOutputBytes);
      const err = trimOutput(redactSensitiveText(stderr), config.maxOutputBytes);
      resolve({
        command,
        cwd: path.relative(workspace.root, cwd) || ".",
        exitCode,
        signal,
        durationMs: Date.now() - start,
        stdout: out.value,
        stderr: err.value,
        truncated: out.truncated || err.truncated,
        ...(bashSessionId ? { bashSessionId } : {})
      });
    });
  });
}
