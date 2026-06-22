# Security Policy

CodexBridge exposes a local workspace to an MCP client. Treat it like a developer tool with access to your source tree, not like a hosted SaaS app.

## Supported Version

Security fixes target the latest published version only until the project reaches `1.0.0`.

## Reporting

Please report security issues privately before opening a public issue. If the repository has GitHub private vulnerability reporting enabled, use that. Otherwise contact the maintainer listed by the project owner.

Do not include secrets, private repository contents, tunnel tokens, or `.env` values in reports.

## Terms Boundary

CodexBridge is not designed to bypass, avoid, pool, resell, or modify ChatGPT, Codex, OpenAI, or third-party model limits. Do not market, deploy, or configure it that way.

Each user should connect their own ChatGPT account, use only product surfaces available to that account, and follow the limits, safety rules, and terms for ChatGPT, Codex, OpenAI, and any third-party model provider they connect.

## Threat Model

CodexBridge can expose:

- file metadata and selected file contents from allowed workspaces
- git status and diffs
- `.ai-bridge` planning files
- optional shell command execution through the `bash` tool
- optional write/edit capability depending on `CODEXBRIDGE_WRITE_MODE`
- optional local handoff execution through `codexbridge execute-handoff`, run from the user's terminal only

The main risks are:

- connecting an untrusted MCP client
- exposing the server through a public tunnel without auth
- running with `CODEXBRIDGE_BASH_MODE=full`
- running remote commands with `CODEXBRIDGE_SSH_MODE=full`
- running with `CODEXBRIDGE_WRITE_MODE=workspace` on an important repo
- executing an untrusted `.ai-bridge/current-plan.md` or custom `execute-handoff --command`
- adding overly broad allowed roots
- leaking a `codexbridge_token` or Cloudflare tunnel token
- trusting a downloaded `cloudflared` binary without understanding where it came from

## Safer Defaults

Default daily mode:

```bash
codexbridge start \
  --root /path/to/repo \
  --bash safe \
  --tunnel cloudflare
```

Safer planning-only mode:

```bash
codexbridge start \
  --root /path/to/repo \
  --mode handoff \
  --bash safe \
  --tunnel cloudflare
```

For stable public hostnames, keep the CodexBridge auth token stable but private:

```bash
codexbridge start \
  --root /path/to/repo \
  --tunnel cloudflare-named \
  --hostname codexbridge.example.com \
  --tunnel-name codexbridge \
  --token <long-random-token> \
  --bash safe
```

## Hard Rules

- Do not run public tunnels with `--no-auth`.
- Public tunnel mode and non-loopback binds fail closed if `CODEXBRIDGE_HTTP_TOKEN` is missing.
- Do not commit printed connector URLs that include `codexbridge_token`.
- Do not commit Cloudflare tunnel tokens.
- Do not paste raw Cloudflare tunnel tokens into browser pages or screenshots. Use `--cloudflare-token-file` or the local page's Cloudflare token file field instead.
- Use `--mode handoff` for planning workflows where ChatGPT should not edit source files.
- Preview local handoff execution with `codexbridge execute-handoff --dry-run` before running an unfamiliar adapter or custom command.
- Keep `execute-handoff` local. Do not wrap it in a remote MCP tool unless you add a stronger approval and sandbox story.
- Use SSH profiles only for hosts you control. Run `ssh_exec` with `dry_run: true` first, keep `CODEXBRIDGE_SSH_MODE=safe` by default, and do not rely on CodexBridge to handle passwords, sudo prompts, or interactive remote shells.
- Use `task_brief`, `task_plan`, and `approval_review` for Codex-quota fallback work so ChatGPT sees explicit repo context, command policy, and local-write approval scope before applying changes.
- Treat `preview_rollback_change_set` as a review aid for exact edit changes, not as a substitute for git history or backups.
- Use default agent mode only with trusted ChatGPT sessions and repo-specific roots.
- Use `--no-bash` when ChatGPT should never trigger shell commands in the workspace.
- Use `--bash-session <id> --require-bash-session` when bash should be enabled only for calls that explicitly target this local CodexBridge terminal label.
- Keep Codex session history access off unless needed. `--codex-sessions metadata` only lists local Codex JSONL metadata; `--codex-sessions read` allows bounded transcript reads.
- Use `--bash full` only for trusted local repos.
- Do not treat MCP session ids or bash session labels as Codex conversation ids. CodexBridge does not execute inside a Codex app session.
- Prefer a repo-specific `--root` instead of `--allow-home`.
- Use `--no-install-cloudflared --cloudflared <path>` if your organization requires a managed Cloudflare Tunnel binary.

## Cloudflare Binary Install

For the one-command public tunnel flow, CodexBridge can download the official Cloudflare `cloudflared` release into `~/.codexbridge/bin` on supported macOS, Windows, and Linux systems. It does not install a system service, does not use sudo/admin rights, and does not modify shell startup files.

Resolution order:

```text
1. explicit --cloudflared path or CLOUDFLARED_BIN
2. cloudflared already available in PATH
3. ~/.codexbridge/bin/cloudflared or cloudflared.exe
4. download official Cloudflare latest release unless --no-install-cloudflared is set
```

Use `--install-cloudflared` to refresh the local binary. Use `--no-install-cloudflared` to disable downloads.

## Built-In Guards

CodexBridge blocks common sensitive paths by default:

- `.env` and `.env.*`
- `.git` internals
- `node_modules`
- common private key names
- build/cache folders such as `dist`, `build`, `.next`, `coverage`, `.cache`
- symlinks that resolve outside the workspace or into blocked paths
- safe bash commands through a shared command policy; unlisted, destructive, network, shell-expansion, and file-reader commands are denied by default
- transactional change sets with preview, base-hash validation, and rollback for files already written if a later write fails
- a bounded `.ai-bridge/operation-journal.jsonl` audit trail for successful write/edit/bash/change-set operations
- Task records (`.ai-bridge/current-task.json` and `.ai-bridge/tasks/`) store the goal and plan you give `task_plan`. They are written through the same path guard as the operation journal and never leave the workspace; do not put secrets in task goals or plan steps.

These guards reduce risk. They are not an OS sandbox.
