# Task Resume Layer (Phase 4) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a durable, single-active-task record so a fresh ChatGPT session can discover and resume an in-progress coding task after Codex quota dies mid-work.

**Architecture:** A new `src/taskStore.ts` persists the active task to `.ai-bridge/current-task.json` (archived to `.ai-bridge/tasks/<id>.json` on completion), written through the existing `PathGuard` exactly like `src/journal.ts`. Progress is derived at resume time from `git status/diff` + the operation journal (events with `ts >= created_at`) — no per-step state. `task_plan` is extended to persist the agent's plan, `task_report` to archive on completion, and one new tool `task_resume` reads it back. `open_current_workspace` and `task_brief` advertise the active task.

**Tech Stack:** TypeScript 5.8 / Node 20, `@modelcontextprotocol/sdk`, Zod, integration tests via `scripts/smoke.mjs` (no unit-test runner — TDD loop is red smoke assertions → implement → `npm run smoke`).

**Branch:** `codex/task-resume` (already created off `main` @ `00a44ad`).

---

## File Structure

- **Create** `src/taskStore.ts` — task record types + read/write/archive/summary. Sole owner of `.ai-bridge/current-task.json` and `.ai-bridge/tasks/<id>.json`.
- **Modify** `src/taskOps.ts` — extend `buildTaskPlan` to persist the plan; add `buildTaskResume`; extend `TaskPlanResult`.
- **Modify** `src/server.ts` — add `plan_steps` input to `task_plan`; register `task_resume`; add `complete` input + archive to `task_report`; add `active_task` to `open_current_workspace` and `task_brief`; add `task_resume` to STANDARD/FULL tool-name lists.
- **Modify** `scripts/smoke.mjs` — red→green coverage.
- **Modify** `README.md`, `README_ZH.md`, `SECURITY.md`, `config.example.env` — document the resume flow.

---

## Task 1: Red smoke assertions for the task-resume flow

**Files:**
- Modify: `scripts/smoke.mjs` (main MCP block, after the existing `task_report` / journal assertions; and a fresh-process resume check near the tool-mode section)

- [ ] **Step 1: Add the failing assertions**

Find the main smoke client's task-workflow assertions (search `task_report` near the journal checks). After them, insert:

