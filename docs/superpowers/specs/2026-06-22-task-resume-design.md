# Task Resume Layer (Phase 4) — Design

## Context

CodexBridge exists so that, when OpenAI's Codex quota runs out mid-task, ChatGPT can
continue the work as a lightweight local coding agent. The roadmap's Phase 4 ("task-level
journal / resume") was deferred behind SSH (Phase 5) and Computer Use (Phase 6), both now
shipped. Phase 4 is the highest-ROI remaining item because it directly serves the project's
core failure mode: a session dying part-way through a multi-step task.

Today the task workflow tools (`task_brief` / `task_plan` / `task_verify` / `task_report`)
are **completely stateless**. `buildTaskPlan` returns a hard-coded recommended-workflow list
and policy checks; nothing persists the goal, the agent's actual plan, or progress. The
operation journal (`.ai-bridge/operation-journal.jsonl`) records per-operation events but has
no notion of a task. So a fresh ChatGPT session has no way to learn what task was underway,
what the plan was, or how far it got.

This design adds a minimal durable task record and a resume path, reusing the existing
PathGuard / policy / journal primitives rather than adding a parallel system.

## Goals / Non-goals

**Goals**
- A new ChatGPT session can discover an in-progress task and continue it without the prior
  conversation context.
- Persist the agent's real goal and plan across sessions and server restarts (on disk).
- Add the smallest possible tool surface (one new tool; extend two existing tools).

**Non-goals (deliberate YAGNI for "lightweight")**
- Multiple concurrent tasks per workspace.
- Exact per-step completion state machine / step-level resume.
- Tagging every journal event with a task id.
- Archived-task browsing / pruning UI.

## Key decisions (settled during brainstorming)

1. **Derived progress, not stored progress.** The task record stores goal + plan + metadata;
   "what is already done / what is left" is re-derived at resume time from `git status/diff`
   plus the operation journal. No per-step done flags.
2. **Single active task per workspace.** One `in_progress` task at a time, stored in
   `.ai-bridge/current-task.json`. Starting a new one archives the previous.
3. **Reuse-and-extend tool surface.** Extend `task_plan` and `task_report`; add exactly one
   new tool, `task_resume`.
4. **Auto-surface discovery.** `open_current_workspace` and `task_brief` advertise the active
   task so a fresh session sees it immediately.

## Data model

New module `src/taskStore.ts`, modeled on `src/journal.ts` (writes through `PathGuard` under
`config.contextDir`, i.e. `.ai-bridge`).

Active task — `.ai-bridge/current-task.json`:

```json
{
  "schema_version": 1,
  "task_id": "task_<uuid>",
  "goal": "string",
  "target_paths": ["src/foo.ts"],
  "plan_steps": ["agent-authored step 1", "step 2"],
  "status": "in_progress",
  "created_at": "ISO-8601",
  "updated_at": "ISO-8601"
}
```

Archive — `.ai-bridge/tasks/<task_id>.json`: same shape, plus `completed_at`, with
`status` = `complete` or `abandoned`.

`plan_steps` is the agent's actual implementation plan, stored as an immutable reference (no
per-step status). `task_id` is generated like journal operation ids (`task_<randomUUID()>`).
Timestamps use `new Date().toISOString()` (allowed at runtime; same as journal).

**Why no journal change:** with a single active task, journal events whose `ts >= created_at`
are this task's events. Time-window derivation avoids adding a `task_id` to the journal
schema. Stray unrelated operations after `created_at` may be included — acceptable under the
single-active-task assumption.

`taskStore.ts` API:
- `readActiveTask(config, guard, workspace): TaskRecord | null` (null when missing; surfaces a
  parse error record when corrupt, mirroring `readJournalEvents`).
- `writeActiveTask(config, guard, workspace, input): TaskRecord` (archives any existing
  `in_progress` task as `abandoned` first).
- `archiveActiveTask(config, guard, workspace, status): TaskRecord | null` (moves
  current-task.json → tasks/<id>.json with `completed_at`; clears the active file).

