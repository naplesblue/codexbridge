import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type BashMode = "off" | "safe" | "full";
export type BashTranscriptMode = "compact" | "full";
export type CodexSessionsMode = "off" | "metadata" | "read";
export type WriteMode = "off" | "handoff" | "workspace";
export type ToolMode = "minimal" | "standard" | "full";

export interface CodexBridgeConfig {
  defaultRoot: string;
  allowedRoots: string[];
  host: string;
  port: number;
  widgetDomain: string;
  authToken?: string;
  requireHttpToken: boolean;
  bashMode: BashMode;
  bashTranscript: BashTranscriptMode;
  bashSessionId?: string;
  requireBashSession: boolean;
  codexSessions: CodexSessionsMode;
  codexDir: string;
  writeMode: WriteMode;
  toolMode: ToolMode;
  inheritEnv: boolean;
  maxReadBytes: number;
  maxWriteBytes: number;
  maxOutputBytes: number;
  maxSearchResults: number;
  maxJournalEvents: number;
  maxHttpSessions: number;
  httpSessionTtlMs: number;
  blockedGlobs: string[];
  contextDir: string;
}

export type CodexProConfig = CodexBridgeConfig;

const DEFAULT_BLOCKED_GLOBS = [
  ".git",
  ".git/**",
  "**/.git/**",
  "node_modules",
  "node_modules/**",
  "**/node_modules/**",
  ".env",
  ".env.*",
  "**/.env",
  "**/.env.*",
  "**/*.pem",
  "**/*.key",
  "**/id_rsa",
  "**/id_rsa.*",
  "**/id_ed25519",
  "**/id_ed25519.*",
  "**/.ssh/**",
  "dist",
  "dist/**",
  "**/dist/**",
  "build",
  "build/**",
  "**/build/**",
  ".next",
  ".next/**",
  "**/.next/**",
  "coverage",
  "coverage/**",
  "**/coverage/**",
  ".cache",
  ".cache/**",
  "**/.cache/**"
];

function parseArgs(argv: string[]): Record<string, string | string[] | boolean> {
  const out: Record<string, string | string[] | boolean> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i];
    if (!raw.startsWith("--")) continue;
    const withoutPrefix = raw.slice(2);
    const eqIndex = withoutPrefix.indexOf("=");
    let key: string;
    let value: string | boolean;
    if (eqIndex >= 0) {
      key = withoutPrefix.slice(0, eqIndex);
      value = withoutPrefix.slice(eqIndex + 1);
    } else {
      key = withoutPrefix;
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        value = next;
        i += 1;
      } else {
        value = true;
      }
    }

    if (key === "allow-root") {
      const prev = out[key];
      if (Array.isArray(prev)) prev.push(String(value));
      else if (prev) out[key] = [String(prev), String(value)];
      else out[key] = [String(value)];
    } else {
      out[key] = value;
    }
  }
  return out;
}

export function expandHome(input: string): string {
  if (!input || input === "~") return os.homedir();
  if (input.startsWith("~/")) return path.join(os.homedir(), input.slice(2));
  return input;
}

function splitList(value: string | undefined, delimiter: string = path.delimiter): string[] {
  if (!value) return [];
  return value
    .split(delimiter)
    .map((part) => part.trim())
    .filter(Boolean);
}

function splitRoots(value: string | undefined): string[] {
  return splitList(value, path.delimiter);
}

