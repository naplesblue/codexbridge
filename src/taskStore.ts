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

function isIsoDateString(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isTaskRecord(value: unknown): value is TaskRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Partial<TaskRecord>;
  return (
    record.schema_version === 1 &&
    typeof record.task_id === "string" &&
    record.task_id.startsWith("task_") &&
    typeof record.goal === "string" &&
    record.goal.trim().length > 0 &&
    isStringArray(record.target_paths) &&
    isStringArray(record.plan_steps) &&
    (record.status === "in_progress" || record.status === "complete" || record.status === "abandoned") &&
    isIsoDateString(record.created_at) &&
    isIsoDateString(record.updated_at) &&
    (record.completed_at === undefined || isIsoDateString(record.completed_at))
  );
}

export function readActiveTask(config: CodexBridgeConfig, guard: PathGuard, workspace: Workspace): TaskRecord | null {
  const resolved = guard.resolve(workspace, activeTaskPath(config));
  if (!fs.existsSync(resolved.absPath)) return null;
  try {
    const record = JSON.parse(fs.readFileSync(resolved.absPath, "utf8"));
    if (!isTaskRecord(record)) return null;
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
