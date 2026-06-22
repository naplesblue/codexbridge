import type { CodexBridgeConfig } from "./config.js";

export type PolicyDecisionKind = "allow" | "ask" | "deny";
export type PolicyRisk = "low" | "medium" | "high";

export interface PolicyDecision {
  decision: PolicyDecisionKind;
  reason: string;
  category: string;
  risk: PolicyRisk;
}

export interface WritePolicyOptions {
  overwrite?: boolean;
  createDirs?: boolean;
  operation?: "write" | "edit" | "change_set";
}

const SAFE_ALLOWED_PREFIXES = [
  "pwd",
  "ls",
  "find",
  "git status",
  "git diff",
  "git log",
  "git show",
  "git branch",
  "git rev-parse",
  "git ls-files",
  "npm test",
  "npm run test",
  "npm run typecheck",
  "npm run lint",
  "npm run build",
  "npm run check",
  "pnpm test",
  "pnpm run test",
  "pnpm run typecheck",
  "pnpm run lint",
  "pnpm run build",
  "pnpm run check",
  "yarn test",
  "yarn run test",
  "yarn run typecheck",
  "yarn run lint",
  "yarn run build",
  "yarn run check",
  "bun test",
  "bun run test",
  "bun run typecheck",
  "bun run lint",
  "bun run build",
  "pytest",
  "python -m pytest",
  "python3 -m pytest",
  "uv run pytest",
  "go test",
  "cargo test",
  "cargo check",
  "cargo clippy",
  "tsc",
  "npx tsc",
  "eslint",
  "npx eslint",
  "biome check",
  "npx biome check"
];

const SAFE_BLOCKED_PATTERNS = [
  /(^|\s)rm\s+/,
  /(^|\s)mv\s+/,
  /(^|\s)cp\s+/,
  /(^|\s)dd\s+/,
  /(^|\s)sudo\s+/,
  /(^|\s)chmod\s+/,
  /(^|\s)chown\s+/,
  /(^|\s)kill\s+/,
  /(^|\s)pkill\s+/,
  /(^|\s)curl\s+/,
  /(^|\s)wget\s+/,
  /(^|\s)ssh\s+/,
  /(^|\s)scp\s+/,
  /(^|\s)rsync\s+/,
  /(^|\s)docker\s+/,
  /(^|\s)podman\s+/,
  /(^|\s)git\s+push\b/,
  /(^|\s)git\s+reset\b/,
  /(^|\s)git\s+clean\b/,
  /(^|\s)git\s+checkout\b/,
  /(^|\s)git\s+switch\b/,
  /(^|\s)git\s+restore\b/,
  /(^|\s)(npm|pnpm|yarn)\s+publish\b/,
  /(^|\s)--no-index\b/,
  /(^|\s)--fix\b/,
  /(^|\s)(\/|~(?:\/|\s|$))/,
  /(^|\s)\.\.(?:\/|\s|$)/,
  /\$(?:[A-Za-z_][A-Za-z0-9_]*|\{|\[)/,
  /(^|[\s:])(?:\.env(?:[./\s:]|$)|\.git(?:[\/\s:]|$)|node_modules(?:[\/\s:]|$)|\.ssh(?:[\/\s:]|$)|id_rsa(?:[.\s:]|$)|id_ed25519(?:[.\s:]|$)|[^\s:]*\.(?:pem|key)(?:[\s:]|$))/,
  /(^|\s)-exec\b/,
  /(^|\s)-execdir\b/,
  /(^|\s)-delete\b/,
  /(^|\s)-ok\b/,
  /(^|\s)-okdir\b/,
  /(^|\s)-fprint\b/,
  /(^|\s)-fprintf\b/,
  /(^|\s)-fls\b/,
  /(^|\s)(sed|perl)\s+.*(^|\s)-i(\s|$)/,
  /(^|\s)(cat|grep|rg|head|tail|wc)\s+/,
  /[;&|<>`]/,
  /\$\(/,
  /\n/
];

function compact(command: string): string {
  return command.trim().replace(/\s+/g, " ");
}

function isAllowedPackageScript(command: string): boolean {
  const packageScriptPattern =
    /^(?:npm|pnpm|yarn|bun)\s+run\s+(?:test|typecheck|lint|build|check)(?::[A-Za-z0-9._-]+)*(?:\s+--\s+[A-Za-z0-9._:= -]+)?$/;
  return packageScriptPattern.test(command);
}

function startsWithAllowedPrefix(command: string): boolean {
  const normalized = compact(command);
  return isAllowedPackageScript(normalized) || SAFE_ALLOWED_PREFIXES.some((prefix) => normalized === prefix || normalized.startsWith(`${prefix} `));
}

export function decideCommandPolicy(config: CodexBridgeConfig, command: string): PolicyDecision {
  const normalized = compact(command);
  if (config.bashMode === "off") {
    return {
      decision: "deny",
      reason: "bash tool is disabled. Start with CODEXBRIDGE_BASH_MODE=safe or CODEXBRIDGE_BASH_MODE=full to enable it.",
      category: "bash-disabled",
      risk: "low"
    };
  }
  if (config.bashMode === "full") {
    return {
      decision: "allow",
      reason: "full bash mode allows arbitrary local commands for trusted repositories.",
      category: "full-bash",
      risk: "high"
    };
  }

  for (const pattern of SAFE_BLOCKED_PATTERNS) {
    if (pattern.test(normalized)) {
      return {
        decision: "deny",
        reason:
          `Command is blocked in CODEXBRIDGE_BASH_MODE=safe: ${normalized}\n` +
          "Use separate read/search/git tools, or restart with CODEXBRIDGE_BASH_MODE=full only for trusted repos.",
        category: "blocked-command",
        risk: "high"
      };
    }
  }

  if (!startsWithAllowedPrefix(normalized)) {
    return {
      decision: "deny",
      reason:
        `Command is not in the safe bash allowlist: ${normalized}\n` +
        "Allowed examples: ls, find, git status, git diff, npm test, npm run typecheck, npm run build:clients, pytest, go test, cargo test. Use read/search tools for file contents. " +
        "Use CODEXBRIDGE_BASH_MODE=full for trusted local automation.",
      category: "unlisted-command",
      risk: "medium"
    };
  }

  return {
    decision: "allow",
    reason: "Command matches the safe bash allowlist.",
    category: "safe-command",
    risk: "low"
  };
}

export function decideWritePolicy(
  config: CodexBridgeConfig,
  relPath: string,
  bytes: number,
  options: WritePolicyOptions = {}
): PolicyDecision {
  if (bytes > config.maxWriteBytes) {
    return {
      decision: "deny",
      reason: `Write content is too large (${bytes} bytes). Limit: ${config.maxWriteBytes} bytes.`,
      category: "write-size",
      risk: "medium"
    };
  }

  const operation = options.operation ?? "write";
  const risk: PolicyRisk = operation === "change_set" ? "medium" : "low";
  return {
    decision: "allow",
    reason: `${operation} is within workspace policy for ${relPath}.`,
    category: operation,
    risk
  };
}
