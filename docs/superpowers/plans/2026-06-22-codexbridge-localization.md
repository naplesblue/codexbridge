# CodexBridge First-Phase Localization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rename the externally visible project surface from CodexPro to CodexBridge while preserving short-term CodexPro compatibility.

**Architecture:** Keep core TypeScript internals stable in this phase. Add CodexBridge-facing package/bin/script/env/token/profile names, keep CodexPro aliases, and update smoke coverage and docs so users see CodexBridge as the primary project.

**Tech Stack:** TypeScript MCP server, Node.js CLI scripts, package.json bin aliases, existing smoke scripts.

---

### Task 1: Smoke Coverage For External Names

**Files:**
- Modify: `scripts/smoke.mjs`
- Modify: `scripts/settings-smoke.mjs`
- Modify: `scripts/http-smoke.mjs`

- [x] Assert the package exposes `codexbridge`, `codexbridge-mcp`, and `codexbridge-mcp-http` bins while keeping CodexPro aliases.
- [x] Assert `CODEXBRIDGE_*` environment variables work for root, allowed roots, widget domain, and HTTP token paths where the existing smoke suite uses `CODEXPRO_*`.
- [x] Assert profile/settings output can read and write CodexBridge config paths while old CodexPro config remains compatible.

### Task 2: CLI And Runtime Compatibility

**Files:**
- Move: `scripts/codexpro.mjs` to `scripts/codexbridge.mjs`
- Add: `scripts/codexpro.mjs`
- Modify: `package.json`
- Modify: `src/config.ts`
- Modify: `src/http.ts`

- [x] Make `codexbridge` the primary package bin and keep `codexpro` as a wrapper alias.
- [x] Read `CODEXBRIDGE_*` env vars first, then fall back to `CODEXPRO_*`.
- [x] Prefer `codexbridge_token` in generated URLs while accepting `codexpro_token`.
- [x] Prefer `~/.codexbridge` for local CLI data, with fallback reads from `~/.codexpro`.

### Task 3: Docs And Low-Risk Structure Cleanup

**Files:**
- Modify: `README.md`
- Modify: `README_ZH.md`
- Modify: `SECURITY.md`
- Modify: `docs/index.html`
- Modify: `docs/zh.html`
- Modify: smoke scripts as needed

- [x] Update public-facing product name, install commands, setup commands, token names, and local data path references to CodexBridge.
- [x] Keep an attribution note that the project began as a CodexPro fork.
- [x] Leave internal TypeScript class/function names and MCP tool names for a later compatibility-focused phase.

### Task 4: Verification

**Commands:**
- `npm run build`
- `node scripts/smoke.mjs`
- `npm run smoke`
- `git diff --check`

- [ ] Run all commands fresh and inspect output.
- [ ] Commit only after verification passes.