```javascript
// --- Task resume layer (Phase 4) ---
const planWithSteps = await client.request('tools/call', {
  name: 'task_plan',
  arguments: {
    workspace_id: ws,
    goal: 'Resume demo: update demo text',
    target_paths: ['demo.txt'],
    plan_steps: ['Read demo.txt', 'Edit omega to OMEGA', 'Verify with cat']
  }
});
if (!planWithSteps.structuredContent.task_id || !String(planWithSteps.structuredContent.task_id).startsWith('task_')) {
  throw new Error(`task_plan did not persist a task_id: ${JSON.stringify(planWithSteps.structuredContent)}`);
}
const persistedTaskId = planWithSteps.structuredContent.task_id;
const currentTaskFile = path.join(tmp, '.ai-bridge', 'current-task.json');
const persisted = JSON.parse(await fs.readFile(currentTaskFile, 'utf8'));
if (persisted.goal !== 'Resume demo: update demo text' || persisted.plan_steps.length !== 3 || persisted.status !== 'in_progress') {
  throw new Error(`current-task.json missing expected fields: ${JSON.stringify(persisted)}`);
}

const briefWithTask = await client.request('tools/call', { name: 'task_brief', arguments: { workspace_id: ws, goal: 'check active task' } });
if (briefWithTask.structuredContent.active_task?.task_id !== persistedTaskId) {
  throw new Error(`task_brief did not surface active_task: ${JSON.stringify(briefWithTask.structuredContent.active_task)}`);
}

const resume = await client.request('tools/call', { name: 'task_resume', arguments: { workspace_id: ws } });
if (!resume.structuredContent.active || resume.structuredContent.task_id !== persistedTaskId) {
  throw new Error(`task_resume did not return active task: ${JSON.stringify(resume.structuredContent)}`);
}
if (resume.structuredContent.plan_steps?.length !== 3 || !Array.isArray(resume.structuredContent.events)) {
  throw new Error(`task_resume missing plan/events: ${JSON.stringify(resume.structuredContent)}`);
}

const completed = await client.request('tools/call', { name: 'task_report', arguments: { workspace_id: ws, include_diff: false, complete: true } });
if (completed.structuredContent.archived_task?.status !== 'complete') {
  throw new Error(`task_report complete did not archive task: ${JSON.stringify(completed.structuredContent.archived_task)}`);
}
if (existsSync(currentTaskFile)) {
  throw new Error('current-task.json should be removed after task_report complete');
}
const archiveFile = path.join(tmp, '.ai-bridge', 'tasks', `${persistedTaskId}.json`);
const archived = JSON.parse(await fs.readFile(archiveFile, 'utf8'));
if (archived.status !== 'complete' || !archived.completed_at) {
  throw new Error(`archived task file wrong: ${JSON.stringify(archived)}`);
}

const resumeAfter = await client.request('tools/call', { name: 'task_resume', arguments: { workspace_id: ws } });
if (resumeAfter.structuredContent.active !== false) {
  throw new Error(`task_resume should report no active task after complete: ${JSON.stringify(resumeAfter.structuredContent)}`);
}

// Starting a new task while one is in_progress archives the prior as abandoned
await client.request('tools/call', { name: 'task_plan', arguments: { workspace_id: ws, goal: 'First task', plan_steps: ['step a'] } });
const firstId = JSON.parse(await fs.readFile(currentTaskFile, 'utf8')).task_id;
await client.request('tools/call', { name: 'task_plan', arguments: { workspace_id: ws, goal: 'Second task', plan_steps: ['step b'] } });
const abandoned = JSON.parse(await fs.readFile(path.join(tmp, '.ai-bridge', 'tasks', `${firstId}.json`), 'utf8'));
if (abandoned.status !== 'abandoned') {
  throw new Error(`prior task should be archived as abandoned: ${JSON.stringify(abandoned)}`);
}
// Clean up so later mode checks start without an active task lingering
await client.request('tools/call', { name: 'task_report', arguments: { workspace_id: ws, include_diff: false, complete: true } });
```

Ensure `existsSync` is imported at the top of `scripts/smoke.mjs`. If only `fs` (promises) is imported, add near the other imports:

```javascript
import { existsSync } from 'node:fs';
```

Also confirm `ws` is the workspace id variable already used by earlier task assertions in that block; if the block uses `current.structuredContent.workspace_id`, reuse that exact variable instead of `ws`.

- [ ] **Step 2: Add the fresh-process resume assertion**

Near the `assertToolMode` section (a separate `McpStdioClient` is spawned there), add a standalone block that proves on-disk persistence across processes. After the existing mode assertions:

```javascript
// Fresh server process must still find the active task on disk
const resumeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'codexbridge-resume-'));
await fs.writeFile(path.join(resumeRoot, 'demo.txt'), 'alpha\n', 'utf8');
const planClient = new McpStdioClient('node', ['dist/stdio.js', '--root', resumeRoot, '--allow-root', resumeRoot], {
  cwd: path.resolve('.'),
  env: { ...process.env, CODEXBRIDGE_ROOT: resumeRoot, CODEXBRIDGE_ALLOWED_ROOTS: resumeRoot }
});
await planClient.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'codexbridge-resume-plan', version: '0.1.0' } });
planClient.notify('notifications/initialized');
const planRes = await planClient.request('tools/call', { name: 'task_plan', arguments: { goal: 'Cross-process resume', plan_steps: ['do x'] } });
const crossId = planRes.structuredContent.task_id;
planClient.close();

const resumeClient = new McpStdioClient('node', ['dist/stdio.js', '--root', resumeRoot, '--allow-root', resumeRoot], {
  cwd: path.resolve('.'),
  env: { ...process.env, CODEXBRIDGE_ROOT: resumeRoot, CODEXBRIDGE_ALLOWED_ROOTS: resumeRoot }
});
await resumeClient.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'codexbridge-resume-read', version: '0.1.0' } });
resumeClient.notify('notifications/initialized');
const crossResume = await resumeClient.request('tools/call', { name: 'task_resume', arguments: {} });
if (!crossResume.structuredContent.active || crossResume.structuredContent.task_id !== crossId) {
  throw new Error(`fresh process did not resume task: ${JSON.stringify(crossResume.structuredContent)}`);
}
resumeClient.close();
```

