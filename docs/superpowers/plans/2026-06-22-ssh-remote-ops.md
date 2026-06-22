# SSH Remote Ops Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a bounded SSH execution MVP so ChatGPT can help with small remote operations through configured profiles when Codex quota is unavailable.

**Architecture:** SSH profiles are configured with `CODEXBRIDGE_SSH_PROFILES` JSON and exposed through read-only `ssh_profiles`. `ssh_exec` builds a non-interactive `ssh` invocation, applies a dedicated safe/full/off remote command policy, truncates and redacts output, supports dry-run previews, and journals actual executions. This stage does not support passwords, sudo prompts, interactive shells, scp/rsync, or remote file transfer.

**Tech Stack:** TypeScript MCP server, Node.js child_process, existing policy/journal/output-redaction patterns, smoke tests.

---

### Task 1: Red Tests For SSH Tool Surface

**Files:**
- Modify: `scripts/smoke.mjs`

- [x] Assert `server_config` exposes `sshMode`.
- [x] Assert full tool mode includes `ssh_profiles` and `ssh_exec`.
- [x] Assert `ssh_profiles` returns redacted configured profile metadata.
- [x] Assert `ssh_exec` dry-run returns an SSH argv preview without executing network calls.
- [x] Assert safe mode blocks dangerous remote commands such as `sudo reboot`.

### Task 2: Config And Policy

**Files:**
- Modify: `src/config.ts`
- Modify: `src/policy.ts`

- [x] Add `SshMode = "off" | "safe" | "full"`.
- [x] Parse `CODEXBRIDGE_SSH_MODE`, defaulting to `safe`.
- [x] Parse `CODEXBRIDGE_SSH_PROFILES` as a JSON object keyed by profile name.
- [x] Add `decideSshCommandPolicy()` with remote-safe allowlist and high-risk denials.

### Task 3: SSH Operations Module

**Files:**
- Create: `src/sshOps.ts`

- [x] Resolve named profile and optional command workdir.
- [x] Validate profile names, host, user, port, identity file, and workdir.
- [x] Build `ssh` argv with batch mode, strict host key behavior, optional identity, port, user, and remote command.
- [x] Implement dry-run output.
- [x] Implement actual non-interactive execution with timeout, bounded output, and redaction.

### Task 4: Server Wiring

**Files:**
- Modify: `src/server.ts`
- Modify: `src/toolCardWidget.ts` if needed

- [x] Register `ssh_profiles` as read-only.
- [x] Register `ssh_exec` as a remote execution tool with journal events for actual runs.
- [x] Include SSH tools in full tool mode and keep them hidden in minimal mode.
- [x] Include `sshMode` in `server_config`.

### Task 5: Verification

**Commands:**
- `npm run build`
- `node scripts/smoke.mjs`
- `npm run smoke`
- `git diff --check`

- [x] Commit after verification passes.
