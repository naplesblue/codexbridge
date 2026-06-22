# Policy Changeset Journal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the highest-value Codex-style runtime primitives: unified policy decisions, transactional change sets, and an operation journal.

**Architecture:** Keep existing MCP tools compatible while adding focused internal modules. `policy.ts` classifies file writes and commands, `changeSet.ts` applies multi-file text changes with pre-hash checks and rollback, and `journal.ts` records bounded operation events for recovery and audit. Existing `write`, `edit`, and `bash` call into these modules without changing their public schemas.

**Tech Stack:** TypeScript, Node.js 20+, MCP SDK, existing smoke scripts.

---

## File Structure

- Create `src/policy.ts`: policy decision types, write policy, command policy wrapper.
- Create `src/changeSet.ts`: multi-file change preview/apply with SHA checks and rollback.
- Create `src/journal.ts`: append-only JSONL journal helpers and bounded event preview.
- Modify `src/config.ts`: add policy and journal config defaults.
- Modify `src/bashOps.ts`: replace local safe command checks with shared policy decisions.
- Modify `src/fsOps.ts`: route write/edit through policy and add exported read/write primitives for change sets.
- Modify `src/server.ts`: add `preview_change_set`, `apply_change_set`, and `operation_journal` tools; record journal events for write/edit/bash/change sets.
- Modify `scripts/smoke.mjs`: add coverage for new tools and key policy failures.
- Test with `npm run build` and `npm run smoke`.

## Task 1: Shared Policy Module

**Files:**
- Create: `src/policy.ts`
- Modify: `src/config.ts`
- Modify: `src/bashOps.ts`
- Test: `scripts/smoke.mjs`

- [ ] **Step 1: Write failing smoke coverage**

Add checks to `scripts/smoke.mjs` after the existing tool list validation:

```js
for (const expected of ['preview_change_set', 'apply_change_set', 'operation_journal']) {
  if (!toolNames.includes(expected)) throw new Error(`missing tool: ${expected}`);
}
```

Add a policy assertion near existing bash safety checks:

```js
await expectToolError('bash', { workspace_id: ws, command: 'npm install left-pad' }, /Command is not in the safe bash allowlist|policy/);
```

- [ ] **Step 2: Run smoke to verify it fails**

Run: `npm run build && npm run smoke`

Expected: FAIL because new tools are not registered yet.

- [ ] **Step 3: Implement `src/policy.ts`**

Define:

```ts
export type PolicyDecisionKind = "allow" | "ask" | "deny";

export interface PolicyDecision {
  decision: PolicyDecisionKind;
  reason: string;
  category: string;
  risk: "low" | "medium" | "high";
}
```

Move safe bash allowlist and blocked patterns from `bashOps.ts` into `policy.ts`, expose `decideCommandPolicy(config, command)`, and add `decideWritePolicy(config, relPath, bytes, options)`.

- [ ] **Step 4: Wire bash to policy**

In `src/bashOps.ts`, remove duplicated safe command constants and call `decideCommandPolicy`. Preserve the existing error text shape for compatibility.

- [ ] **Step 5: Run build and smoke**

Run: `npm run build && npm run smoke`

Expected: smoke still fails only for missing change-set/journal tools if Task 2 is not implemented yet.

## Task 2: Transactional Change Sets

**Files:**
- Create: `src/changeSet.ts`
- Modify: `src/server.ts`
- Test: `scripts/smoke.mjs`

- [ ] **Step 1: Write failing change-set tests in smoke**

Add a preview/apply sequence:

```js
const previewChangeSet = await client.request('tools/call', {
  name: 'preview_change_set',
  arguments: {
    workspace_id: ws,
    changes: [
      { path: 'demo.txt', old_text: 'alpha', new_text: 'ALPHA', expected_replacements: 1 },
      { path: 'new-notes.md', content: '# Notes\n', create_dirs: true }
    ]
  }
});
if (previewChangeSet.structuredContent.changed !== true || previewChangeSet.structuredContent.change_count !== 2) {
  throw new Error('preview_change_set did not report two changes');
}

const applyChangeSet = await client.request('tools/call', {
  name: 'apply_change_set',
  arguments: {
    workspace_id: ws,
    changes: previewChangeSet.structuredContent.changes
  }
});
if (applyChangeSet.structuredContent.applied !== true) throw new Error('apply_change_set did not apply');

await expectToolError('apply_change_set', {
  workspace_id: ws,
  changes: [
    { path: 'demo.txt', old_text: 'missing old text', new_text: 'nope', expected_replacements: 1 }
  ]
}, /old_text was not found|change set/);
```

