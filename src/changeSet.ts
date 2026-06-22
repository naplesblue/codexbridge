import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { CodexProConfig } from "./config.js";
import type { Workspace } from "./guard.js";
import { CodexProError, PathGuard } from "./guard.js";
import { decideWritePolicy } from "./policy.js";
import { hasSecretValue } from "./redact.js";
import { makeUnifiedDiff, sha256, type DiffResult } from "./fsOps.js";

export type ChangeSetInput =
  | {
      path: string;
      content: string;
      create_dirs?: boolean;
      overwrite?: boolean;
      base_sha256?: string;
    }
  | {
      path: string;
      old_text: string;
      new_text: string;
      replace_all?: boolean;
      expected_replacements?: number;
      base_sha256?: string;
    };

export interface UnifiedDiffChangeInput {
  path?: string;
  unified_diff: string;
  base_sha256?: string;
}

export interface PreviewedChange {
  path: string;
  kind: "write" | "edit";
  existed: boolean;
  base_sha256: string | null;
  next_sha256: string;
  bytes: number;
  replacements?: number;
  create_dirs?: boolean;
  overwrite?: boolean;
  old_text?: string;
  new_text?: string;
  content?: string;
  diff: string;
  additions: number;
  deletions: number;
  changed: boolean;
}

export interface ChangeSetPreview {
  changes: PreviewedChange[];
  change_count: number;
  additions: number;
  deletions: number;
  changed: boolean;
  diff: string;
}

export interface ChangeSetApplyResult extends ChangeSetPreview {
  applied: boolean;
}

interface PreparedChange extends PreviewedChange {
  absPath: string;
  nextText: string;
  previousText: string;
}

function isEditChange(change: ChangeSetInput): change is Extract<ChangeSetInput, { old_text: string }> {
  return Object.prototype.hasOwnProperty.call(change, "old_text");
}

function cleanDiffPath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "/dev/null") return "";
  return trimmed.replace(/^(?:a|b)\//, "");
}

export function changesFromUnifiedDiff(input: UnifiedDiffChangeInput): ChangeSetInput[] {
  const diff = String(input.unified_diff ?? "").replace(/\r\n/g, "\n");
  if (!diff.trim()) throw new CodexProError("unified_diff must not be empty.");

  const changes: ChangeSetInput[] = [];
  let currentPath = cleanDiffPath(input.path ?? "");
  let oldLines: string[] = [];
  let newLines: string[] = [];
  let inHunk = false;

  function flushHunk(): void {
    if (!inHunk) return;
    const oldText = oldLines.join("\n");
    const newText = newLines.join("\n");
    if (!currentPath) throw new CodexProError("unified_diff is missing a target path. Provide path or include a +++ b/path header.");
    if (!oldText) throw new CodexProError(`unified_diff for ${currentPath} cannot be converted because the hunk has no removable/context text.`);
    if (oldText !== newText) {
      changes.push({
        path: currentPath,
        old_text: oldText,
        new_text: newText,
        expected_replacements: 1,
        base_sha256: input.base_sha256
      });
    }
    oldLines = [];
    newLines = [];
    inHunk = false;
  }

  for (const line of diff.split("\n")) {
    if (line.startsWith("--- ")) {
      flushHunk();
      continue;
    }
    if (line.startsWith("+++ ")) {
      flushHunk();
      currentPath = cleanDiffPath(input.path ?? line.slice(4));
      if (!currentPath) throw new CodexProError("Creating or deleting files from unified_diff is not supported. Use explicit change set writes instead.");
      continue;
    }
    if (line.startsWith("@@")) {
      flushHunk();
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith("\\ No newline")) continue;
    if (line.startsWith(" ")) {
      oldLines.push(line.slice(1));
      newLines.push(line.slice(1));
    } else if (line.startsWith("-")) {
      oldLines.push(line.slice(1));
    } else if (line.startsWith("+")) {
      newLines.push(line.slice(1));
    } else if (line === "") {
      oldLines.push("");
      newLines.push("");
    } else {
      throw new CodexProError(`Unsupported unified_diff line for ${currentPath || "unknown path"}: ${line.slice(0, 80)}`);
    }
  }
  flushHunk();

  if (!changes.length) throw new CodexProError("unified_diff did not contain any applicable text changes.");
  return changes;
}

async function readExistingText(config: CodexProConfig, guard: PathGuard, absPath: string): Promise<{ text: string; existed: boolean }> {
  try {
    await guard.assertTextFile(absPath, Math.max(config.maxWriteBytes, config.maxReadBytes));
    return { text: await fsp.readFile(absPath, "utf8"), existed: true };
  } catch (error) {
    if (error instanceof CodexProError && error.message.startsWith("Not a file")) throw error;
    if (fs.existsSync(absPath)) throw error;
    return { text: "", existed: false };
  }
}

function assertBaseSha(change: ChangeSetInput, relPath: string, before: string, existed: boolean): string | null {
  const baseSha = existed ? sha256(before) : null;
  if (change.base_sha256 && change.base_sha256 !== baseSha) {
    throw new CodexProError(`base_sha256 mismatch for ${relPath}. Expected ${change.base_sha256}, current ${baseSha ?? "missing"}.`);
  }
  return baseSha;
}

function buildCombinedDiff(changes: PreviewedChange[]): string {
  const diffs = changes
    .filter((change) => change.changed)
    .map((change) => change.diff)
    .filter(Boolean);
  return diffs.length ? diffs.join("\n\n") : "No changes.";
}