- [ ] **Step 3: Run smoke to verify it fails**

Run: `npm run build && npm run smoke`
Expected: build succeeds; `smoke.mjs` FAILS — first failure is `missing tool: task_resume` (tool not registered) or `task_plan did not persist a task_id`.

- [ ] **Step 4: Commit the red test**

```bash
git add scripts/smoke.mjs
git commit -m "test: add red smoke coverage for task resume layer"
```

---

## Task 2: Create the task store module

**Files:**
- Create: `src/taskStore.ts`

- [ ] **Step 1: Write `src/taskStore.ts`**

```typescript
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { CodexBridgeConfig } from "./config.js";
import type { Workspace } from "./guard.js";
import { PathGuard } from "./guard.js";

export type TaskStatus = "in_progress" | "complete" | "abandoned";

export interface TaskRecord {
  schema_version: 1;
  task_id: string;
  goal: string;
  target_paths: string[];
  plan_steps: string[];
  status: TaskStatus;
  created_at: string;
  updated_at: string;
  completed_at?: string;
}

export interface TaskWriteInput {
  goal: string;
  target_paths?: string[];
  plan_steps?: string[];
}

export interface ActiveTaskSummary {
  task_id: string;
  goal: string;
  created_at: string;
}

export function newTaskId(): string {
  return `task_${randomUUID()}`;
}

function activeTaskPath(config: CodexBridgeConfig): string {
  return `${config.contextDir}/current-task.json`;
}

function archiveTaskPath(config: CodexBridgeConfig, taskId: string): string {
  return `${config.contextDir}/tasks/${taskId}.json`;
}

export function readActiveTask(config: CodexBridgeConfig, guard: PathGuard, workspace: Workspace): TaskRecord | null {
  const resolved = guard.resolve(workspace, activeTaskPath(config));
  if (!fs.existsSync(resolved.absPath)) return null;
  try {
    const record = JSON.parse(fs.readFileSync(resolved.absPath, "utf8")) as TaskRecord;
    if (!record || typeof record.task_id !== "string") return null;
    return record;
  } catch {
    // Corrupt active-task file: degrade to "no active task" rather than crash.
    return null;
  }
}

export function activeTaskSummary(config: CodexBridgeConfig, guard: PathGuard, workspace: Workspace): ActiveTaskSummary | null {
  const record = readActiveTask(config, guard, workspace);
  if (!record || record.status !== "in_progress") return null;
  return { task_id: record.task_id, goal: record.goal, created_at: record.created_at };
}

async function writeArchive(
  config: CodexBridgeConfig,
  guard: PathGuard,
  workspace: Workspace,
  record: TaskRecord,
  status: "complete" | "abandoned"
): Promise<TaskRecord> {
  const now = new Date().toISOString();
  const archived: TaskRecord = { ...record, status, updated_at: now, completed_at: now };
  const resolved = guard.resolve(workspace, archiveTaskPath(config, record.task_id), { forWrite: true });
  await fsp.mkdir(path.dirname(resolved.absPath), { recursive: true });
  await fsp.writeFile(resolved.absPath, `${JSON.stringify(archived, null, 2)}\n`, "utf8");
  return archived;
}

export async function writeActiveTask(
  config: CodexBridgeConfig,
  guard: PathGuard,
  workspace: Workspace,
  input: TaskWriteInput
): Promise<TaskRecord> {
  const existing = readActiveTask(config, guard, workspace);
  if (existing && existing.status === "in_progress") {
    await writeArchive(config, guard, workspace, existing, "abandoned");
  }
  const now = new Date().toISOString();
  const record: TaskRecord = {
    schema_version: 1,
    task_id: newTaskId(),
    goal: input.goal.trim(),
    target_paths: (input.target_paths ?? []).map((value) => value.trim()).filter(Boolean),
    plan_steps: (input.plan_steps ?? []).map((value) => value.trim()).filter(Boolean),
    status: "in_progress",
    created_at: now,
    updated_at: now
  };
  const resolved = guard.resolve(workspace, activeTaskPath(config), { forWrite: true });
  await fsp.mkdir(path.dirname(resolved.absPath), { recursive: true });
  await fsp.writeFile(resolved.absPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  return record;
}

export async function archiveActiveTask(
  config: CodexBridgeConfig,
  guard: PathGuard,
  workspace: Workspace,
  status: "complete" | "abandoned"
): Promise<TaskRecord | null> {
  const existing = readActiveTask(config, guard, workspace);
  if (!existing) return null;
  const archived = await writeArchive(config, guard, workspace, existing, status);
  const resolved = guard.resolve(workspace, activeTaskPath(config), { forWrite: true });
  if (fs.existsSync(resolved.absPath)) await fsp.rm(resolved.absPath);
  return archived;
}
```

