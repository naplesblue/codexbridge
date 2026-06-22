# CodexBridge Independence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove remaining CodexPro compatibility surfaces so CodexBridge stands as an independent project.

**Architecture:** Rename project-owned public APIs, structured result fields, widget identifiers, internal TypeScript names, CLI scripts, environment variables, and tests to CodexBridge. Keep names that refer to the OpenAI Codex product or local Codex sessions, such as `codex_context`, `handoff_to_codex`, and `codexSessions`.

**Tech Stack:** TypeScript MCP server, Node.js CLI scripts, package metadata, existing smoke scripts.

---

### Task 1: Red Tests For Independent Public Surface

**Files:**
- Modify: `scripts/smoke.mjs`
- Modify: `scripts/http-smoke.mjs`
- Modify: `scripts/settings-smoke.mjs`
- Modify: `scripts/execute-handoff-smoke.mjs`

- [x] Assert package bins no longer include `codexpro`, `codexpro-mcp`, or `codexpro-mcp-http`.
- [x] Assert primary diagnostic tools are `codexbridge_self_test` and `codexbridge_inventory`.
- [x] Assert structured widget fields use `codexbridge_tool`.
- [x] Assert widget URI uses `ui://widget/codexbridge-tool-card-v1.html`.
- [x] Assert smoke scripts call `scripts/codexbridge.mjs` only.

### Task 2: Runtime Rename And Compatibility Removal

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Delete: `scripts/codexpro.mjs`
- Modify: `src/config.ts`
- Modify: `src/guard.ts`
- Modify: `src/server.ts`
- Modify: `src/http.ts`
- Modify: `src/toolCardWidget.ts`
- Modify: `src/capabilitiesOps.ts`
- Modify: all `src/*.ts` imports that reference `CodexProConfig` or `CodexProError`

- [x] Rename `CodexProConfig` to `CodexBridgeConfig`.
- [x] Rename `CodexProError` to `CodexBridgeError`.
- [x] Rename `createCodexProServer` to `createCodexBridgeServer`.
- [x] Rename `codexproInventory` to `codexbridgeInventory`.
- [x] Remove `CODEXPRO_*` environment fallbacks.
- [x] Remove `codexpro_token` query parameter support.
- [x] Remove `codexpro` package bin aliases and wrapper script.

### Task 3: User-Facing Cleanup

**Files:**
- Modify: `README.md`
- Modify: `README_ZH.md`
- Modify: `docs/superpowers/plans/2026-06-22-codexbridge-localization.md`
- Modify: generated prompts and docs as needed

- [x] Keep only attribution text that says CodexBridge began as a CodexPro fork.
- [x] Remove compatibility instructions for `codexpro`, `CODEXPRO_*`, `codexpro_token`, and `~/.codexpro`.
- [x] Keep Codex product references intact where they describe Codex sessions or handoff.

### Task 4: Verification

**Commands:**
- `npm run build`
- `npm run smoke`
- `git diff --check`
- `rg -n "CodexPro|codexpro|CODEXPRO|codexpro_token|codexpro_|CodexProConfig|CodexProError|createCodexProServer" src scripts package.json README.md README_ZH.md FAQ.md FAQ_ZH.md SECURITY.md config.example.env docs`

- [x] Confirm only intended attribution and historical plan references remain.
- [x] Commit after verification passes.