## Tool surface

**`task_plan` (extended)** — add optional input `plan_steps: string[]`. When provided, persist
`{goal, target_paths, plan_steps}` via `writeActiveTask` (archiving any prior in-progress task)
and include the returned `task_id` in the result. Existing behavior (policy checks, the
generated `recommended_workflow`/`steps`) is unchanged; the agent's `plan_steps` are stored
separately from the generated workflow guidance.

**`task_resume` (new)** — no required arguments (single active task). Reads the active task:
- If none: `{ active: false }`.
- If present: `{ active: true, task_id, goal, plan_steps, target_paths, created_at, status }`
  plus derived progress — `git status`, `git diff`, journal events with `ts >= created_at`
  (bounded by `maxJournalEvents`), and target-path context. Effectively `task_brief`
  (seeded from the stored goal) + the stored plan + the incremental journal slice.

**`task_report` (extended)** — add optional `complete: boolean`. When true and an active task
exists, archive it (`status = complete`) and clear the active file. Otherwise behavior is
unchanged.

**Discovery** — `open_current_workspace` and `task_brief` results gain an `active_task` field
(`{ task_id, goal, created_at }` or `null`) and a one-line text hint
("There is an in-progress task: <goal>. Call task_resume to continue.").

## Data flow (the core scenario)

1. **Session 1:** `task_plan(goal, plan_steps, ...)` writes `current-task.json`, returns
   `task_id`. The agent works normally — `preview_change_set` / `apply_change_set` /
   `task_verify` / `bash` — all journaled as today. Quota dies.
2. **Session 2 (fresh chat, possibly fresh server process):** on connect,
   `open_current_workspace` shows `active_task`. The agent calls `task_resume`, receiving the
   original goal, the original plan, what git shows is already changed, and journal events
   since `created_at`. It continues, then calls `task_report(complete: true)` to archive.

## Error handling & boundaries

- Missing `current-task.json` → `task_resume` returns `{ active: false }`; corrupt file →
  surface a parse-error (mirror `readJournalEvents`), do not crash.
- Task files live under `.ai-bridge` and are written through the same
  `guard.resolve(..., { forWrite: true })` path as the journal, so they work under
  `writeMode=handoff` and `writeMode=workspace` (and are not writable under `writeMode=off`,
  consistent with the journal).
- Starting a new task while one is `in_progress` archives the old one as `abandoned` (no
  history loss).
- v1 does not prune archived tasks (records are tiny); a cap can be added later.

## Tool-mode placement

`task_resume` joins the STANDARD and FULL tool sets (alongside the other `task_*` tools); it
is not in MINIMAL. `task_plan` / `task_report` keep their current placement.

## Testing (extend `scripts/smoke.mjs`)

- `task_plan` with `plan_steps` → `current-task.json` exists and contains `goal`, `plan_steps`,
  `task_id`.
- `open_current_workspace` / `task_brief` expose `active_task`.
- **A brand-new stdio client (separate server process) calls `task_resume` and still finds the
  task** — proves on-disk persistence rather than in-memory state.
- `task_resume` returns goal + plan + journal events with `ts >= created_at` + git-derived
  changes.
- `task_report(complete: true)` archives: `current-task.json` is gone, `tasks/<id>.json` exists
  with `status = complete`.
- A second `task_plan` archives the first task as `abandoned`.

## Files touched

- `src/taskStore.ts` (new) — task record read/write/archive.
- `src/taskOps.ts` — extend `buildTaskPlan` (persist plan), add resume builder, extend report.
- `src/server.ts` — register `task_resume`; extend `task_plan` / `task_report` inputs; add
  `active_task` to `open_current_workspace` / `task_brief`; add `task_resume` to STANDARD/FULL
  tool-name lists.
- `scripts/smoke.mjs` — coverage above.
- `README.md`, `README_ZH.md`, `SECURITY.md`, `config.example.env` — document the resume flow.