- [ ] **Step 2: Run smoke to verify it fails**

Run: `npm run build && npm run smoke`

Expected: FAIL because change-set tools do not exist.

- [ ] **Step 3: Implement `src/changeSet.ts`**

Support changes shaped as either complete file writes or exact replacements:

```ts
type ChangeSetInput =
  | { path: string; content: string; create_dirs?: boolean; overwrite?: boolean; base_sha256?: string }
  | { path: string; old_text: string; new_text: string; replace_all?: boolean; expected_replacements?: number; base_sha256?: string };
```

Preview computes all target contents and diffs without writing. Apply previews first, snapshots prior file contents, writes all files, and rolls back previous writes if any write fails.

- [ ] **Step 4: Register MCP tools**

Add `preview_change_set` and `apply_change_set` to standard/full tool sets in `src/server.ts`. Return `change_count`, `changed`, `additions`, `deletions`, `changes`, and combined diff.

- [ ] **Step 5: Run build and smoke**

Run: `npm run build && npm run smoke`

Expected: change-set tests pass, journal tool may still fail if Task 3 is not implemented.

## Task 3: Operation Journal

**Files:**
- Create: `src/journal.ts`
- Modify: `src/server.ts`
- Modify: `src/fsOps.ts`
- Modify: `src/bashOps.ts`
- Test: `scripts/smoke.mjs`

- [ ] **Step 1: Write failing journal smoke coverage**

After write/edit/bash/change-set operations, call:

```js
const journal = await client.request('tools/call', {
  name: 'operation_journal',
  arguments: { workspace_id: ws, max_events: 20 }
});
const eventNames = journal.structuredContent.events.map((event) => event.event);
for (const expected of ['write', 'edit', 'bash', 'apply_change_set']) {
  if (!eventNames.includes(expected)) throw new Error(`operation_journal missing ${expected}`);
}
```

- [ ] **Step 2: Run smoke to verify it fails**

Run: `npm run build && npm run smoke`

Expected: FAIL because journal is not implemented.

- [ ] **Step 3: Implement `src/journal.ts`**

Write bounded JSONL events to `${contextDir}/operation-journal.jsonl` with:

```ts
{
  ts: string,
  operation_id: string,
  event: string,
  status: "ok" | "error",
  workspace_id: string,
  paths?: string[],
  command?: string,
  additions?: number,
  deletions?: number,
  duration_ms?: number,
  error?: string
}
```

Export `appendJournalEvent` and `readJournalEvents`.

- [ ] **Step 4: Record events from tools**

In `server.ts`, append journal events after `write`, `edit`, `bash`, and `apply_change_set`. Record failed tool attempts where the handler catches expected errors locally; keep the existing global wrapper unchanged.

- [ ] **Step 5: Register `operation_journal` tool**

Expose a read-only tool with `max_events` and optional `event` filter. Return newest events last with bounded text preview.

- [ ] **Step 6: Run build and smoke**

Run: `npm run build && npm run smoke`

Expected: all smoke tests pass.

## Task 4: Documentation And Final Verification

**Files:**
- Modify: `README.md`
- Modify: `README_ZH.md`
- Modify: `SECURITY.md`

- [ ] **Step 1: Document the new middle-route runtime**

Add concise docs for policy decisions, change-set tools, and operation journal.

- [ ] **Step 2: Run final verification**

Run: `npm run build && npm run smoke`

Expected: PASS.

- [ ] **Step 3: Review git diff**

Run: `git diff --stat && git diff -- src scripts README.md README_ZH.md SECURITY.md docs/superpowers/plans/2026-06-22-policy-changeset-journal.md`

Expected: Diff only contains policy, change-set, journal, docs, and smoke test changes.

## Self-Review

- Spec coverage: policy, change set, journal, command output/recovery foundations, and docs are covered.
- Placeholder scan: no TBD/TODO placeholders are present.
- Type consistency: task signatures use `workspace_id`, `changes`, `base_sha256`, `operation_id`, and existing config naming consistently.