Note: task records are NOT redacted (unlike journal events) — `goal`/`plan_steps` are agent-authored task descriptions and must round-trip with full fidelity, the same way `.ai-bridge` handoff files are stored verbatim.

- [ ] **Step 2: Build to verify it compiles**

Run: `npm run build`
Expected: PASS (no type errors). The module is unused so far; this just confirms it compiles.

- [ ] **Step 3: Commit**

```bash
git add src/taskStore.ts
git commit -m "feat: add task store for durable active-task records"
```

---

## Task 3: Extend taskOps — persist plan + build resume

**Files:**
- Modify: `src/taskOps.ts`

- [ ] **Step 1: Add imports**

At the top of `src/taskOps.ts`, after the existing imports, add:

```typescript
import { readActiveTask, writeActiveTask, type TaskRecord, type TaskStatus } from "./taskStore.js";
```

- [ ] **Step 2: Extend `TaskPlanResult` and add `TaskResumeResult`**

In the interfaces section, add `task_id` to `TaskPlanResult`:

```typescript
export interface TaskPlanResult {
  goal: string;
  target_paths: string[];
  steps: TaskPlanStep[];
  command_policies: Array<{ command: string; policy: PolicyDecision }>;
  approval_requirements: ApprovalActionResult[];
  change_preview?: ChangeSetPreview;
  task_id?: string;
}
```

Add a new interface near `TaskReportResult`:

```typescript
export interface TaskResumeResult {
  active: boolean;
  task_id?: string;
  goal?: string;
  plan_steps?: string[];
  target_paths?: string[];
  status?: TaskStatus;
  created_at?: string;
  git_status?: string;
  git_diff?: string;
  events?: JournalEvent[];
  context_text?: string;
}
```

- [ ] **Step 3: Persist the plan in `buildTaskPlan`**

Change the `buildTaskPlan` options type to add `planSteps`:

```typescript
export async function buildTaskPlan(
  config: CodexBridgeConfig,
  guard: PathGuard,
  workspace: Workspace,
  options: { goal: string; targetPaths?: string[]; proposedCommands?: string[]; proposedChanges?: ChangeSetInput[]; planSteps?: string[] }
): Promise<TaskPlanResult> {
```

Just before the final `return { ... }`, persist when `planSteps` is provided:

```typescript
  let taskId: string | undefined;
  const planSteps = (options.planSteps ?? []).map((step) => step.trim()).filter(Boolean);
  if (planSteps.length) {
    const record = await writeActiveTask(config, guard, workspace, {
      goal,
      target_paths: targetPaths,
      plan_steps: planSteps
    });
    taskId = record.task_id;
  }
```

Then add `task_id` to the returned object:

```typescript
  return {
    goal,
    target_paths: targetPaths,
    steps: [
      { order: 1, tool: "task_brief", purpose: "Load repo rules, git state, bridge context, and target-path instructions." },
      { order: 2, tool: "read/search/tree", purpose: "Inspect only the files needed for the goal." },
      { order: 3, tool: "preview_change_set", purpose: "Build a reviewable diff with base hashes before writing." },
      { order: 4, tool: "approval_review", purpose: "Summarize write and command risk before applying." },
      { order: 5, tool: "apply_change_set", purpose: "Apply the approved change set." },
      { order: 6, tool: "task_verify", purpose: "Run one policy-checked verification command." },
      { order: 7, tool: "task_report", purpose: "Return final git diff stats, touched paths, and journal events." }
    ],
    command_policies: commandPolicies,
    approval_requirements: approvalRequirements,
    ...(changePreview ? { change_preview: changePreview } : {}),
    ...(taskId ? { task_id: taskId } : {})
  };
```

