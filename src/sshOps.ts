import { spawn } from "node:child_process";
import path from "node:path";
import type { CodexBridgeConfig, SshMode, SshProfileConfig } from "./config.js";
import { expandHome } from "./config.js";
import { CodexBridgeError } from "./guard.js";
import { decideSshCommandPolicy, type PolicyDecision } from "./policy.js";
import { redactSensitiveText } from "./redact.js";

export interface SshProfileSummary {
  name: string;
  host: string;
  user?: string;
  port: number;
  identity_file: "<configured>" | "";
  workdir?: string;
  mode: SshMode;
}

export interface SshExecResult {
  profile: string;
  host: string;
  user?: string;
  port: number;
  mode: SshMode;
  command: string;
  remote_command: string;
  argv: string[];
  dry_run: boolean;
  policy: PolicyDecision;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  durationMs?: number;
  stdout?: string;
  stderr?: string;
  truncated?: boolean;
}

function trimOutput(value: string, maxBytes: number): { value: string; truncated: boolean } {
  const buffer = Buffer.from(value, "utf8");
  if (buffer.byteLength <= maxBytes) return { value, truncated: false };
  const sliced = buffer.subarray(0, maxBytes).toString("utf8");
  return { value: `${sliced}\n...[output truncated to ${maxBytes} bytes]`, truncated: true };
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function effectiveMode(config: CodexBridgeConfig, profile: SshProfileConfig): SshMode {
  if (config.sshMode === "off") return "off";
  return profile.mode ?? config.sshMode;
}

function resolveProfile(config: CodexBridgeConfig, name: string): SshProfileConfig {
  const profile = config.sshProfiles[name];
  if (!profile) throw new CodexBridgeError(`Unknown SSH profile: ${name}`);
  return profile;
}

function buildRemoteCommand(profile: SshProfileConfig, command: string, cwd?: string): string {
  const workdir = cwd?.trim() || profile.workdir?.trim();
  if (!workdir) return command.trim();
  if (/[\n\r;&|<>`$]/.test(workdir)) throw new CodexBridgeError("SSH workdir contains unsupported shell metacharacters.");
  return `cd ${shellQuote(workdir)} && ${command.trim()}`;
}

function buildSshArgv(profile: SshProfileConfig, remoteCommand: string): string[] {
  const argv = [
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=10",
    "-o",
    "StrictHostKeyChecking=accept-new"
  ];
  if (profile.port) argv.push("-p", String(profile.port));
  if (profile.identityFile) argv.push("-i", path.resolve(expandHome(profile.identityFile)));
  argv.push(profile.user ? `${profile.user}@${profile.host}` : profile.host, remoteCommand);
  return argv;
}

function publicSshArgv(argv: string[]): string[] {
  const out = [...argv];
  for (let i = 0; i < out.length; i += 1) {
    if (out[i] === "-i" && out[i + 1]) {
      out[i + 1] = "<identity-file>";
      i += 1;
    }
  }
  return out.map((part) => redactSensitiveText(part));
}

export function listSshProfiles(config: CodexBridgeConfig): SshProfileSummary[] {
  return Object.values(config.sshProfiles)
    .map((profile) => ({
      name: profile.name,
      host: profile.host,
      ...(profile.user ? { user: profile.user } : {}),
      port: profile.port ?? 22,
      identity_file: profile.identityFile ? "<configured>" as const : "" as const,
      ...(profile.workdir ? { workdir: profile.workdir } : {}),
      mode: effectiveMode(config, profile)
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function runSshCommand(
  config: CodexBridgeConfig,
  options: {
    profile: string;
    command: string;
    cwd?: string;
    timeoutMs?: number;
    dryRun?: boolean;
    approved?: boolean;
  }
): Promise<SshExecResult> {
  const profile = resolveProfile(config, options.profile);
  const command = options.command.trim();
  const mode = effectiveMode(config, profile);
  const policy = decideSshCommandPolicy(mode, command);
  if (policy.decision === "deny") throw new CodexBridgeError(policy.reason);
  if (policy.decision === "ask" && !options.approved) {
    throw new CodexBridgeError(`${policy.reason}\nRetry with approved=true only after explicit user approval.`);
  }

  const remoteCommand = buildRemoteCommand(profile, command, options.cwd);
  const argv = buildSshArgv(profile, remoteCommand);
  const base: SshExecResult = {
    profile: profile.name,
    host: profile.host,
    ...(profile.user ? { user: profile.user } : {}),
    port: profile.port ?? 22,
    mode,
    command: redactSensitiveText(command),
    remote_command: redactSensitiveText(remoteCommand),
    argv: publicSshArgv(["ssh", ...argv]),
    dry_run: Boolean(options.dryRun),
    policy
  };
  if (options.dryRun) return base;

  const timeoutMs = Math.max(1_000, Math.min(options.timeoutMs ?? 30_000, 180_000));
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn("ssh", argv, {
      env: {
        PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
        HOME: process.env.HOME ?? "",
        USER: process.env.USER ?? "",
        TERM: "dumb",
        NO_COLOR: "1",
        CI: "1"
      },
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
      if (killedByTimeout) stderr += `\n[codexbridge] SSH command timed out after ${timeoutMs} ms.`;
      const out = trimOutput(redactSensitiveText(stdout), config.maxOutputBytes);
      const err = trimOutput(redactSensitiveText(stderr), config.maxOutputBytes);
      resolve({
        ...base,
        exitCode,
        signal,
        durationMs: Date.now() - start,
        stdout: out.value,
        stderr: err.value,
        truncated: out.truncated || err.truncated
      });
    });
  });
}
