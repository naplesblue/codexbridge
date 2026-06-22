import { randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { CodexProConfig } from "./config.js";
import type { Workspace } from "./guard.js";
import { PathGuard } from "./guard.js";
import { redactSensitiveText, redactStructured } from "./redact.js";

export interface JournalEvent {
  ts: string;
  operation_id: string;
  event: string;
  status: "ok" | "error";
  workspace_id: string;
  paths?: string[];
  command?: string;
  additions?: number;
  deletions?: number;
  duration_ms?: number;
  error?: string;
}

export interface JournalEventInput {
  operationId?: string;
  event: string;
  status: "ok" | "error";
  paths?: string[];
  command?: string;
  additions?: number;
  deletions?: number;
  durationMs?: number;
  error?: unknown;
}

export function newOperationId(): string {
  return `op_${randomUUID()}`;
}

function journalPath(config: CodexProConfig): string {
  return `${config.contextDir}/operation-journal.jsonl`;
}

export async function appendJournalEvent(
  config: CodexProConfig,
  guard: PathGuard,
  workspace: Workspace,
  input: JournalEventInput
): Promise<JournalEvent> {
  const operationId = input.operationId ?? newOperationId();
  const event: JournalEvent = redactStructured({
    ts: new Date().toISOString(),
    operation_id: operationId,
    event: input.event,
    status: input.status,
    workspace_id: workspace.id,
    ...(input.paths?.length ? { paths: input.paths } : {}),
    ...(input.command ? { command: input.command } : {}),
    ...(typeof input.additions === "number" ? { additions: input.additions } : {}),
    ...(typeof input.deletions === "number" ? { deletions: input.deletions } : {}),
    ...(typeof input.durationMs === "number" ? { duration_ms: input.durationMs } : {}),
    ...(input.error ? { error: input.error instanceof Error ? `${input.error.name}: ${input.error.message}` : String(input.error) } : {})
  });
  const resolved = guard.resolve(workspace, journalPath(config), { forWrite: true });
  await fsp.mkdir(path.dirname(resolved.absPath), { recursive: true });
  await fsp.appendFile(resolved.absPath, `${JSON.stringify(event)}\n`, "utf8");
  return event;
}

export async function readJournalEvents(
  config: CodexProConfig,
  guard: PathGuard,
  workspace: Workspace,
  options: { maxEvents?: number; event?: string } = {}
): Promise<{ path: string; events: JournalEvent[]; total_read: number }> {
  const resolved = guard.resolve(workspace, journalPath(config));
  if (!fs.existsSync(resolved.absPath)) {
    return { path: resolved.relPath, events: [], total_read: 0 };
  }
  const raw = await fsp.readFile(resolved.absPath, "utf8");
  const allEvents: JournalEvent[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as JournalEvent;
      if (!options.event || parsed.event === options.event) allEvents.push(redactStructured(parsed));
    } catch {
      allEvents.push({
        ts: new Date(0).toISOString(),
        operation_id: "op_unreadable",
        event: "journal_parse_error",
        status: "error",
        workspace_id: workspace.id,
        error: redactSensitiveText(line.slice(0, 500))
      });
    }
  }
  const maxEvents = Math.max(1, Math.min(options.maxEvents ?? 50, config.maxJournalEvents));
  return {
    path: resolved.relPath,
    events: allEvents.slice(-maxEvents),
    total_read: allEvents.length
  };
}