- [ ] **Step 4: Add `buildTaskResume`**

Add at the end of `src/taskOps.ts`:

```typescript
export async function buildTaskResume(
  config: CodexBridgeConfig,
  guard: PathGuard,
  workspace: Workspace,
  options: { maxEvents: number }
): Promise<TaskResumeResult> {
  const record: TaskRecord | null = readActiveTask(config, guard, workspace);
  if (!record) return { active: false };
  const context = await readCodexContext(config, guard, workspace, {
    targetPath: record.target_paths[0] ?? ".",
    includeAiBridge: true,
    includeGit: true,
    includeDiff: true
  });
  const journal = await readJournalEvents(config, guard, workspace, { maxEvents: options.maxEvents });
  const events = journal.events.filter((event) => event.ts >= record.created_at);
  return {
    active: true,
    task_id: record.task_id,
    goal: record.goal,
    plan_steps: record.plan_steps,
    target_paths: record.target_paths,
    status: record.status,
    created_at: record.created_at,
    git_status: context.gitStatus,
    git_diff: context.gitDiff,
    events,
    context_text: context.text
  };
}
```

(`readCodexContext`, `readJournalEvents`, `JournalEvent` are already imported in this file.)

- [ ] **Step 5: Build to verify it compiles**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/taskOps.ts
git commit -m "feat: persist task plan and add resume builder in taskOps"
```

---

## Task 4: Wire the server — tools, inputs, discovery

**Files:**
- Modify: `src/server.ts`

- [ ] **Step 1: Add imports**

Update the taskOps import line (currently `import { buildTaskBrief, buildTaskPlan, buildTaskReport, reviewApprovalActions } from "./taskOps.js";`) to add `buildTaskResume`:

```typescript
import { buildTaskBrief, buildTaskPlan, buildTaskReport, buildTaskResume, reviewApprovalActions } from "./taskOps.js";
```

Add a new import for the task store summary + archive:

```typescript
import { activeTaskSummary, archiveActiveTask } from "./taskStore.js";
```

- [ ] **Step 2: Add `task_resume` to the tool-name lists**

In `STANDARD_TOOL_NAMES`, after `"task_report",` add `"task_resume",`.
In `FULL_TOOL_NAMES`, after `"task_report",` add `"task_resume",`.
(Do NOT add it to `MINIMAL_TOOL_NAMES`.)

- [ ] **Step 3: Add `plan_steps` input to `task_plan` and pass it through**

In the `task_plan` registration `inputSchema`, after the `proposed_changes` line add:

```typescript
        plan_steps: z.array(z.string()).optional().describe("The agent's actual implementation steps. When provided, the goal and plan are persisted as the workspace's active task and a task_id is returned for later task_resume.")
```

In the `task_plan` handler, add `planSteps` to the `buildTaskPlan` call:

```typescript
      const result = await buildTaskPlan(config, guard, workspace, {
        goal: String(args.goal ?? ""),
        targetPaths: Array.isArray(args.target_paths) ? args.target_paths.map(String) : [],
        proposedCommands: Array.isArray(args.proposed_commands) ? args.proposed_commands.map(String) : [],
        proposedChanges: Array.isArray(args.proposed_changes) ? normalizeChangeSetInput(args.proposed_changes) : undefined,
        planSteps: Array.isArray(args.plan_steps) ? args.plan_steps.map(String) : undefined
      });
```

- [ ] **Step 4: Add `complete` input + archive to `task_report`**

In the `task_report` `inputSchema`, after `max_events`, add:

```typescript
        complete: z.boolean().optional().describe("Mark the active task complete and archive it to .ai-bridge/tasks/<id>.json. Default: false.")
```

In the `task_report` handler, after `buildTaskReport(...)` resolves and before building `text`, add:

```typescript
      const archivedTask = parseBool(args.complete, false)
        ? await archiveActiveTask(config, guard, workspace, "complete")
        : null;
```

Change the final return to include the archived task:

```typescript
      return textResult(text, { ...result, ...(archivedTask ? { archived_task: archivedTask } : {}) });