function toRealDir(input: string): string {
  const expanded = expandHome(input);
  const resolved = path.resolve(expanded);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Directory does not exist: ${resolved}`);
  }
  const stat = fs.statSync(resolved);
  if (!stat.isDirectory()) {
    throw new Error(`Not a directory: ${resolved}`);
  }
  return fs.realpathSync(resolved);
}

function numberFrom(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function bashModeFrom(value: string | undefined): BashMode {
  if (value === "off" || value === "safe" || value === "full") return value;
  return "safe";
}

function bashTranscriptFrom(value: string | undefined): BashTranscriptMode {
  if (value === "compact" || value === "full") return value;
  return "compact";
}

function codexSessionsFrom(value: string | undefined): CodexSessionsMode {
  if (value === "metadata" || value === "read") return value;
  if (value === "1" || value === "true" || value === "yes" || value === "on") return "metadata";
  return "off";
}

function bashSessionIdFrom(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(trimmed)) {
    throw new Error("CODEXBRIDGE_BASH_SESSION_ID must be 1-64 characters using letters, numbers, dot, underscore, or dash, and must start with a letter or number.");
  }
  return trimmed;
}

function writeModeFrom(value: string | undefined): WriteMode {
  if (value === "off" || value === "handoff" || value === "workspace") return value;
  return "workspace";
}

function toolModeFrom(value: string | undefined): ToolMode {
  if (value === "minimal" || value === "standard" || value === "full") return value;
  return "standard";
}

function widgetDomainFrom(value: string | undefined): string {
  const raw = value?.trim() || "https://naplesblue.github.io";
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`CODEXBRIDGE_WIDGET_DOMAIN must be a valid origin URL, got: ${raw}`);
  }
  if (parsed.protocol !== "https:") {
    throw new Error("CODEXBRIDGE_WIDGET_DOMAIN must use https.");
  }
  if (parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error("CODEXBRIDGE_WIDGET_DOMAIN must be an origin only, for example https://widgets.example.com.");
  }
  return parsed.origin;
}

function boolFrom(value: string | undefined, fallback = false): boolean {
  if (value === undefined) return fallback;
  return ["1", "true", "yes", "y", "on"].includes(value.toLowerCase());
}

function envValue(...names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name];
    if (value !== undefined) return value;
  }
  return undefined;
}

function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

export function loadConfig(argv = process.argv.slice(2)): CodexBridgeConfig {
  const args = parseArgs(argv);

  const rootFromArgs = typeof args.root === "string" ? args.root : undefined;
  const root = rootFromArgs ?? envValue("CODEXBRIDGE_ROOT", "CODEXPRO_ROOT", "CODEBASE_BRIDGE_REPO_ROOT") ?? process.cwd();
  const defaultRoot = toRealDir(root);

  const allowRootArgs = Array.isArray(args["allow-root"])
    ? args["allow-root"]
    : typeof args["allow-root"] === "string"
      ? [args["allow-root"]]
      : [];
  const envAllowedRoots = [
    ...splitRoots(process.env.CODEXBRIDGE_ALLOWED_ROOTS),
    ...splitRoots(process.env.CODEXPRO_ALLOWED_ROOTS),
    ...splitRoots(process.env.CODEBASE_BRIDGE_ALLOWED_ROOTS)
  ];

  const allowHome = envValue("CODEXBRIDGE_ALLOW_HOME", "CODEXPRO_ALLOW_HOME") === "1" || args["allow-home"] === true;
  const requestedAllowed = [defaultRoot, ...allowRootArgs, ...envAllowedRoots, ...(allowHome ? [os.homedir()] : [])];
  const allowedRoots = [...new Set(requestedAllowed.map(toRealDir))];

  const portArg = typeof args.port === "string" ? args.port : undefined;
  const hostArg = typeof args.host === "string" ? args.host : undefined;
  const bashArg = typeof args.bash === "string" ? args.bash : undefined;
  const bashTranscriptArg = typeof args["bash-transcript"] === "string" ? args["bash-transcript"] : undefined;
  const bashSessionArg = typeof args["bash-session"] === "string" ? args["bash-session"] : undefined;
  const codexSessionsArg = typeof args["codex-sessions"] === "string" ? args["codex-sessions"] : undefined;
  const codexDirArg = typeof args["codex-dir"] === "string" ? args["codex-dir"] : undefined;
  const requireBashSessionArg =
    args["require-bash-session"] === true
      ? "true"
      : typeof args["require-bash-session"] === "string"
        ? args["require-bash-session"]
        : undefined;
  const writeArg = typeof args.write === "string" ? args.write : undefined;
  const toolModeArg = typeof args["tool-mode"] === "string" ? args["tool-mode"] : undefined;
  const widgetDomainArg = typeof args["widget-domain"] === "string" ? args["widget-domain"] : undefined;
  const extraBlockedGlobs = splitList(envValue("CODEXBRIDGE_BLOCKED_GLOBS", "CODEXPRO_BLOCKED_GLOBS"), ",");
  const host = hostArg ?? process.env.HOST ?? envValue("CODEXBRIDGE_HOST", "CODEXPRO_HOST") ?? "127.0.0.1";
  const authToken = envValue("CODEXBRIDGE_HTTP_TOKEN", "CODEXPRO_HTTP_TOKEN", "CODEBASE_BRIDGE_HTTP_TOKEN");
  const allowNoToken = boolFrom(envValue("CODEXBRIDGE_ALLOW_NO_HTTP_TOKEN", "CODEXPRO_ALLOW_NO_HTTP_TOKEN"), false);
  const requireHttpToken =
    boolFrom(envValue("CODEXBRIDGE_REQUIRE_HTTP_TOKEN", "CODEXPRO_REQUIRE_HTTP_TOKEN"), false) ||
    boolFrom(envValue("CODEXBRIDGE_TUNNEL_MODE", "CODEXPRO_TUNNEL_MODE"), false) ||
    (!isLoopbackHost(host) && !allowNoToken);
  const bashSessionId = bashSessionIdFrom(bashSessionArg ?? envValue("CODEXBRIDGE_BASH_SESSION_ID", "CODEXPRO_BASH_SESSION_ID"));
  const requireBashSession = boolFrom(requireBashSessionArg ?? envValue("CODEXBRIDGE_REQUIRE_BASH_SESSION", "CODEXPRO_REQUIRE_BASH_SESSION"), false);
  if (requireBashSession && !bashSessionId) {
    throw new Error("CODEXBRIDGE_REQUIRE_BASH_SESSION requires CODEXBRIDGE_BASH_SESSION_ID or --bash-session.");
  }

  return {
    defaultRoot,
    allowedRoots,
    host,
    port: numberFrom(portArg ?? process.env.PORT ?? envValue("CODEXBRIDGE_PORT", "CODEXPRO_PORT"), 8787, 1, 65535),
    widgetDomain: widgetDomainFrom(widgetDomainArg ?? envValue("CODEXBRIDGE_WIDGET_DOMAIN", "CODEXPRO_WIDGET_DOMAIN")),
    authToken,
    requireHttpToken,
    bashMode: bashModeFrom(bashArg ?? envValue("CODEXBRIDGE_BASH_MODE", "CODEXPRO_BASH_MODE")),
    bashTranscript: bashTranscriptFrom(bashTranscriptArg ?? envValue("CODEXBRIDGE_BASH_TRANSCRIPT", "CODEXPRO_BASH_TRANSCRIPT")),
    bashSessionId,
    requireBashSession,
    codexSessions: codexSessionsFrom(codexSessionsArg ?? envValue("CODEXBRIDGE_CODEX_SESSIONS", "CODEXPRO_CODEX_SESSIONS")),
    codexDir: expandHome(codexDirArg || envValue("CODEXBRIDGE_CODEX_DIR", "CODEXPRO_CODEX_DIR") || path.join(os.homedir(), ".codex")),
    writeMode: writeModeFrom(writeArg ?? envValue("CODEXBRIDGE_WRITE_MODE", "CODEXPRO_WRITE_MODE")),
    toolMode: toolModeFrom(toolModeArg ?? envValue("CODEXBRIDGE_TOOL_MODE", "CODEXPRO_TOOL_MODE")),
    inheritEnv: envValue("CODEXBRIDGE_INHERIT_ENV", "CODEXPRO_INHERIT_ENV") === "1",
    maxReadBytes: numberFrom(envValue("CODEXBRIDGE_MAX_READ_BYTES", "CODEXPRO_MAX_READ_BYTES"), 180_000, 4_000, 2_000_000),
    maxWriteBytes: numberFrom(envValue("CODEXBRIDGE_MAX_WRITE_BYTES", "CODEXPRO_MAX_WRITE_BYTES"), 1_000_000, 1_000, 10_000_000),
    maxOutputBytes: numberFrom(envValue("CODEXBRIDGE_MAX_OUTPUT_BYTES", "CODEXPRO_MAX_OUTPUT_BYTES"), 120_000, 4_000, 2_000_000),
    maxSearchResults: numberFrom(envValue("CODEXBRIDGE_MAX_SEARCH_RESULTS", "CODEXPRO_MAX_SEARCH_RESULTS"), 200, 5, 2_000),
    maxJournalEvents: numberFrom(envValue("CODEXBRIDGE_MAX_JOURNAL_EVENTS", "CODEXPRO_MAX_JOURNAL_EVENTS"), 200, 10, 5_000),
    maxHttpSessions: numberFrom(envValue("CODEXBRIDGE_MAX_HTTP_SESSIONS", "CODEXPRO_MAX_HTTP_SESSIONS"), 64, 1, 512),
    httpSessionTtlMs: numberFrom(envValue("CODEXBRIDGE_HTTP_SESSION_TTL_MS", "CODEXPRO_HTTP_SESSION_TTL_MS"), 30 * 60_000, 60_000, 24 * 60 * 60_000),
    blockedGlobs: [...DEFAULT_BLOCKED_GLOBS, ...extraBlockedGlobs],
    contextDir: envValue("CODEXBRIDGE_CONTEXT_DIR", "CODEXPRO_CONTEXT_DIR") ?? ".ai-bridge"
  };
}
