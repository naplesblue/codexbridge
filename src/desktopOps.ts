import { spawn } from "node:child_process";
import type { CodexBridgeConfig, DesktopMode } from "./config.js";
import { CodexBridgeError } from "./guard.js";
import { decideDesktopOpenPolicy, type DesktopTargetType, type PolicyDecision } from "./policy.js";

export interface DesktopStatusResult {
  mode: DesktopMode;
  apps: string[];
  capabilities: string[];
  platform_supported: boolean;
}

export interface DesktopOpenResult {
  mode: DesktopMode;
  target_type: DesktopTargetType;
  target: string;
  workspace_path?: string;
  resolved_target?: string;
  app?: string;
  argv: string[];
  dry_run: boolean;
  policy: PolicyDecision;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  durationMs?: number;
}

const SUPPORTED_PLATFORM = "darwin";

function capabilitiesForMode(mode: DesktopMode): string[] {
  if (mode === "off") return [];
  return ["open_url", "open_file", "open_app"];
}

function assertPlatformSupported(): void {
  if (process.platform !== SUPPORTED_PLATFORM) {
    throw new CodexBridgeError(
      `desktop_open is only supported on macOS (darwin); current platform is ${process.platform}.`
    );
  }
}

export function desktopStatus(config: CodexBridgeConfig): DesktopStatusResult {
  return {
    mode: config.desktopMode,
    apps: [...config.desktopApps],
    capabilities: capabilitiesForMode(config.desktopMode),
    platform_supported: process.platform === SUPPORTED_PLATFORM
  };
}

function buildArgv(targetType: DesktopTargetType, target: string, resolvedTarget?: string): string[] {
  if (targetType === "app") return ["open", "-a", target];
  if (targetType === "workspace_path") return ["open", resolvedTarget ?? target];
  return ["open", target];
}

export async function desktopOpen(
  config: CodexBridgeConfig,
  options: {
    targetType: DesktopTargetType;
    target: string;
    workspacePath?: string;
    resolvedTarget?: string;
    dryRun?: boolean;
    approved?: boolean;
    timeoutMs?: number;
  }
): Promise<DesktopOpenResult> {
  const target = options.target.trim();
  const policy = decideDesktopOpenPolicy(config.desktopMode, options.targetType, target, {
    appAllowlist: config.desktopApps
  });
  if (policy.decision === "deny") throw new CodexBridgeError(policy.reason);
  if (policy.decision === "ask" && !options.approved) {
    throw new CodexBridgeError(`${policy.reason}\nRetry with approved=true only after explicit user approval.`);
  }

  const argv = buildArgv(options.targetType, target, options.resolvedTarget);
  const base: DesktopOpenResult = {
    mode: config.desktopMode,
    target_type: options.targetType,
    target,
    ...(options.targetType === "workspace_path" && options.workspacePath
      ? { workspace_path: options.workspacePath }
      : {}),
    ...(options.targetType === "workspace_path" && options.resolvedTarget
      ? { resolved_target: options.resolvedTarget }
      : {}),
    ...(options.targetType === "app" ? { app: target } : {}),
    argv,
    dry_run: Boolean(options.dryRun),
    policy
  };
  if (options.dryRun) return base;

  assertPlatformSupported();

  const timeoutMs = Math.max(1_000, Math.min(options.timeoutMs ?? 15_000, 60_000));
  const start = Date.now();
  const [command, ...args] = argv;
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: {
        PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
        HOME: process.env.HOME ?? "",
        USER: process.env.USER ?? ""
      },
      stdio: ["ignore", "ignore", "pipe"]
    });

    let stderr = "";
    let killedByTimeout = false;
    const timer = setTimeout(() => {
      killedByTimeout = true;
      child.kill("SIGTERM");
    }, timeoutMs);
    timer.unref();

    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (exitCode, signal) => {
      clearTimeout(timer);
      if (killedByTimeout) {
        reject(new CodexBridgeError(`desktop_open timed out after ${timeoutMs} ms.`));
        return;
      }
      if (exitCode !== 0) {
        reject(new CodexBridgeError(`desktop_open failed (exit ${exitCode ?? "null"}): ${stderr.trim() || "unknown error"}`));
        return;
      }
      resolve({
        ...base,
        exitCode,
        signal,
        durationMs: Date.now() - start
      });
    });
  });
}