```

- [ ] **Step 5: Register the `task_resume` tool**

Immediately after the `task_report` registration block (after its closing `);`), insert:

```typescript
  registerCodexTool(
    config,
    server,
    "task_resume",
    {
      title: "Task Resume",
      description: "Resume the workspace's in-progress task after a new session: returns the saved goal and plan plus derived progress (git status/diff and journal events since the task started). Returns active=false when no task is in progress.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace."),
        max_events: z.number().int().min(1).max(500).optional().describe("Recent journal events to include. Default: 50.")
      },
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Resuming task...",
        "openai/toolInvocation/invoked": "Task resume ready"
      }
    },
    async (args) => {
      const workspace = workspaces.getWorkspace(args.workspace_id);
      const result = await buildTaskResume(config, guard, workspace, {
        maxEvents: limitInt(args.max_events, 50, 1, 500)
      });
      if (!result.active) {
        return textResult("# Task Resume\n\nNo in-progress task for this workspace. Start one with task_plan (provide plan_steps).", { ...result });
      }
      const stepRows = result.plan_steps?.length
        ? result.plan_steps.map((step, index) => `${index + 1}. ${step}`).join("\n")
        : "- No plan steps recorded.";
      const eventRows = result.events?.length
        ? result.events.map((event) => `- ${event.ts} ${event.status.toUpperCase()} ${event.event} ${event.paths?.join(", ") ?? event.command ?? ""}`.trim()).join("\n")
        : "- No journal events since the task started.";
      const text = `# Task Resume\n\nTask: ${result.task_id}\nGoal: ${result.goal}\nStarted: ${result.created_at}\n\n## Plan\n\n${stepRows}\n\n## Events Since Start\n\n${eventRows}${result.git_diff ? diffBlock(result.git_diff) : ""}`;
      return textResult(text, { ...result });
    }
  );
```

- [ ] **Step 6: Surface `active_task` in `open_current_workspace`**

In the `open_current_workspace` handler, before the `return textResult(...)`, add:

```typescript
      const activeTask = activeTaskSummary(config, guard, workspace);
```

Add `active_task` to the returned structured content (after `tool_mode: config.toolMode`):

```typescript
        tool_mode: config.toolMode,
        active_task: activeTask
```

- [ ] **Step 7: Surface `active_task` in `task_brief`**

In the `task_brief` handler, before `return textResult(...)`, add:

```typescript
      const activeTask = activeTaskSummary(config, guard, workspace);
```

Append a hint to the text and add the field to structured content:

```typescript
      const text = `# Task Brief\n\nGoal: ${result.goal}\nTarget: ${result.target_path}\nAGENTS files: ${result.agents_files.join(", ") || "none"}\nRecommended workflow: ${result.recommended_workflow.join(" -> ")}${activeTask ? `\n\n> There is an in-progress task: ${activeTask.goal}. Call task_resume to continue.` : ""}\n\n${result.context_text}${result.tree ? `\n\n## Tree\n\n\`\`\`text\n${result.tree}\n\`\`\`` : ""}`;
      return textResult(text, { ...result, active_task: activeTask });
```

- [ ] **Step 8: Build to verify it compiles**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/server.ts
git commit -m "feat: wire task_resume tool, plan persistence, and active-task discovery"
```

---

## Task 5: Run the full smoke suite to green

**Files:** none (verification)

- [ ] **Step 1: Build + run the full suite**

Run: `npm run build && npm run smoke`
Expected: all six smoke scripts print `✓ ... passed` and the process exits 0. Specifically the Task 1 assertions (task_id persisted, active_task surfaced, task_resume active, archive on complete, abandoned on re-plan, cross-process resume) all pass.

- [ ] **Step 2: Whitespace check**

Run: `git diff --check`
Expected: no output (exit 0).

- [ ] **Step 3: If anything fails**

Read the first thrown error in the smoke output, fix the corresponding source file, rebuild, and re-run. Do not edit the assertions to pass — fix the implementation. (The one legitimate assertion edit, if needed: confirm the workspace-id variable name in Task 1 matches the existing block.)

---

## Task 6: Documentation

**Files:**
- Modify: `README.md`, `README_ZH.md`, `SECURITY.md`, `config.example.env`

