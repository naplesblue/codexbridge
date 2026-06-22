import type { CodexBridgeConfig, DesktopMode, SshMode } from "./config.js";

export type DesktopTargetType = "url" | "workspace_path" | "app";

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

const SSH_SAFE_ALLOWED_PREFIXES = [
  "pwd",
  "hostname",
  "whoami",
  "uptime",
  "date",
  "df -h",
  "free -m",
  "git status",
  "git diff",
  "git log",
  "git rev-parse",
  "git branch",
  "docker ps",
  "docker logs",
  "systemctl status",
  "systemctl is-active",
  "systemctl is-enabled",
  "journalctl -u"
];

const SSH_BLOCKED_PATTERNS = [
  /(^|\s)sudo\b/,
  /(^|\s)su\b/,
  /(^|\s)reboot\b/,
  /(^|\s)shutdown\b/,
  /(^|\s)halt\b/,
  /(^|\s)poweroff\b/,
  /(^|\s)rm\s+/,
  /(^|\s)mv\s+/,
  /(^|\s)cp\s+/,
  /(^|\s)dd\s+/,
  /(^|\s)chmod\s+/,
  /(^|\s)chown\s+/,
  /(^|\s)kill\s+/,
  /(^|\s)pkill\s+/,
  /(^|\s)curl\s+/,
  /(^|\s)wget\s+/,
  /(^|\s)ssh\s+/,
  /(^|\s)scp\s+/,
  /(^|\s)rsync\s+/,
  /(^|\s)docker\s+(?:rm|rmi|stop|restart|kill|exec|compose|system|volume|network)\b/,
  /(^|\s)systemctl\s+(?:start|stop|restart|reload|enable|disable|mask|unmask)\b/,
  /(^|\s)journalctl\b.*(?:--vacuum|-f|--follow)\b/,
  /[;&|<>`]/,
  /\$\(/,
  /\n/
];

function startsWithAllowedSshPrefix(command: string): boolean {
  const normalized = compact(command);
  return SSH_SAFE_ALLOWED_PREFIXES.some((prefix) => normalized === prefix || normalized.startsWith(`${prefix} `));
}

export function decideSshCommandPolicy(mode: SshMode, command: string): PolicyDecision {
  const normalized = compact(command);
  if (!normalized) {
    return {
      decision: "deny",
      reason: "SSH command is required.",
      category: "ssh-command-empty",
      risk: "low"
    };
  }
  if (mode === "off") {
    return {
      decision: "deny",
      reason: "SSH execution is disabled. Start with CODEXBRIDGE_SSH_MODE=safe or CODEXBRIDGE_SSH_MODE=full to enable it.",
      category: "ssh-disabled",
      risk: "low"
    };
  }
  for (const pattern of SSH_BLOCKED_PATTERNS) {
    if (pattern.test(normalized)) {
      return {
        decision: mode === "full" ? "ask" : "deny",
        reason:
          `Remote command is blocked in CODEXBRIDGE_SSH_MODE=${mode}: ${normalized}\n` +
          "Use safe status/log commands, or rerun only after explicit user approval in full SSH mode.",
        category: "ssh-blocked-command",
        risk: "high"
      };
    }
  }
  if (mode === "full") {
    return {
      decision: "allow",
      reason: "full SSH mode allows non-interactive remote commands for trusted hosts.",
      category: "ssh-full",
      risk: "high"
    };
  }
  if (!startsWithAllowedSshPrefix(normalized)) {
    return {
      decision: "deny",
      reason:
        `Remote command is not in the SSH safe allowlist: ${normalized}\n` +
        "Allowed examples: pwd, hostname, uptime, df -h, free -m, git status, docker ps, docker logs --tail, systemctl status, journalctl -u service -n 100 --no-pager.",
      category: "ssh-unlisted-command",
      risk: "medium"
    };
  }
  return {
    decision: "allow",
    reason: "Remote command matches the SSH safe allowlist.",
    category: "ssh-safe-command",
    risk: "low"
  };
}

const DESKTOP_ALLOWED_URL_SCHEMES = ["http://", "https://"];
const DESKTOP_BLOCKED_URL_SCHEMES = ["javascript:", "data:", "vbscript:", "file:"];

export function decideDesktopOpenPolicy(
  mode: DesktopMode,
  targetType: DesktopTargetType,
  target: string,
  options: { appAllowlist?: string[] } = {}
): PolicyDecision {
  const value = target.trim();
  if (!value) {
    return {
      decision: "deny",
      reason: "desktop_open target is required.",
      category: "desktop-empty",
      risk: "low"
    };
  }
  if (mode === "off") {
    return {
      decision: "deny",
      reason: "Desktop open is disabled. Start with CODEXBRIDGE_DESKTOP_MODE=safe or CODEXBRIDGE_DESKTOP_MODE=full to enable it.",
      category: "desktop-disabled",
      risk: "low"
    };
  }

  if (targetType === "url") {
    const lower = value.toLowerCase();
    const scheme = lower.includes(":") ? `${lower.slice(0, lower.indexOf(":"))}:` : value;
    if (mode === "safe") {
      if (!DESKTOP_ALLOWED_URL_SCHEMES.some((allowed) => lower.startsWith(allowed))) {
        return {
          decision: "deny",
          reason:
            `URL scheme is blocked in CODEXBRIDGE_DESKTOP_MODE=safe: ${scheme}\n` +
            "Only http and https URLs are allowed in safe desktop mode.",
          category: "desktop-url-scheme",
          risk: "high"
        };
      }
    } else if (DESKTOP_BLOCKED_URL_SCHEMES.some((blocked) => lower.startsWith(blocked))) {
      return {
        decision: "ask",
        reason: `URL scheme ${scheme} requires explicit user approval even in full desktop mode.`,
        category: "desktop-url-scheme",
        risk: "high"
      };
    }
    return {
      decision: "allow",
      reason: "URL open is within desktop policy.",
      category: "desktop-url",
      risk: mode === "full" ? "medium" : "low"
    };
  }

  if (targetType === "app") {
    if (mode === "full") {
      return {
        decision: "allow",
        reason: "full desktop mode allows launching any app.",
        category: "desktop-app-full",
        risk: "high"
      };
    }
    const allowlist = options.appAllowlist ?? [];
    const allowed = allowlist.some((app) => app.toLowerCase() === value.toLowerCase());
    if (!allowed) {
      return {
        decision: "deny",
        reason:
          `App is not in the desktop allowlist: ${value}\n` +
          "Add it to CODEXBRIDGE_DESKTOP_APPS to allow launching it in safe desktop mode.",
        category: "desktop-app-unlisted",
        risk: "medium"
      };
    }
    return {
      decision: "allow",
      reason: "App matches the desktop allowlist.",
      category: "desktop-app",
      risk: "low"
    };
  }

  // workspace_path: path resolution and workspace guarding are enforced by the caller.
  if (/[\n\r;&|<>`$]/.test(value)) {
    return {
      decision: "deny",
      reason: "Workspace path contains unsupported shell metacharacters.",
      category: "desktop-path",
      risk: "medium"
    };
  }
  return {
    decision: "allow",
    reason:
      mode === "full"
        ? "full desktop mode allows opening workspace files."
        : "Workspace file open is within desktop policy.",
    category: "desktop-path",
    risk: mode === "full" ? "medium" : "low"
  };
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