function summarize(changes: PreviewedChange[]): ChangeSetPreview {
  const additions = changes.reduce((sum, change) => sum + change.additions, 0);
  const deletions = changes.reduce((sum, change) => sum + change.deletions, 0);
  const changed = changes.some((change) => change.changed);
  return {
    changes,
    change_count: changes.length,
    additions,
    deletions,
    changed,
    diff: buildCombinedDiff(changes)
  };
}

async function prepareChange(
  config: CodexProConfig,
  guard: PathGuard,
  workspace: Workspace,
  rawChange: ChangeSetInput
): Promise<PreparedChange> {
  const resolved = guard.resolve(workspace, rawChange.path, { forWrite: true });
  const before = await readExistingText(config, guard, resolved.absPath);
  const baseSha = assertBaseSha(rawChange, resolved.relPath, before.text, before.existed);

  let nextText: string;
  let kind: "write" | "edit";
  let replacements: number | undefined;
  let createDirs: boolean | undefined;
  let overwrite: boolean | undefined;
  let oldText: string | undefined;
  let newText: string | undefined;
  let content: string | undefined;

  if (isEditChange(rawChange)) {
    kind = "edit";
    oldText = String(rawChange.old_text ?? "");
    newText = String(rawChange.new_text ?? "");
    if (!oldText) throw new CodexProError("old_text must not be empty.");
    if (!before.existed) throw new CodexProError(`Cannot edit missing file: ${resolved.relPath}`);
    const occurrences = before.text.split(oldText).length - 1;
    if (occurrences === 0) {
      throw new CodexProError(`old_text was not found in ${resolved.relPath}. Read the file and retry with an exact snippet.`);
    }
    if (rawChange.replace_all) {
      nextText = before.text.split(oldText).join(newText);
      replacements = occurrences;
    } else {
      if (occurrences !== 1) {
        throw new CodexProError(`old_text matched ${occurrences} times. Provide a more specific old_text or set replace_all=true.`);
      }
      nextText = before.text.replace(oldText, newText);
      replacements = 1;
    }
    if (typeof rawChange.expected_replacements === "number" && replacements !== rawChange.expected_replacements) {
      throw new CodexProError(`Expected ${rawChange.expected_replacements} replacements but would perform ${replacements}.`);
    }
  } else {
    kind = "write";
    content = String(rawChange.content ?? "");
    nextText = content;
    createDirs = rawChange.create_dirs !== false;
    overwrite = rawChange.overwrite !== false;
    if (before.existed && rawChange.overwrite === false) {
      throw new CodexProError(`File already exists and overwrite=false: ${resolved.relPath}`);
    }
  }

  const bytes = Buffer.byteLength(nextText, "utf8");
  const policy = decideWritePolicy(config, resolved.relPath, bytes, { createDirs, overwrite, operation: "change_set" });
  if (policy.decision === "deny") throw new CodexProError(policy.reason);
  if (hasSecretValue(nextText)) {
    throw new CodexProError("Secret-looking content is blocked from change set. Use placeholders such as [REDACTED_SECRET].");
  }

  const diff: DiffResult = makeUnifiedDiff(before.text, nextText, resolved.relPath);
  return {
    path: resolved.relPath,
    absPath: resolved.absPath,
    kind,
    existed: before.existed,
    base_sha256: baseSha,
    next_sha256: sha256(nextText),
    bytes,
    replacements,
    create_dirs: createDirs,
    overwrite,
    old_text: oldText,
    new_text: newText,
    content,
    diff: diff.diff,
    additions: diff.additions,
    deletions: diff.deletions,
    changed: diff.changed,
    nextText,
    previousText: before.text
  };
}

export async function previewChangeSet(
  config: CodexProConfig,
  guard: PathGuard,
  workspace: Workspace,
  rawChanges: ChangeSetInput[]
): Promise<ChangeSetPreview> {
  if (!Array.isArray(rawChanges) || rawChanges.length === 0) {
    throw new CodexProError("changes must contain at least one change.");
  }
  if (rawChanges.length > 50) {
    throw new CodexProError("changes is limited to 50 entries.");
  }
  const prepared: PreviewedChange[] = [];
  for (const rawChange of rawChanges) {
    const change = await prepareChange(config, guard, workspace, rawChange);
    const { absPath: _absPath, nextText: _nextText, previousText: _previousText, ...preview } = change;
    prepared.push(preview);
  }
  return summarize(prepared);
}

export async function applyChangeSet(
  config: CodexProConfig,
  guard: PathGuard,
  workspace: Workspace,
  rawChanges: ChangeSetInput[]
): Promise<ChangeSetApplyResult> {
  const prepared = await Promise.all(rawChanges.map((rawChange) => prepareChange(config, guard, workspace, rawChange)));
  const written: PreparedChange[] = [];
  try {
    for (const change of prepared) {
      if (change.create_dirs) await fsp.mkdir(path.dirname(change.absPath), { recursive: true });
      await fsp.writeFile(change.absPath, change.nextText, "utf8");
      written.push(change);
    }
  } catch (error) {
    for (const change of written.reverse()) {
      try {
        if (change.existed) await fsp.writeFile(change.absPath, change.previousText, "utf8");
        else await fsp.rm(change.absPath, { force: true });
      } catch {
        // Preserve the original failure; rollback best-effort details belong in the journal.
      }
    }
    throw error;
  }

  const changes: PreviewedChange[] = prepared.map(({ absPath: _absPath, nextText: _nextText, previousText: _previousText, ...preview }) => preview);
  return { ...summarize(changes), applied: true };
}