- [ ] **Step 1: README.md — tool list + a resume section**

In the standard-tools list, after the `task_report` bullet add:

```markdown
- `task_resume` — resume the workspace's in-progress task in a new session: returns the saved goal/plan plus git-derived progress and journal events since it started.
```

After the SSH/Desktop modes sections (or near the task-workflow docs), add:

```markdown
## Task resume (continue after a dropped session)

When a coding session ends mid-task (for example Codex quota runs out), CodexBridge can pick the work back up in a fresh ChatGPT session.

- Call `task_plan` with `plan_steps` (your actual implementation steps). CodexBridge saves the goal and plan to `.ai-bridge/current-task.json` and returns a `task_id`.
- Work as usual — `preview_change_set` / `apply_change_set` / `task_verify` are journaled.
- In a new session, `open_current_workspace` and `task_brief` show the active task. Call `task_resume` to get the saved goal, the plan, what git shows is already changed, and the journal events since the task started.
- When done, call `task_report` with `complete: true` to archive the task to `.ai-bridge/tasks/<id>.json`.

One active task per workspace; starting a new `task_plan` (with `plan_steps`) archives the previous one as `abandoned`.
```

- [ ] **Step 2: README_ZH.md — mirror the section**

After the SSH/桌面 section add:

```markdown
## 任务续接（会话中断后继续）

当一次编码会话中途结束（比如 Codex 额度用完），CodexBridge 可以让新的 ChatGPT 会话接着干。

- 调用 `task_plan` 时带上 `plan_steps`（你真实的实现步骤），CodexBridge 会把目标和计划存到 `.ai-bridge/current-task.json` 并返回 `task_id`。
- 照常工作——`preview_change_set` / `apply_change_set` / `task_verify` 都会进 journal。
- 新会话里，`open_current_workspace` 和 `task_brief` 会提示有未完成任务；调用 `task_resume` 即可拿到原目标、原计划、git 里已改了什么，以及任务开始后的 journal 事件。
- 完成后调用 `task_report` 并带 `complete: true`，任务会归档到 `.ai-bridge/tasks/<id>.json`。

每个 workspace 同时只有一个活动任务；再次用 `task_plan`（带 `plan_steps`）开新任务时，上一个会被归档为 `abandoned`。
```

- [ ] **Step 3: SECURITY.md — note the task files**

In the "Safer Defaults" / boundary list, add a bullet:

```markdown
- Task records (`.ai-bridge/current-task.json` and `.ai-bridge/tasks/`) store the goal and plan you give `task_plan`. They are written through the same path guard as the operation journal and never leave the workspace; do not put secrets in task goals or plan steps.
```

- [ ] **Step 4: config.example.env — no new env, add a comment**

After the desktop block (or the SSH block), add:

```bash
# Task resume needs no configuration: task_plan with plan_steps persists the active task
# under .ai-bridge (current-task.json), resumable in a new session via task_resume.
```

- [ ] **Step 5: Verify docs build nothing / run smoke once more**

Run: `npm run smoke`
Expected: exits 0 (docs don't affect tests; this confirms nothing regressed).

- [ ] **Step 6: Commit**

```bash
git add README.md README_ZH.md SECURITY.md config.example.env
git commit -m "docs: document task resume flow"
```

---

## Self-Review (completed by plan author)

- **Spec coverage:** data model (Task 2), derived progress via journal-since-created (Task 3 `buildTaskResume`), single active task + auto-archive (Task 2 `writeActiveTask`/`archiveActiveTask`), reuse-and-extend tools (Tasks 3–4), auto-surface discovery (Task 4 steps 6–7), cross-process persistence test (Task 1 step 2), error/boundary handling (Task 2 corrupt→null; writes through guard like journal). All covered.
- **Placeholder scan:** none — every code step shows complete code; commands have expected output.
- **Type consistency:** `TaskRecord`, `TaskStatus`, `writeActiveTask`, `readActiveTask`, `activeTaskSummary`, `archiveActiveTask`, `buildTaskResume`, `TaskResumeResult`, `task_id` used consistently across Tasks 2–4. `task_resume` appears identically in tool-name lists, registration, README, and smoke assertions.
```
