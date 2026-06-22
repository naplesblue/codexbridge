import fsp from "node:fs/promises";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { CodexBridgeConfig } from "./config.js";
import { WorkspaceManager, PathGuard, CodexBridgeError, type Workspace } from "./guard.js";
import { repoTree, readTextFile, writeTextFile, editTextFile, ensureAiBridge } from "./fsOps.js";
import { searchWorkspace } from "./searchOps.js";
import { runBash } from "./bashOps.js";
import { listSshProfiles, runSshCommand, type SshExecResult } from "./sshOps.js";
import { gitDiff, gitLog, gitStatus } from "./gitOps.js";
import { readAiBridgeContext, readCodexContext, workspaceSummary } from "./workspaceOps.js";
import { buildProContext, exportProContext } from "./proContext.js";
import { codexbridgeInventory, loadSkill } from "./capabilitiesOps.js";
import { listCodexSessions, readCodexSession } from "./codexSessions.js";
import { applyChangeSet, changesFromUnifiedDiff, previewChangeSet, type ChangeSetInput } from "./changeSet.js";
import { appendJournalEvent, readJournalEvents } from "./journal.js";
import { buildTaskBrief, buildTaskPlan, buildTaskReport, buildTaskResume, reviewApprovalActions } from "./taskOps.js";
import { activeTaskSummary, archiveActiveTask } from "./taskStore.js";
import { decideCommandPolicy } from "./policy.js";
import { TOOL_CARD_MIME_TYPE, TOOL_CARD_URI, toolCardWidgetHtml } from "./toolCardWidget.js";
import { redactSensitiveText, redactStructured } from "./redact.js";

function errorText(error: unknown): string {
  if (error instanceof Error) return redactSensitiveText(`${error.name}: ${error.message}`);
  return redactSensitiveText(String(error));
}

function textResult(text: string, structuredContent: Record<string, unknown> = {}, meta: Record<string, unknown> = {}): any {
  return {
    content: [{ type: "text", text: redactSensitiveText(text) }],
    structuredContent: redactStructured(structuredContent),
    _meta: meta
  };
}

function countTextLines(value: string | undefined): number {
  if (!value) return 0;
  return value.split(/\r?\n/).filter((line) => line.length > 0).length;
}

function bashTextResult(config: CodexBridgeConfig, result: Awaited<ReturnType<typeof runBash>>): string {
  if (config.bashTranscript === "full") {
    return `# Bash\n\n\`\`\`bash\n$ ${result.command}\n\`\`\`\n\nCWD: ${result.cwd}\nExit: ${result.exitCode}${result.signal ? ` (${result.signal})` : ""}\nDuration: ${result.durationMs} ms\n\n## stdout\n\n\`\`\`text\n${result.stdout || ""}\n\`\`\`\n\n## stderr\n\n\`\`\`text\n${result.stderr || ""}\n\`\`\``;
  }

  const stdoutLines = countTextLines(result.stdout);
  const stderrLines = countTextLines(result.stderr);
  return [
    "# Bash",
    "",
    `\`${result.command}\``,
    "",
    `CWD: ${result.cwd}`,
    `Exit: ${result.exitCode}${result.signal ? ` (${result.signal})` : ""}`,
    `Duration: ${result.durationMs} ms`,
    `Output: stdout ${stdoutLines} line${stdoutLines === 1 ? "" : "s"}, stderr ${stderrLines} line${stderrLines === 1 ? "" : "s"}.`,
    "",
    "Raw stdout/stderr are in the structured CodexBridge card. Start with `--bash-transcript full` to print raw output in chat."
  ].join("\n");
}

function sshTextResult(result: SshExecResult): string {
  if (result.dry_run) {
    return [
      "# SSH Dry Run",
      "",
      `Profile: ${result.profile}`,
      `Target: ${result.user ? `${result.user}@` : ""}${result.host}:${result.port}`,
      `Mode: ${result.mode}`,
      `Policy: ${result.policy.decision} (${result.policy.risk})`,
      "",
      "## Remote Command",
      "",
      "```bash",
      result.remote_command,
      "```",
      "",
      "## Local argv",
      "",
      "```text",
      result.argv.join(" "),
      "```"
    ].join("\n");
  }
  const stdoutLines = countTextLines(result.stdout);
  const stderrLines = countTextLines(result.stderr);
  return [
    "# SSH",
    "",
    `Profile: ${result.profile}`,
    `Target: ${result.user ? `${result.user}@` : ""}${result.host}:${result.port}`,
    `Mode: ${result.mode}`,
    `Exit: ${result.exitCode}${result.signal ? ` (${result.signal})` : ""}`,
    `Duration: ${result.durationMs} ms`,
    `Output: stdout ${stdoutLines} line${stdoutLines === 1 ? "" : "s"}, stderr ${stderrLines} line${stderrLines === 1 ? "" : "s"}.`,
    "",
    "Raw stdout/stderr are in the structured CodexBridge card."
  ].join("\n");
}

function errorResult(error: unknown): any {
  return {
    isError: true,
    content: [{ type: "text", text: errorText(error) }],
    structuredContent: { error: errorText(error) }
  };
}

function tagToolResult(result: any, name: string, options: Record<string, unknown>): any {
  if (!result || typeof result !== "object") return result;
  const structured = result.structuredContent;
  const base =
    structured && typeof structured === "object" && !Array.isArray(structured)
      ? structured
      : {};
  result.structuredContent = {
    codexbridge_tool: name,
    codexbridge_title: options.title ?? name,
    ...base
  };
  return result;
}

function toolCardMeta(): Record<string, unknown> {
  return {
    ui: { resourceUri: TOOL_CARD_URI },
    "openai/outputTemplate": TOOL_CARD_URI
  };
}

function toolCallLoggingEnabled(): boolean {
  return process.env.CODEXBRIDGE_LOG_TOOL_CALLS === "1" || process.env.CODEXBRIDGE_LOG_REQUESTS === "1";
}

function logToolCall(name: string, status: "ok" | "error", started: number): void {
  if (!toolCallLoggingEnabled()) return;
  console.error(`[CodexBridgeTool] ${name} ${status} ${Date.now() - started}ms`);
}

function registerToolCardResource(server: McpServer, config: CodexBridgeConfig): void {
  const s = server as any;
  if (typeof s.registerResource !== "function") return;
  s.registerResource(
    "codexbridge-tool-card",
    TOOL_CARD_URI,
    {
      title: "CodexBridge Tool Card",
      description: "Compact visual renderer for CodexBridge workspace orientation, source changes, and handoffs.",
      mimeType: TOOL_CARD_MIME_TYPE
    },
    async () => ({
      contents: [
        {
          uri: TOOL_CARD_URI,
          mimeType: TOOL_CARD_MIME_TYPE,
          text: toolCardWidgetHtml,
          _meta: {
            ui: {
              prefersBorder: true,
              domain: config.widgetDomain,
              csp: {
                connectDomains: [],
                resourceDomains: []
              }
            },
            "openai/widgetDescription": "Renders CodexBridge workspace orientation, diagnostics, file diffs, change reviews, terminal checks, Pro context exports, and handoff plans as compact developer cards with bounded previews.",
            "openai/widgetPrefersBorder": true,
            "openai/widgetDomain": config.widgetDomain,
            "openai/widgetCSP": {
              connect_domains: [],
              resource_domains: []
            }
          }
        }
      ]
    })
  );
}


function isContextPath(config: CodexBridgeConfig, relPath: string): boolean {
  const normalized = relPath.split(path.sep).join("/").replace(/^\.\//, "");
  const contextDir = config.contextDir.replace(/^\.\//, "").replace(/\/$/, "");
  return normalized === contextDir || normalized.startsWith(`${contextDir}/`);
}

function assertWriteToolAllowed(config: CodexBridgeConfig, relPath: string): void {
  if (config.writeMode === "workspace") return;
  if (config.writeMode === "handoff" && isContextPath(config, relPath)) return;
  if (config.writeMode === "handoff") {
    throw new CodexBridgeError(
      `Source writes are disabled because CODEXBRIDGE_WRITE_MODE=handoff. ` +
        `Use handoff_to_agent or handoff_to_codex, or write/edit only inside ${config.contextDir}/.`
    );
  }
  throw new CodexBridgeError("write/edit tools are disabled because CODEXBRIDGE_WRITE_MODE=off. handoff_to_agent and handoff_to_codex are still available for planning.");
}

function registerToolCompat(
  server: McpServer,
  name: string,
  options: Record<string, unknown>,
  handler: (args: any) => Promise<any> | any
): void {
  const wrapped = async (args: any) => {
    const started = Date.now();
    try {
      const result = tagToolResult(await handler(args ?? {}), name, options);
      logToolCall(name, result?.isError ? "error" : "ok", started);
      return result;
    } catch (error) {
      const result = tagToolResult(errorResult(error), name, options);
      logToolCall(name, "error", started);
      return result;
    }
  };

  const securitySchemes = [{ type: "noauth" }];
  const fullOptions: Record<string, unknown> = {
    securitySchemes,
    ...options,
    _meta: {
      securitySchemes,
      ...(options._meta as Record<string, unknown> | undefined)
    }
  };

  const s = server as any;
  if (typeof s.registerTool === "function") {
    s.registerTool(name, fullOptions, wrapped);
    return;
  }

  if (typeof s.tool === "function") {
    s.tool(name, (fullOptions.description as string | undefined) ?? name, fullOptions.inputSchema ?? {}, wrapped);
    return;
  }

  throw new Error("Unsupported MCP SDK: McpServer has neither registerTool nor tool.");
}

const MINIMAL_TOOL_NAMES = [
  "server_config",
  "codexbridge_self_test",
  "open_current_workspace",
  "open_workspace",
  "read",
  "write",
  "edit",
  "bash",
  "show_changes"
] as const;

const STANDARD_TOOL_NAMES = [
  ...MINIMAL_TOOL_NAMES,
  "tree",
  "search",
  "load_skill",
  "preview_change_set",
  "apply_change_set",
  "preview_rollback_change_set",
  "approval_review",
  "task_brief",
  "task_plan",
  "task_verify",
  "task_report",
  "task_resume",
  "ssh_profiles",
  "ssh_exec",
  "operation_journal",
  "read_handoff",
  "export_pro_context",
  "handoff_to_agent"
] as const;

const FULL_TOOL_NAMES = [
  "server_config",
  "codexbridge_self_test",
  "codexbridge_inventory",
  "load_skill",
  "list_workspaces",
  "open_current_workspace",
  "open_workspace",
  "workspace_snapshot",
  "tree",
  "search",
  "read",
  "write",
  "edit",
  "preview_change_set",
  "apply_change_set",
  "preview_rollback_change_set",
  "approval_review",
  "task_brief",
  "task_plan",
  "task_verify",
  "task_report",
  "task_resume",
  "bash",
  "ssh_profiles",
  "ssh_exec",
  "git_status",
  "git_diff",
  "show_changes",
  "operation_journal",
  "read_handoff",
  "codex_context",
  "export_pro_context",
  "handoff_to_agent",
  "handoff_to_codex"
] as const;

function codexSessionToolNames(config: CodexBridgeConfig): string[] {
  if (config.codexSessions === "off") return [];
  return config.codexSessions === "read"
    ? ["codex_sessions", "read_codex_session"]
    : ["codex_sessions"];
}

function toolNamesForMode(config: CodexBridgeConfig): string[] {
  const names: string[] =
    config.toolMode === "full"
      ? [...FULL_TOOL_NAMES]
      : config.toolMode === "minimal"
        ? [...MINIMAL_TOOL_NAMES]
        : [...STANDARD_TOOL_NAMES];
  for (const name of codexSessionToolNames(config)) {
    if (!names.includes(name)) names.push(name);
  }
  return names;
}

const MINIMAL_TOOLS = new Set<string>(MINIMAL_TOOL_NAMES);
const STANDARD_TOOLS = new Set<string>(STANDARD_TOOL_NAMES);

function shouldRegisterTool(config: CodexBridgeConfig, name: string): boolean {
  if (name === "codex_sessions") return config.codexSessions !== "off";
  if (name === "read_codex_session") return config.codexSessions === "read";
  if (config.toolMode === "full") return true;
  if (config.toolMode === "minimal") return MINIMAL_TOOLS.has(name);
  return STANDARD_TOOLS.has(name);
}

function registerCodexTool(
  config: CodexBridgeConfig,
  server: McpServer,
  name: string,
  options: Record<string, unknown>,
  handler: (args: any) => Promise<any> | any
): void {
  if (!shouldRegisterTool(config, name)) return;
  registerToolCompat(server, name, options, handler);
}

function serverInstructions(config: CodexBridgeConfig): string {
  return [
    "CodexBridge connects ChatGPT to one local development workspace.",
    "",
    "Preferred workflow:",
    "1. Start with open_current_workspace. Use open_workspace only when the user gives a different root or asks to switch folders.",
    "2. For coding tasks, call task_brief and task_plan so repo rules, approval scope, and verification commands are explicit.",
    "3. Follow any AGENTS.md-style instructions returned by the workspace open call or task_brief before editing files.",
    "4. Inspect with tree, search, and read. Do not use bash for git status, git diff, cat, sed, grep, rg, find, ls, or file reading.",
    "5. Prefer preview_change_set, approval_review, and apply_change_set for multi-file or hash-sensitive edits.",
    "6. Use task_verify or bash only for meaningful verification commands such as npm test, npm run build, lint, typecheck, or an existing project script.",
    "7. Finish coding tasks with task_report or show_changes for git status, diff stats, journal events, and review diff.",
    "8. Keep tool calls minimal. Prefer one targeted search plus task_report/show_changes instead of repeated broad bash/git calls.",
    config.codexSessions !== "off"
      ? `9. Codex session history access is enabled in ${config.codexSessions} mode. Use it only when the user asks for local Codex session history.`
      : "",
    config.requireBashSession && config.bashSessionId
      ? `10. Bash session guard is enabled. Every bash call must include session_id="${config.bashSessionId}".`
      : config.bashSessionId
        ? `10. Bash session label for this server is "${config.bashSessionId}".`
        : "",
    "",
    `Current modes: tool=${config.toolMode}, bash=${config.bashMode}, ssh=${config.sshMode}, write=${config.writeMode}.`
  ].filter(Boolean).join("\n");
}

function limitInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value ?? fallback);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function parseBool(value: unknown, fallback = false): boolean {
  if (typeof value === "boolean") return value;
  if (value === undefined || value === null) return fallback;
  return ["1", "true", "yes", "y"].includes(String(value).toLowerCase());
}

function diffBlock(diff: string): string {
  return `\n\n\`\`\`diff\n${diff}\n\`\`\``;
}

function diffStats(diff: string): { additions: number; deletions: number; changed: boolean } {
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions += 1;
    if (line.startsWith("-") && !line.startsWith("---")) deletions += 1;
  }
  return { additions, deletions, changed: Boolean(diff.trim()) };
}

function normalizeGitOutput(output: string): string {
  return output.trim() === "(no output)" ? "" : output;
}

function looksLikeGitError(output: string): boolean {
  const trimmed = output.trim();
  const lower = trimmed.toLowerCase();
  return (
    trimmed.startsWith("fatal:") ||
    trimmed.startsWith("error:") ||
    trimmed.startsWith("git unavailable or failed:") ||
    trimmed.startsWith("git exited with status") ||
    trimmed.startsWith("usage: git ") ||
    lower.includes("not a git repository")
  );
}

function previewText(value: string, maxLines = 40, maxChars = 12_000): string {
  const lines = value.replace(/\r\n/g, "\n").split("\n").slice(0, maxLines).join("\n");
  return lines.length > maxChars ? `${lines.slice(0, maxChars)}\n...[preview truncated]` : lines;
}

function changedStatusLines(status: string): string[] {
  return status
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("##"));
}

function jsonlEvent(event: string, data: Record<string, unknown>): string {
  return JSON.stringify({ ts: new Date().toISOString(), event, ...data }) + "\n";
}

function cleanOneLine(value: unknown, fallback: string, maxLength = 120): string {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return (text || fallback).slice(0, maxLength);
}

function normalizeChangeSetInput(value: unknown): ChangeSetInput[] {
  if (!Array.isArray(value)) throw new CodexBridgeError("changes must be an array.");
  const out: ChangeSetInput[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new CodexBridgeError("Each change must be an object.");
    }
    const change = item as Record<string, unknown>;
    if (typeof change.unified_diff === "string") {
      out.push(...changesFromUnifiedDiff({
        unified_diff: change.unified_diff,
        path: typeof change.path === "string" ? change.path : undefined,
        base_sha256: typeof change.base_sha256 === "string" ? change.base_sha256 : undefined
      }));
      continue;
    }
    const pathValue = String(change.path ?? "").trim();
    if (!pathValue) throw new CodexBridgeError("Each change requires path.");
    if (typeof change.old_text === "string") {
      out.push({
        path: pathValue,
        old_text: change.old_text,
        new_text: String(change.new_text ?? ""),
        replace_all: parseBool(change.replace_all, false),
        expected_replacements: typeof change.expected_replacements === "number" ? change.expected_replacements : undefined,
        base_sha256: typeof change.base_sha256 === "string" ? change.base_sha256 : undefined
      });
      continue;
    }
    if (typeof change.content === "string") {
      out.push({
        path: pathValue,
        content: change.content,
        create_dirs: parseBool(change.create_dirs, true),
        overwrite: parseBool(change.overwrite, true),
        base_sha256: typeof change.base_sha256 === "string" ? change.base_sha256 : undefined
      });
      continue;
    }
    throw new CodexBridgeError(`Change for ${pathValue} must include either content or old_text.`);
  }
  return out;
}

function normalizeRollbackChangeSetInput(value: unknown): ChangeSetInput[] {
  if (!Array.isArray(value)) throw new CodexBridgeError("changes must be an array.");
  return value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new CodexBridgeError("Each rollback change must be an object.");
    }
    const change = item as Record<string, unknown>;
    const pathValue = String(change.path ?? "").trim();
    if (!pathValue) throw new CodexBridgeError("Each rollback change requires path.");
    if (change.kind !== "edit" || typeof change.old_text !== "string" || typeof change.new_text !== "string") {
      throw new CodexBridgeError(`Rollback preview currently supports exact edit changes only: ${pathValue}`);
    }
    return {
      path: pathValue,
      old_text: change.new_text,
      new_text: change.old_text,
      expected_replacements: typeof change.replacements === "number" ? change.replacements : 1,
      base_sha256: typeof change.next_sha256 === "string" ? change.next_sha256 : undefined
    };
  });
}

function normalizeApprovalActions(value: unknown): Array<{ type: "command"; command: string } | { type: "ssh_command"; command: string; profile?: string } | { type: "change_set"; changes: ChangeSetInput[] }> {
  if (!Array.isArray(value)) throw new CodexBridgeError("actions must be an array.");
  return value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new CodexBridgeError("Each approval action must be an object.");
    }
    const action = item as Record<string, unknown>;
    if (action.type === "command") {
      return { type: "command", command: String(action.command ?? "") };
    }
    if (action.type === "ssh_command") {
      return {
        type: "ssh_command",
        command: String(action.command ?? ""),
        profile: typeof action.profile === "string" ? action.profile : undefined
      };
    }
    if (action.type === "change_set") {
      return { type: "change_set", changes: normalizeChangeSetInput(action.changes) };
    }
    throw new CodexBridgeError("approval action type must be command, ssh_command, or change_set.");
  });
}

function normalizeAgentId(value: unknown): string {
  const agent = cleanOneLine(value, "custom", 64).toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(agent)) {
    throw new CodexBridgeError("agent must use only lowercase letters, numbers, dots, underscores, or hyphens.");
  }
  return agent;
}

function displayAgentName(agent: string, agentName?: unknown): string {
  const explicit = cleanOneLine(agentName, "", 80);
  if (explicit) return explicit;
  if (agent === "codex") return "Codex";
  if (agent === "opencode") return "OpenCode";
  if (agent === "pi") return "Pi";
  return agent;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function agentCommandHint(agent: string, planPath: string, model?: string): string {
  const modelArg = model ? ` --model ${shellQuote(model)}` : " --model '<provider/model>'";
  const quotedPlanPath = shellQuote(planPath);
  if (agent === "opencode") return `opencode run${modelArg} "$(cat ${quotedPlanPath})"`;
  if (agent === "pi") return `pi run${modelArg} "$(cat ${quotedPlanPath})"`;
  if (agent === "codex") return `Read ${planPath} and execute it in small, reviewable steps.`;
  return `Run your local implementation agent manually with ${planPath} as the task input.`;
}

async function readRawTextFileBounded(config: CodexBridgeConfig, guard: PathGuard, workspace: Workspace, filePath: string): Promise<string> {
  const resolved = guard.resolve(workspace, filePath);
  await guard.assertTextFile(resolved.absPath, config.maxReadBytes);
  return fsp.readFile(resolved.absPath, "utf8");
}

function buildAgentPlanBody(options: {
  title: string;
  plan: string;
  workspace: Workspace;
  agent: string;
  agentName: string;
  model?: string;
  statusPath: string;
  diffPath: string;
  executionLogPath: string;
}): string {
  const modelLine = options.model ? `Model: ${options.model}\n` : "";
  return `# ${options.title}

Updated: ${new Date().toISOString()}
Workspace: ${options.workspace.root}
Target agent: ${options.agentName} (${options.agent})
${modelLine}
## Plan

${options.plan.trim()}

## Implementation contract

- Work from this plan in small, reviewable steps.
- Keep edits scoped to the requested task and existing project conventions.
- Run focused verification before handing work back.
- Update ${options.statusPath} with files touched, checks run, results, blockers, and review notes.
- Save the final review diff to ${options.diffPath} when practical.
- Append notable execution events to ${options.executionLogPath} when the implementation agent supports logging.
`;
}

async function writeAgentHandoff(
  config: CodexBridgeConfig,
  guard: PathGuard,
  workspace: Workspace,
  options: {
    agent: string;
    agentName?: string;
    model?: string;
    title: string;
    plan: string;
    append: boolean;
    eventName: string;
  }
): Promise<{
  agent: string;
  agentName: string;
  model?: string;
  title: string;
  planPath: string;
  statusPath: string;
  diffPath: string;
  logPath: string;
  executionLogPath: string;
  prompt: string;
  writeResult: Awaited<ReturnType<typeof writeTextFile>>;
}> {
  await ensureAiBridge(config, guard, workspace);
  const agent = normalizeAgentId(options.agent);
  const agentName = displayAgentName(agent, options.agentName);
  const model = options.model ? cleanOneLine(options.model, "", 120) : undefined;
  const plan = String(options.plan ?? "").trim();
  if (!plan) throw new CodexBridgeError("plan must not be empty.");
  const planPath = `${config.contextDir}/current-plan.md`;
  const statusPath = `${config.contextDir}/agent-status.md`;
  const legacyCodexStatusPath = `${config.contextDir}/codex-status.md`;
  const diffPath = `${config.contextDir}/implementation-diff.patch`;
  const logPath = `${config.contextDir}/session-log.jsonl`;
  const executionLogPath = `${config.contextDir}/execution-log.jsonl`;
  const body = buildAgentPlanBody({
    title: options.title,
    plan,
    workspace,
    agent,
    agentName,
    model,
    statusPath,
    diffPath,
    executionLogPath
  });

  let content = body;
  if (options.append) {
    const raw = await readRawTextFileBounded(config, guard, workspace, planPath);
    content = `${raw.trimEnd()}\n\n---\n\n${body}`;
  }

  const writeResult = await writeTextFile(config, guard, workspace, planPath, content, { createDirs: true, overwrite: true });
  const event = {
    agent,
    agent_name: agentName,
    model,
    title: options.title,
    plan_path: planPath,
    status_path: statusPath,
    diff_path: diffPath
  };
  const logResolved = guard.resolve(workspace, logPath, { forWrite: true });
  const executionLogResolved = guard.resolve(workspace, executionLogPath, { forWrite: true });
  await fsp.appendFile(logResolved.absPath, jsonlEvent(options.eventName, event), "utf8");
  await fsp.appendFile(executionLogResolved.absPath, jsonlEvent(options.eventName, event), "utf8");

  const promptLines = [
    `Read ${planPath} and execute it in small, reviewable steps.`,
    `After each meaningful change, update ${statusPath} with files touched, checks run, results, blockers, and the next review focus.`,
    `Before review, write the final diff to ${diffPath} when practical.`,
    agentCommandHint(agent, planPath, model)
  ];
  if (agent === "codex") {
    promptLines.splice(2, 0, `For legacy Codex handoffs, mirror key status notes to ${legacyCodexStatusPath} if your workflow expects that file.`);
  }
  const prompt = promptLines.join("\n");

  return {
    agent,
    agentName,
    model,
    title: options.title,
    planPath,
    statusPath,
    diffPath,
    logPath,
    executionLogPath,
    prompt,
    writeResult
  };
}

const READ_ONLY_ANNOTATIONS = { readOnlyHint: true, openWorldHint: false, destructiveHint: false };
const SESSION_READ_ANNOTATIONS = { readOnlyHint: true, openWorldHint: false, destructiveHint: false, idempotentHint: false };
const LOCAL_WRITE_ANNOTATIONS = { readOnlyHint: false, openWorldHint: false, destructiveHint: true, idempotentHint: false };
const BASH_ANNOTATIONS = { readOnlyHint: false, openWorldHint: true, destructiveHint: true, idempotentHint: false };
const HANDOFF_WRITE_ANNOTATIONS = { readOnlyHint: false, openWorldHint: false, destructiveHint: false, idempotentHint: false };

const workspaceManagers = new Map<string, WorkspaceManager>();

function workspaceManagerKey(config: CodexBridgeConfig): string {
  return JSON.stringify({
    defaultRoot: config.defaultRoot,
    allowedRoots: [...config.allowedRoots].sort(),
    contextDir: config.contextDir
  });
}

function getSharedWorkspaceManager(config: CodexBridgeConfig): WorkspaceManager {
  const key = workspaceManagerKey(config);
  const existing = workspaceManagers.get(key);
  if (existing) return existing;
  const manager = new WorkspaceManager(config);
  workspaceManagers.set(key, manager);
  return manager;
}

export function createCodexBridgeServer(config: CodexBridgeConfig): McpServer {
  const workspaces = getSharedWorkspaceManager(config);
  const guard = new PathGuard(config);
  const server = new McpServer({ name: "CodexBridge", version: "0.28.5" }, { instructions: serverInstructions(config) });
  registerToolCardResource(server, config);

  registerCodexTool(
    config,
    server,
    "server_config",
    {
      title: "Server Config",
      description: "Show CodexBridge server configuration, safety modes, limits, and blocked paths. Does not reveal auth tokens.",
      inputSchema: {},
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Reading CodexBridge server config...",
        "openai/toolInvocation/invoked": "CodexBridge server config ready"
      }
    },
    async () => {
      const safeConfig = {
        defaultRoot: config.defaultRoot,
        allowedRoots: config.allowedRoots,
        host: config.host,
        port: config.port,
        widgetDomain: config.widgetDomain,
        authEnabled: Boolean(config.authToken),
        bashMode: config.bashMode,
        bashTranscript: config.bashTranscript,
        bashSessionId: config.bashSessionId ?? null,
        requireBashSession: config.requireBashSession,
        sshMode: config.sshMode,
        sshProfiles: Object.keys(config.sshProfiles).length,
        codexSessions: config.codexSessions,
        codexDir: config.codexDir,
        writeMode: config.writeMode,
        toolMode: config.toolMode,
        inheritEnv: config.inheritEnv,
        contextDir: config.contextDir,
        maxReadBytes: config.maxReadBytes,
        maxWriteBytes: config.maxWriteBytes,
        maxOutputBytes: config.maxOutputBytes,
        maxSearchResults: config.maxSearchResults,
        maxJournalEvents: config.maxJournalEvents,
        blockedGlobs: config.blockedGlobs
      };
      return textResult(`# CodexBridge Server Config\n\n${JSON.stringify(safeConfig, null, 2)}`, safeConfig);
    }
  );

  registerCodexTool(
    config,
    server,
    "codexbridge_self_test",
    {
      title: "CodexBridge Self Test",
      description:
        "Run one controlled, local-only CodexBridge diagnostic. It checks modes, expected tools, workspace access, skills, git, safe bash policy, selected-only Pro context, and optional .ai-bridge write/edit without touching source files.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace."),
        write_probe: z.boolean().optional().describe("Create/edit only .ai-bridge/codexbridge-self-test.md. Default: true."),
        bash_probe: z.boolean().optional().describe("Check bash policy with safe local commands only. Default: true."),
        pro_context_probe: z.boolean().optional().describe("Build a selected-only Pro context bundle in memory without writing pro-context.md. Default: true."),
        include_global_skills: z.boolean().optional().describe("Include user/plugin skill discovery in the inventory check. Default: true."),
        max_skills: z.number().int().min(1).max(120).optional().describe("Maximum skills to inspect during the inventory check. Default: 40.")
      },
      annotations: HANDOFF_WRITE_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Running CodexBridge self-test...",
        "openai/toolInvocation/invoked": "CodexBridge self-test complete"
      }
    },
    async (args) => {
      const workspace = workspaces.getWorkspace(args.workspace_id);
      const started = Date.now();
      const checks: Array<{ name: string; status: "pass" | "warn" | "fail"; detail: string }> = [];
      const filesTouched: string[] = [];
      const probePath = `${config.contextDir}/codexbridge-self-test.md`;

      const check = (name: string, status: "pass" | "warn" | "fail", detail: string) => {
        checks.push({ name, status, detail: cleanOneLine(detail, detail, 260) });
      };

      check("workspace", "pass", workspace.root);
      check("tool mode", config.toolMode === "full" ? "pass" : "warn", `${config.toolMode}; expected tools: ${toolNamesForMode(config).length}`);
      check("write mode", config.writeMode === "off" ? "warn" : "pass", config.writeMode);
      check("bash mode", config.bashMode === "full" ? "warn" : "pass", config.bashMode);
      check(
        "http auth",
        config.requireHttpToken && !config.authToken ? "fail" : "pass",
        config.requireHttpToken ? "token required for public/non-loopback access" : "loopback token not required"
      );
      check("registered tool set", "pass", `${toolNamesForMode(config).length} tools for ${config.toolMode} mode`);

      try {
        const inventory = await codexbridgeInventory(config, workspace, {
          includeGlobalSkills: parseBool(args.include_global_skills, true),
          includeMcpServers: true,
          maxSkills: limitInt(args.max_skills, 40, 1, 120)
        });
        check("inventory", "pass", `${inventory.skills.length} skills inspected, ${inventory.mcpServers.length} MCP server names visible`);
      } catch (error) {
        check("inventory", "fail", errorText(error));
      }

      try {
        const status = gitStatus(config, workspace);
        const gitFailed = looksLikeGitError(status);
        const changed = gitFailed ? 0 : changedStatusLines(status).length;
        check("git status", gitFailed ? "warn" : "pass", gitFailed ? status : `${changed} changed entries`);
      } catch (error) {
        check("git status", "fail", errorText(error));
      }

      if (parseBool(args.write_probe, true)) {
        if (config.writeMode === "off") {
          check("write/edit probe", "warn", "skipped because CODEXBRIDGE_WRITE_MODE=off");
        } else {
          try {
            assertWriteToolAllowed(config, probePath);
            const content = [
              "# CodexBridge Self Test",
              "",
              `Updated: ${new Date().toISOString()}`,
              `Workspace: ${workspace.root}`,
              "marker: before",
              ""
            ].join("\n");
            await writeTextFile(config, guard, workspace, probePath, content, { createDirs: true, overwrite: true });
            await editTextFile(config, guard, workspace, probePath, "marker: before", "marker: after", { expectedReplacements: 1 });
            const readBack = await readTextFile(config, guard, workspace, probePath, { maxBytes: 20_000 });
            if (!readBack.text.includes("marker: after")) throw new CodexBridgeError("self-test edit marker was not found after edit.");
            const scopedStatus = gitStatus(config, workspace, guard, probePath);
            const scopedFiles = changedStatusLines(scopedStatus);
            filesTouched.push(probePath);
            check(
              "write/edit probe",
              scopedFiles.length && scopedFiles.every((line) => line.includes(probePath)) ? "pass" : "warn",
              scopedFiles.length ? `path-scoped status: ${scopedFiles.join(", ")}` : "path-scoped status clean after write/edit"
            );
          } catch (error) {
            check("write/edit probe", "fail", errorText(error));
          }
        }
      } else {
        check("write/edit probe", "warn", "skipped by request");
      }

      if (parseBool(args.pro_context_probe, true)) {
        try {
          if (!filesTouched.includes(probePath)) {
            check("selected-only pro context", "warn", "skipped because write probe did not create the selected file");
          } else {
            const context = await buildProContext(config, guard, workspace, {
              title: "CodexBridge Self Test Context",
              selectedPaths: [probePath],
              includeImportantFiles: false,
              includeChangedFiles: false,
              includeDiff: false,
              includeAiBridge: false,
              maxFiles: 4,
              maxTotalBytes: 80_000
            });
            const exactOnly = context.filesIncluded.length === 1 && context.filesIncluded[0] === probePath;
            check(
              "selected-only pro context",
              exactOnly ? "pass" : "fail",
              exactOnly ? `included only ${probePath}` : `included ${context.filesIncluded.join(", ") || "no files"}`
            );
          }
        } catch (error) {
          check("selected-only pro context", "fail", errorText(error));
        }
      } else {
        check("selected-only pro context", "warn", "skipped by request");
      }

      if (parseBool(args.bash_probe, true)) {
        try {
          if (config.bashMode === "off") {
            check("bash policy", "warn", "bash disabled");
          } else {
            const bashProbeOptions = { timeoutMs: 10_000, sessionId: config.bashSessionId };
            const pwd = await runBash(config, guard, workspace, "pwd", bashProbeOptions);
            if (config.bashMode === "safe") {
              try {
                await runBash(config, guard, workspace, "ls $HOME", bashProbeOptions);
                check("bash policy", "fail", "safe bash allowed environment expansion unexpectedly");
              } catch {
                check("bash policy", pwd.exitCode === 0 ? "pass" : "warn", "safe bash allowed pwd and blocked environment expansion");
              }
            } else {
              check("bash policy", pwd.exitCode === 0 ? "warn" : "fail", "full bash is enabled; use only for trusted local repos");
            }
          }
        } catch (error) {
          check("bash policy", "fail", errorText(error));
        }
      } else {
        check("bash policy", "warn", "skipped by request");
      }

      check(
        "terms boundary",
        "pass",
        "local workspace bridge only; does not provide models, proxy model access, bypass quotas, or execute remote/local agents from MCP"
      );

      const failed = checks.filter((item) => item.status === "fail").length;
      const warned = checks.filter((item) => item.status === "warn").length;
      const passed = checks.filter((item) => item.status === "pass").length;
      const status = failed ? "fail" : warned ? "warn" : "pass";
      const text = [
        "# CodexBridge Self Test",
        "",
        `Status: ${status}`,
        `Workspace: ${workspace.root}`,
        `Mode: tools=${config.toolMode}, write=${config.writeMode}, bash=${config.bashMode}${config.bashSessionId ? `, bash_session=${config.bashSessionId}${config.requireBashSession ? " required" : ""}` : ""}`,
        `Expected tools: ${toolNamesForMode(config).length}`,
        `Duration: ${Date.now() - started} ms`,
        "",
        "## Checks",
        "",
        ...checks.map((item) => `- ${item.status.toUpperCase()} ${item.name}: ${item.detail}`),
        "",
        "## Terms Boundary",
        "",
        "CodexBridge exposes local repo tools to the ChatGPT session the user controls. It does not provide models, proxy model access, resell access, modify quotas, bypass limits, or run local implementation agents through remote MCP tools."
      ].join("\n");

      return textResult(text, {
        workspace_id: workspace.id,
        root: workspace.root,
        status,
        passed,
        warned,
        failed,
        duration_ms: Date.now() - started,
        expected_tools: toolNamesForMode(config),
        expected_tool_count: toolNamesForMode(config).length,
        bash_mode: config.bashMode,
        bash_session_id: config.bashSessionId ?? null,
        require_bash_session: config.requireBashSession,
        write_mode: config.writeMode,
        tool_mode: config.toolMode,
        files_touched: filesTouched,
        checks,
        terms_boundary: {
          local_workspace_bridge: true,
          provides_models: false,
          proxies_model_access: false,
          bypasses_quotas: false,
          remote_agent_execution: false
        }
      });
    }
  );

  registerCodexTool(
    config,
    server,
    "codexbridge_inventory",
    {
      title: "CodexBridge Inventory",
      description:
        "List CodexBridge modes plus discovered skill names and configured MCP server names. Use this early when planning needs local agent capabilities.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace."),
        include_global_skills: z.boolean().optional().describe("Include user and plugin skill folders. Default: true."),
        include_mcp_servers: z.boolean().optional().describe("Include configured MCP server names from safe config files. Default: true."),
        max_skills: z.number().int().min(1).max(500).optional().describe("Maximum skills to list. Default: 120.")
      },
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Reading CodexBridge inventory...",
        "openai/toolInvocation/invoked": "CodexBridge inventory ready"
      }
    },
    async (args) => {
      const workspace = workspaces.getWorkspace(args.workspace_id);
      const inventory = await codexbridgeInventory(config, workspace, {
        includeGlobalSkills: parseBool(args.include_global_skills, true),
        includeMcpServers: parseBool(args.include_mcp_servers, true),
        maxSkills: limitInt(args.max_skills, 120, 1, 500)
      });
      return textResult(inventory.text, {
        workspace_id: workspace.id,
        root: workspace.root,
        bash_mode: config.bashMode,
        write_mode: config.writeMode,
        tool_mode: config.toolMode,
        skills: inventory.skills,
        skill_count: inventory.skills.length,
        mcp_servers: inventory.mcpServers,
        mcp_server_count: inventory.mcpServers.length,
        widget_uri: TOOL_CARD_URI
      });
    }
  );

  registerCodexTool(
    config,
    server,
    "load_skill",
    {
      title: "Load Skill",
      description:
        "Load the bounded SKILL.md body for a discovered workspace, user, or plugin skill by name. Does not accept arbitrary paths; use after open_current_workspace/open_workspace shows skill_inventory.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace."),
        name: z.string().describe("Exact skill name from skill_inventory or codexbridge_inventory."),
        source: z.enum(["workspace", "user", "plugin", "other"]).optional().describe("Optional source when multiple skills share a name."),
        path: z.string().optional().describe("Exact sanitized path from skill_inventory when name/source are still ambiguous."),
        include_global_skills: z.boolean().optional().describe("Also scan installed user/plugin skills. Default: true."),
        max_bytes: z.number().int().min(1000).max(100000).optional().describe("Maximum bytes to return from SKILL.md. Default: 40000.")
      },
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Loading skill instructions...",
        "openai/toolInvocation/invoked": "Skill instructions loaded"
      }
    },
    async (args) => {
      const workspace = workspaces.getWorkspace(args.workspace_id);
      const loaded = await loadSkill(workspace, {
        name: String(args.name ?? ""),
        source: args.source,
        path: typeof args.path === "string" ? args.path : undefined,
        includeGlobal: parseBool(args.include_global_skills, true),
        maxBytes: limitInt(args.max_bytes, 40_000, 1_000, 100_000)
      });
      const truncated = loaded.truncated ? "\n\n[truncated: increase max_bytes if more context is required]" : "";
      const text = `# Load Skill\n\nName: ${loaded.skill.name}\nSource: ${loaded.skill.source}\nPath: ${loaded.skill.path}\nBytes: ${loaded.bytes}/${loaded.totalBytes}\n\n\`\`\`markdown\n${loaded.text}${truncated}\n\`\`\``;
      return textResult(text, {
        workspace_id: workspace.id,
        root: workspace.root,
        skill: loaded.skill,
        bytes: loaded.bytes,
        total_bytes: loaded.totalBytes,
        truncated: loaded.truncated,
        text: loaded.text
      });
    }
  );

  registerCodexTool(
    config,
    server,
    "list_workspaces",
    {
      title: "List Workspaces",
      description: "List currently opened CodexBridge workspaces for this MCP session.",
      inputSchema: {},
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Listing CodexBridge workspaces...",
        "openai/toolInvocation/invoked": "CodexBridge workspaces listed"
      }
    },
    async () => {
      const current = workspaces.listWorkspaces();
      const text = current.length
        ? current.map((workspace) => `- ${workspace.id} — ${workspace.root} (opened ${workspace.openedAt})`).join("\n")
        : "No workspaces opened yet. Call open_workspace first.";
      return textResult(text, { workspaces: current, count: current.length });
    }
  );

  registerCodexTool(
    config,
    server,
    "open_current_workspace",
    {
      title: "Open Current Workspace",
      description:
        "Use this once at the start to open the configured default workspace without accepting a path. Do not call open_workspace after this unless switching roots.",
      inputSchema: {
        include_tree: z.boolean().optional().describe("Include a compact file tree. Default: false for speed."),
        max_depth: z.number().int().min(1).max(8).optional().describe("Tree depth when include_tree=true. Default: 2."),
        include_skills: z.boolean().optional().describe("Discover workspace, user, and plugin skills by name/description. Default: true."),
        include_global_skills: z.boolean().optional().describe("Also scan installed user/plugin skills when include_skills=true. Default: true.")
      },
      annotations: SESSION_READ_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Opening current CodexBridge workspace...",
        "openai/toolInvocation/invoked": "Current CodexBridge workspace opened"
      }
    },
    async (args) => {
      const workspace = workspaces.defaultWorkspace();
      const summary = await workspaceSummary(config, guard, workspace, {
        includeTree: parseBool(args.include_tree, false),
        maxDepth: limitInt(args.max_depth, 2, 1, 8),
        includeSkills: parseBool(args.include_skills, true),
        includeGlobalSkills: parseBool(args.include_global_skills, true),
        bootstrapContext: false
      });
      const activeTask = activeTaskSummary(config, guard, workspace);
      return textResult(summary.text, {
        workspace_id: summary.workspaceId,
        root: summary.root,
        agents_loaded: summary.agentsLoaded,
        agents_path: summary.agentsPath,
        skills: summary.skills,
        skill_inventory: summary.skillInventory,
        skill_counts: summary.skillCounts,
        tree: summary.tree,
        git_status: summary.gitStatus,
        bash_mode: config.bashMode,
        write_mode: config.writeMode,
        tool_mode: config.toolMode,
        active_task: activeTask
      });
    }
  );

  registerCodexTool(
    config,
    server,
    "open_workspace",
    {
      title: "Open Workspace",
      description:
        "Open a local project directory as a CodexBridge workspace. Returns a workspace_id plus git status, AGENTS.md, skills, and a compact file tree.",
      inputSchema: {
        root: z.string().optional().describe("Project directory to open. Omit to use CODEXBRIDGE_ROOT/current working directory. Supports ~/ paths."),
        path: z.string().optional().describe("Alias for root. Useful for clients that naturally send path instead of root."),
        include_tree: z.boolean().optional().describe("Include a compact file tree. Default: true."),
        max_depth: z.number().int().min(1).max(8).optional().describe("Tree depth. Default: 3."),
        max_files: z.number().int().min(1).max(3000).optional().describe("Alias for maximum tree entries. Default: 500."),
        include_skills: z.boolean().optional().describe("Discover workspace, user, and plugin skills by name/description. Default: true."),
        include_global_skills: z.boolean().optional().describe("Also scan installed user/plugin skills when include_skills=true. Default: true."),
        bootstrap_context: z.boolean().optional().describe("Deprecated and ignored. Use handoff_to_agent to create .ai-bridge files.")
      },
      annotations: SESSION_READ_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Opening CodexBridge workspace...",
        "openai/toolInvocation/invoked": "CodexBridge workspace opened"
      }
    },
    async (args) => {
      if (args.root && args.path && args.root !== args.path) {
        throw new CodexBridgeError("open_workspace accepts either root or path. If both are provided, they must match.");
      }
      const workspace = workspaces.openWorkspace(args.root ?? args.path);
      const summary = await workspaceSummary(config, guard, workspace, {
        includeTree: args.include_tree !== false,
        maxDepth: limitInt(args.max_depth, 3, 1, 8),
        maxEntries: limitInt(args.max_files, 500, 1, 3000),
        includeSkills: parseBool(args.include_skills, true),
        includeGlobalSkills: parseBool(args.include_global_skills, true),
        bootstrapContext: false
      });
      const activeTask = activeTaskSummary(config, guard, workspace);
      return textResult(summary.text, {
        workspace_id: summary.workspaceId,
        root: summary.root,
        agents_loaded: summary.agentsLoaded,
        agents_path: summary.agentsPath,
        skills: summary.skills,
        skill_inventory: summary.skillInventory,
        skill_counts: summary.skillCounts,
        tree: summary.tree,
        git_status: summary.gitStatus,
        bash_mode: config.bashMode,
        write_mode: config.writeMode,
        tool_mode: config.toolMode,
        active_task: activeTask
      });
    }
  );

  registerCodexTool(
    config,
    server,
    "workspace_snapshot",
    {
      title: "Workspace Snapshot",
      description: "Return git status, recent commits, .ai-bridge context, and a compact tree for an opened workspace.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace."),
        max_depth: z.number().int().min(1).max(8).optional().describe("Tree depth. Default: 3."),
        max_files: z.number().int().min(1).max(3000).optional().describe("Alias for maximum tree entries. Default: 500."),
        include_skills: z.boolean().optional().describe("Discover repo-local skills. Default: false for speed."),
        include_global_skills: z.boolean().optional().describe("Also scan home-level skill folders when include_skills=true. Default: false.")
      },
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Collecting workspace snapshot...",
        "openai/toolInvocation/invoked": "Workspace snapshot ready"
      }
    },
    async (args) => {
      const workspace = workspaces.getWorkspace(args.workspace_id);
      const summary = await workspaceSummary(config, guard, workspace, {
        includeTree: true,
        maxDepth: limitInt(args.max_depth, 3, 1, 8),
        maxEntries: limitInt(args.max_files, 500, 1, 3000),
        includeSkills: parseBool(args.include_skills, false),
        includeGlobalSkills: parseBool(args.include_global_skills, false)
      });
      const ai = await readAiBridgeContext(config, guard, workspace);
      const text = `${summary.text}\n\n## AI handoff context\n\n${ai.text}`;
      return textResult(text, {
        workspace_id: workspace.id,
        root: workspace.root,
        agents_loaded: summary.agentsLoaded,
        agents_path: summary.agentsPath,
        skills: summary.skills,
        skill_inventory: summary.skillInventory,
        skill_counts: summary.skillCounts,
        tree: summary.tree,
        git_status: summary.gitStatus,
        ai_context_files: ai.files,
        bash_mode: config.bashMode,
        write_mode: config.writeMode,
        tool_mode: config.toolMode
      });
    }
  );

  registerCodexTool(
    config,
    server,
    "tree",
    {
      title: "File Tree",
      description: "List files and directories inside the workspace, excluding blocked paths.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace."),
        path: z.string().optional().describe("Directory relative to workspace root. Default: ."),
        max_depth: z.number().int().min(1).max(12).optional().describe("Maximum depth. Default: 4."),
        include_hidden: z.boolean().optional().describe("Include dotfiles/dotfolders that are not blocked. Default: false."),
        max_entries: z.number().int().min(1).max(3000).optional().describe("Maximum entries. Default: 800.")
      },
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Listing workspace files...",
        "openai/toolInvocation/invoked": "Workspace files listed"
      }
    },
    async (args) => {
      const workspace = workspaces.getWorkspace(args.workspace_id);
      const result = await repoTree(config, guard, workspace, {
        path: args.path ?? ".",
        maxDepth: limitInt(args.max_depth, 4, 1, 12),
        includeHidden: parseBool(args.include_hidden, false),
        maxEntries: limitInt(args.max_entries, 800, 1, 3000)
      });
      return textResult(result.text, { workspace_id: workspace.id, root: workspace.root, ...result });
    }
  );

  registerCodexTool(
    config,
    server,
    "search",
    {
      title: "Search Files",
      description: "Use this for targeted verification or code lookup. Prefer one specific final search instead of repeated broad verification searches.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace."),
        query: z.string().describe("Text or regex to search for."),
        regex: z.boolean().optional().describe("Treat query as a regular expression. Default: false."),
        path: z.string().optional().describe("Directory or file relative to workspace root. Default: ."),
        glob: z.string().optional().describe("Optional glob, for example src/**/*.ts."),
        include_hidden: z.boolean().optional().describe("Include hidden files that are not blocked. Default: false."),
        max_results: z.number().int().min(1).max(2000).optional().describe("Maximum results. Default from config.")
      },
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Searching workspace...",
        "openai/toolInvocation/invoked": "Workspace search complete"
      }
    },
    async (args) => {
      const workspace = workspaces.getWorkspace(args.workspace_id);
      const result = await searchWorkspace(config, guard, workspace, {
        query: args.query,
        regex: parseBool(args.regex, false),
        root: args.path ?? ".",
        glob: args.glob,
        includeHidden: parseBool(args.include_hidden, false),
        maxResults: limitInt(args.max_results, config.maxSearchResults, 1, config.maxSearchResults)
      });
      return textResult(result.text, { workspace_id: workspace.id, root: workspace.root, ...result });
    }
  );

  registerCodexTool(
    config,
    server,
    "read",
    {
      title: "Read File",
      description: "Read a specific text file with line numbers. Avoid rereading files after write/edit unless exact final content is needed.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace."),
        path: z.string().describe("File path relative to workspace root."),
        start_line: z.number().int().min(1).optional().describe("First line to read. Default: 1."),
        end_line: z.number().int().min(1).optional().describe("Last line to read. Default: end of file."),
        max_bytes: z.number().int().min(1000).max(2000000).optional().describe("Maximum file bytes. Capped by server config.")
      },
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Reading file...",
        "openai/toolInvocation/invoked": "File read"
      }
    },
    async (args) => {
      const workspace = workspaces.getWorkspace(args.workspace_id);
      const result = await readTextFile(config, guard, workspace, args.path, {
        startLine: args.start_line,
        endLine: args.end_line,
        maxBytes: args.max_bytes
      });
      const text = `# Read File\n\nPath: ${result.path}\nLines: ${result.startLine}-${result.endLine} of ${result.totalLines}\nBytes: ${result.bytes}\nSHA-256: ${result.sha256}\n\n\`\`\`text\n${result.text}\n\`\`\``;
      return textResult(text, { workspace_id: workspace.id, root: workspace.root, ...result });
    }
  );

  registerCodexTool(
    config,
    server,
    "write",
    {
      title: "Write File",
      description: "Create or overwrite a meaningful text file inside the workspace. Returns a unified diff; do not create empty placeholder files.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace."),
        path: z.string().describe("File path relative to workspace root."),
        content: z.string().describe("Complete file contents to write."),
        create_dirs: z.boolean().optional().describe("Create parent directories if missing. Default: true."),
        overwrite: z.boolean().optional().describe("Allow overwriting existing files. Default: true.")
      },
      annotations: LOCAL_WRITE_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Writing file...",
        "openai/toolInvocation/invoked": "File written"
      }
    },
    async (args) => {
      const workspace = workspaces.getWorkspace(args.workspace_id);
      const resolved = guard.resolve(workspace, args.path, { forWrite: true });
      assertWriteToolAllowed(config, resolved.relPath);
      const result = await writeTextFile(config, guard, workspace, args.path, String(args.content ?? ""), {
        createDirs: args.create_dirs !== false,
        overwrite: args.overwrite !== false
      });
      await appendJournalEvent(config, guard, workspace, {
        event: "write",
        status: "ok",
        paths: [result.path],
        additions: result.diff.additions,
        deletions: result.diff.deletions
      });
      const text = `# Write File\n\nPath: ${result.path}\nExisted before: ${result.existed}\nBytes: ${result.bytes}\nSHA-256: ${result.sha256}\nDiff stats: +${result.diff.additions} -${result.diff.deletions}${diffBlock(result.diff.diff)}`;
      return textResult(text, {
        workspace_id: workspace.id,
        root: workspace.root,
        path: result.path,
        existed: result.existed,
        bytes: result.bytes,
        sha256: result.sha256,
        additions: result.diff.additions,
        deletions: result.diff.deletions,
        diff: result.diff.diff
      });
    }
  );

  registerCodexTool(
    config,
    server,
    "edit",
    {
      title: "Edit File",
      description: "Apply a targeted exact text replacement inside a workspace text file. Returns a unified diff.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace."),
        path: z.string().describe("File path relative to workspace root."),
        old_text: z.string().describe("Exact text to replace. Must match once unless replace_all=true."),
        new_text: z.string().describe("Replacement text."),
        replace_all: z.boolean().optional().describe("Replace all occurrences. Default: false."),
        expected_replacements: z.number().int().min(1).optional().describe("Fail if actual replacement count differs.")
      },
      annotations: LOCAL_WRITE_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Editing file...",
        "openai/toolInvocation/invoked": "File edited"
      }
    },
    async (args) => {
      const workspace = workspaces.getWorkspace(args.workspace_id);
      const resolved = guard.resolve(workspace, args.path, { forWrite: true });
      assertWriteToolAllowed(config, resolved.relPath);
      const result = await editTextFile(config, guard, workspace, args.path, String(args.old_text ?? ""), String(args.new_text ?? ""), {
        replaceAll: parseBool(args.replace_all, false),
        expectedReplacements: args.expected_replacements
      });
      await appendJournalEvent(config, guard, workspace, {
        event: "edit",
        status: "ok",
        paths: [result.path],
        additions: result.diff.additions,
        deletions: result.diff.deletions
      });
      const text = `# Edit File\n\nPath: ${result.path}\nReplacements: ${result.replacements}\nBytes: ${result.bytes}\nSHA-256: ${result.sha256}\nDiff stats: +${result.diff.additions} -${result.diff.deletions}${diffBlock(result.diff.diff)}`;
      return textResult(text, {
        workspace_id: workspace.id,
        root: workspace.root,
        path: result.path,
        replacements: result.replacements,
        bytes: result.bytes,
        sha256: result.sha256,
        additions: result.diff.additions,
        deletions: result.diff.deletions,
        diff: result.diff.diff
      });
    }
  );

  registerCodexTool(
    config,
    server,
    "preview_change_set",
    {
      title: "Preview Change Set",
      description: "Preview a transactional set of text writes and exact replacements. Does not write files.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace."),
        changes: z.array(z.record(z.unknown())).min(1).max(50).describe("Array of write or exact-replacement changes.")
      },
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Previewing change set...",
        "openai/toolInvocation/invoked": "Change set preview ready"
      }
    },
    async (args) => {
      const workspace = workspaces.getWorkspace(args.workspace_id);
      const result = await previewChangeSet(config, guard, workspace, normalizeChangeSetInput(args.changes));
      const text = `# Preview Change Set\n\nChanges: ${result.change_count}\nChanged: ${result.changed}\nDiff stats: +${result.additions} -${result.deletions}${diffBlock(result.diff)}`;
      return textResult(text, {
        workspace_id: workspace.id,
        root: workspace.root,
        ...result
      });
    }
  );

  registerCodexTool(
    config,
    server,
    "apply_change_set",
    {
      title: "Apply Change Set",
      description: "Apply a transactional set of text writes and exact replacements after preview-style validation.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace."),
        changes: z.array(z.record(z.unknown())).min(1).max(50).describe("Array of write or exact-replacement changes.")
      },
      annotations: LOCAL_WRITE_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Applying change set...",
        "openai/toolInvocation/invoked": "Change set applied"
      }
    },
    async (args) => {
      const workspace = workspaces.getWorkspace(args.workspace_id);
      const started = Date.now();
      const result = await applyChangeSet(config, guard, workspace, normalizeChangeSetInput(args.changes));
      await appendJournalEvent(config, guard, workspace, {
        event: "apply_change_set",
        status: "ok",
        paths: result.changes.map((change) => change.path),
        additions: result.additions,
        deletions: result.deletions,
        durationMs: Date.now() - started
      });
      const text = `# Apply Change Set\n\nApplied: ${result.applied}\nChanges: ${result.change_count}\nDiff stats: +${result.additions} -${result.deletions}${diffBlock(result.diff)}`;
      return textResult(text, {
        workspace_id: workspace.id,
        root: workspace.root,
        ...result
      });
    }
  );

  registerCodexTool(
    config,
    server,
    "preview_rollback_change_set",
    {
      title: "Preview Rollback Change Set",
      description: "Preview the inverse of a previously previewed/applied exact-edit change set. Does not write files.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace."),
        changes: z.array(z.record(z.unknown())).min(1).max(50).describe("Change entries returned by preview_change_set or apply_change_set. Exact edit changes only.")
      },
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Previewing rollback...",
        "openai/toolInvocation/invoked": "Rollback preview ready"
      }
    },
    async (args) => {
      const workspace = workspaces.getWorkspace(args.workspace_id);
      const rollbackChanges = normalizeRollbackChangeSetInput(args.changes);
      const result = await previewChangeSet(config, guard, workspace, rollbackChanges);
      const text = `# Preview Rollback Change Set\n\nChanges: ${result.change_count}\nChanged: ${result.changed}\nDiff stats: +${result.additions} -${result.deletions}${diffBlock(result.diff)}`;
      return textResult(text, {
        workspace_id: workspace.id,
        root: workspace.root,
        rollback_changes: rollbackChanges,
        ...result
      });
    }
  );

  registerCodexTool(
    config,
    server,
    "approval_review",
    {
      title: "Approval Review",
      description: "Review proposed commands and change sets before running or applying them. Returns structured decision, scope, risk, and reasons.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace."),
        actions: z.array(z.record(z.unknown())).min(1).max(20).describe("Actions such as {type:'command', command} or {type:'change_set', changes}.")
      },
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Reviewing approval requirements...",
        "openai/toolInvocation/invoked": "Approval review ready"
      }
    },
    async (args) => {
      const workspace = workspaces.getWorkspace(args.workspace_id);
      const result = await reviewApprovalActions(config, guard, workspace, normalizeApprovalActions(args.actions));
      const rows = result.actions.map((action) => `- ${action.scope}: ${action.decision.toUpperCase()} ${action.required ? "(approval required)" : ""} ${action.reason}`).join("\n");
      const text = `# Approval Review\n\nDecision: ${result.decision}\nApproval required: ${result.required}\nRisk: ${result.risk}\n\n${rows}`;
      return textResult(text, { workspace_id: workspace.id, root: workspace.root, ...result });
    }
  );

  registerCodexTool(
    config,
    server,
    "task_brief",
    {
      title: "Task Brief",
      description: "Load the Codex-like task context ChatGPT should use before making repo changes: AGENTS chain, bridge context, git state, and optional tree/diff.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace."),
        goal: z.string().describe("User-facing coding task goal."),
        target_path: z.string().optional().describe("Target file or directory whose AGENTS chain matters. Default: ."),
        include_diff: z.boolean().optional().describe("Include current git diff. Default: false."),
        include_tree: z.boolean().optional().describe("Include a compact repo tree. Default: true.")
      },
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Preparing task brief...",
        "openai/toolInvocation/invoked": "Task brief ready"
      }
    },
    async (args) => {
      const workspace = workspaces.getWorkspace(args.workspace_id);
      const result = await buildTaskBrief(config, guard, workspace, {
        goal: String(args.goal ?? ""),
        targetPath: typeof args.target_path === "string" ? args.target_path : undefined,
        includeDiff: parseBool(args.include_diff, false),
        includeTree: parseBool(args.include_tree, true)
      });
      const activeTask = activeTaskSummary(config, guard, workspace);
      const text = `# Task Brief\n\nGoal: ${result.goal}\nTarget: ${result.target_path}\nAGENTS files: ${result.agents_files.join(", ") || "none"}\nRecommended workflow: ${result.recommended_workflow.join(" -> ")}${activeTask ? `\n\n> There is an in-progress task: ${activeTask.goal}. Call task_resume to continue.` : ""}\n\n${result.context_text}${result.tree ? `\n\n## Tree\n\n\`\`\`text\n${result.tree}\n\`\`\`` : ""}`;
      return textResult(text, { ...result, active_task: activeTask });
    }
  );

  registerCodexTool(
    config,
    server,
    "task_plan",
    {
      title: "Task Plan",
      description: "Create a compact Codex-like execution checklist with command policy and write approval requirements for a proposed coding task.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace."),
        goal: z.string().describe("User-facing coding task goal."),
        target_paths: z.array(z.string()).optional().describe("Likely files or directories involved."),
        proposed_commands: z.array(z.string()).optional().describe("Verification commands the model expects to run."),
        proposed_changes: z.array(z.record(z.unknown())).optional().describe("Optional proposed change set to preview and include in approval requirements."),
        plan_steps: z.array(z.string()).optional().describe("The agent's actual implementation steps. When provided, the goal and plan are persisted as the workspace's active task and a task_id is returned for later task_resume.")
      },
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Drafting task plan...",
        "openai/toolInvocation/invoked": "Task plan ready"
      }
    },
    async (args) => {
      const workspace = workspaces.getWorkspace(args.workspace_id);
      const result = await buildTaskPlan(config, guard, workspace, {
        goal: String(args.goal ?? ""),
        targetPaths: Array.isArray(args.target_paths) ? args.target_paths.map(String) : [],
        proposedCommands: Array.isArray(args.proposed_commands) ? args.proposed_commands.map(String) : [],
        proposedChanges: Array.isArray(args.proposed_changes) ? normalizeChangeSetInput(args.proposed_changes) : undefined,
        planSteps: Array.isArray(args.plan_steps) ? args.plan_steps.map(String) : undefined
      });
      const steps = result.steps.map((step) => `${step.order}. ${step.tool}: ${step.purpose}`).join("\n");
      const approvals = result.approval_requirements.length
        ? result.approval_requirements.map((item) => `- ${item.scope}: ${item.decision} (${item.reason})`).join("\n")
        : "- No approval requirements detected from provided proposed inputs.";
      const text = `# Task Plan\n\nGoal: ${result.goal}\nTargets: ${result.target_paths.join(", ") || "not specified"}\n\n## Steps\n\n${steps}\n\n## Approval Requirements\n\n${approvals}`;
      return textResult(text, { workspace_id: workspace.id, root: workspace.root, ...result });
    }
  );

  registerCodexTool(
    config,
    server,
    "task_verify",
    {
      title: "Task Verify",
      description: "Run one policy-checked verification command for the current coding task and journal the result.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace."),
        command: z.string().describe("Verification command to run."),
        cwd: z.string().optional().describe("Working directory relative to workspace root. Default: ."),
        timeout_ms: z.number().int().min(1000).max(180000).optional().describe("Timeout in milliseconds. Default: 30000.")
      },
      annotations: BASH_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Running task verification...",
        "openai/toolInvocation/invoked": "Task verification finished"
      }
    },
    async (args) => {
      const workspace = workspaces.getWorkspace(args.workspace_id);
      const command = String(args.command ?? "");
      const policy = decideCommandPolicy(config, command);
      const result = await runBash(config, guard, workspace, command, {
        cwd: args.cwd,
        timeoutMs: args.timeout_ms
      });
      await appendJournalEvent(config, guard, workspace, {
        event: "task_verify",
        status: result.exitCode === 0 ? "ok" : "error",
        command: result.command,
        durationMs: result.durationMs,
        error: result.exitCode === 0 ? undefined : result.stderr || `exit ${result.exitCode ?? "null"}`
      });
      const text = `${bashTextResult(config, result)}\n\n## Policy\n\nDecision: ${policy.decision}\nRisk: ${policy.risk}\nReason: ${policy.reason}`;
      return textResult(text, { workspace_id: workspace.id, root: workspace.root, policy, result });
    }
  );

  registerCodexTool(
    config,
    server,
    "task_report",
    {
      title: "Task Report",
      description: "Summarize current task state with git changes, diff stats, and recent operation journal events.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace."),
        include_diff: z.boolean().optional().describe("Include raw git diff. Default: true."),
        max_events: z.number().int().min(1).max(500).optional().describe("Recent journal events to include. Default: 50."),
        complete: z.boolean().optional().describe("Mark the active task complete and archive it to .ai-bridge/tasks/<id>.json. Default: false.")
      },
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Preparing task report...",
        "openai/toolInvocation/invoked": "Task report ready"
      }
    },
    async (args) => {
      const workspace = workspaces.getWorkspace(args.workspace_id);
      const result = await buildTaskReport(
        config,
        guard,
        workspace,
        {
          includeDiff: parseBool(args.include_diff, true),
          maxEvents: limitInt(args.max_events, 50, 1, 500)
        },
        { normalizeGitOutput, looksLikeGitError, changedStatusLines, diffStats }
      );
      const archivedTask = parseBool(args.complete, false)
        ? await archiveActiveTask(config, guard, workspace, "complete")
        : null;
      const eventRows = result.events.length
        ? result.events.map((event) => `- ${event.ts} ${event.status.toUpperCase()} ${event.event} ${event.paths?.join(", ") ?? event.command ?? ""}`.trim()).join("\n")
        : "- No journal events.";
      const text = `# Task Report\n\nChanged: ${result.changed}\nDiff stats: +${result.additions} -${result.deletions}\n\n## Changed Files\n\n${result.changed_files.length ? result.changed_files.map((line) => `- ${line}`).join("\n") : "- No changed files."}\n\n## Recent Events\n\n${eventRows}${result.diff ? diffBlock(result.diff) : ""}`;
      return textResult(text, { ...result, ...(archivedTask ? { archived_task: archivedTask } : {}) });
    }
  );

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

  registerCodexTool(
    config,
    server,
    "ssh_profiles",
    {
      title: "SSH Profiles",
      description: "List configured SSH profiles with sensitive local identity paths redacted. Profiles come from CODEXBRIDGE_SSH_PROFILES.",
      inputSchema: {},
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Reading SSH profiles...",
        "openai/toolInvocation/invoked": "SSH profiles ready"
      }
    },
    async () => {
      const profiles = listSshProfiles(config);
      const rows = profiles.length
        ? profiles.map((profile) => `- ${profile.name}: ${profile.user ? `${profile.user}@` : ""}${profile.host}:${profile.port} mode=${profile.mode}${profile.workdir ? ` workdir=${profile.workdir}` : ""}`).join("\n")
        : "- No SSH profiles configured.";
      return textResult(`# SSH Profiles\n\nMode: ${config.sshMode}\nProfiles: ${profiles.length}\n\n${rows}`, {
        ssh_mode: config.sshMode,
        count: profiles.length,
        profiles
      });
    }
  );

  registerCodexTool(
    config,
    server,
    "ssh_exec",
    {
      title: "SSH Exec",
      description: "Run one non-interactive command on a configured SSH profile. Supports dry-run previews, safe/full policy, bounded output, and journaled actual executions.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id used for journaling actual SSH executions. Omit to use default workspace."),
        profile: z.string().describe("SSH profile name from ssh_profiles."),
        command: z.string().describe("Single remote command to run. No interactive shell, pipes, redirects, or chained user commands in safe mode."),
        cwd: z.string().optional().describe("Remote working directory override. Defaults to the profile workdir when configured."),
        timeout_ms: z.number().int().min(1000).max(180000).optional().describe("Timeout in milliseconds. Default: 30000."),
        dry_run: z.boolean().optional().describe("Preview ssh argv and remote command without connecting. Default: false."),
        approved: z.boolean().optional().describe("Set true only after explicit user approval when full SSH policy returns ask.")
      },
      annotations: BASH_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Running SSH command...",
        "openai/toolInvocation/invoked": "SSH command finished"
      }
    },
    async (args) => {
      const workspace = workspaces.getWorkspace(args.workspace_id);
      const result = await runSshCommand(config, {
        profile: String(args.profile ?? ""),
        command: String(args.command ?? ""),
        cwd: typeof args.cwd === "string" ? args.cwd : undefined,
        timeoutMs: args.timeout_ms,
        dryRun: parseBool(args.dry_run, false),
        approved: parseBool(args.approved, false)
      });
      if (!result.dry_run) {
        await appendJournalEvent(config, guard, workspace, {
          event: "ssh_exec",
          status: result.exitCode === 0 ? "ok" : "error",
          command: `${result.profile}: ${result.command}`,
          durationMs: result.durationMs ?? 0,
          error: result.exitCode === 0 ? undefined : result.stderr || `exit ${result.exitCode ?? "null"}`
        });
      }
      return textResult(sshTextResult(result), {
        workspace_id: workspace.id,
        root: workspace.root,
        ...result
      });
    }
  );

  registerCodexTool(
    config,
    server,
    "bash",
    {
      title: "Bash",
      description:
        "Run one allowlisted verification command in the workspace, such as tests, build, lint, typecheck, or a project script. Do not use for git status/diff or file inspection; use show_changes, tree, search, and read instead. Do not chain commands with &&, pipes, redirects, or shell file readers.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace."),
        command: z.string().describe("Command to run."),
        session_id: z.string().optional().describe(config.requireBashSession && config.bashSessionId ? `Required bash session id for this server: ${config.bashSessionId}.` : "Optional bash session id. If configured on the server, a provided value must match it."),
        cwd: z.string().optional().describe("Working directory relative to workspace root. Default: ."),
        timeout_ms: z.number().int().min(1000).max(180000).optional().describe("Timeout in milliseconds. Default: 30000.")
      },
      annotations: BASH_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Running bash command...",
        "openai/toolInvocation/invoked": "Bash command finished"
      }
    },
    async (args) => {
      const workspace = workspaces.getWorkspace(args.workspace_id);
      const result = await runBash(config, guard, workspace, String(args.command ?? ""), {
        cwd: args.cwd,
        timeoutMs: args.timeout_ms,
        sessionId: args.session_id
      });
      await appendJournalEvent(config, guard, workspace, {
        event: "bash",
        status: result.exitCode === 0 ? "ok" : "error",
        command: result.command,
        durationMs: result.durationMs,
        error: result.exitCode === 0 ? undefined : result.stderr || `exit ${result.exitCode ?? "null"}`
      });
      const text = bashTextResult(config, result);
      return textResult(text, { workspace_id: workspace.id, root: workspace.root, ...result, bash_session_id: result.bashSessionId ?? null });
    }
  );

  registerCodexTool(
    config,
    server,
    "git_status",
    {
      title: "Git Status",
      description: "Show git branch and changed files for the workspace.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace.")
      },
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Reading git status...",
        "openai/toolInvocation/invoked": "Git status ready"
      }
    },
    async (args) => {
      const workspace = workspaces.getWorkspace(args.workspace_id);
      const status = gitStatus(config, workspace);
      const statusError = looksLikeGitError(status) ? status : "";
      const changedFiles = statusError ? [] : changedStatusLines(status);
      return textResult(status, {
        workspace_id: workspace.id,
        root: workspace.root,
        status,
        status_error: statusError || undefined,
        changed_files: changedFiles,
        changed: !statusError && changedFiles.length > 0
      });
    }
  );

  registerCodexTool(
    config,
    server,
    "git_diff",
    {
      title: "Git Diff",
      description: "Show current unstaged or staged git diff, optionally scoped to a file.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace."),
        path: z.string().optional().describe("Optional file path relative to workspace root."),
        staged: z.boolean().optional().describe("Show staged diff. Default: false."),
        include_diff: z.boolean().optional().describe("Include the raw unified diff in the response. Default: true. Set false for stats-only checks.")
      },
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Reading git diff...",
        "openai/toolInvocation/invoked": "Git diff ready"
      }
    },
    async (args) => {
      const workspace = workspaces.getWorkspace(args.workspace_id);
      const rawDiff = normalizeGitOutput(gitDiff(config, guard, workspace, args.path, parseBool(args.staged, false)));
      const diffError = rawDiff && looksLikeGitError(rawDiff) ? rawDiff : "";
      const stats = diffError ? { additions: 0, deletions: 0, changed: false } : diffStats(rawDiff);
      const includeDiff = parseBool(args.include_diff, true);
      const text = diffError
        ? diffError
        : includeDiff
        ? rawDiff
        : [
            "# Git Diff",
            "",
            `Workspace: ${workspace.root}`,
            `Path: ${args.path ?? "workspace diff"}`,
            `Staged: ${parseBool(args.staged, false)}`,
            `Diff stats: +${stats.additions} -${stats.deletions}`,
            "",
            "Raw diff omitted by include_diff=false."
          ].join("\n");
      return textResult(text, {
        workspace_id: workspace.id,
        root: workspace.root,
        path: args.path ?? "workspace diff",
        staged: parseBool(args.staged, false),
        include_diff: includeDiff,
        diff_error: diffError || undefined,
        additions: stats.additions,
        deletions: stats.deletions,
        changed: !diffError && stats.changed,
        diff: diffError || includeDiff ? rawDiff : ""
      });
    }
  );

  registerCodexTool(
    config,
    server,
    "show_changes",
    {
      title: "Show Changes",
      description: "Summarize the current workspace changes in one review-oriented result with git status, diff stats, and optional diff. Use this instead of bash git status, bash git diff, git_status, or git_diff when reviewing work.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace."),
        path: z.string().optional().describe("Optional file path relative to workspace root."),
        staged: z.boolean().optional().describe("Show staged diff. Default: false."),
        include_diff: z.boolean().optional().describe("Include the unified diff. Default: true.")
      },
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Summarizing workspace changes...",
        "openai/toolInvocation/invoked": "Workspace changes summarized"
      }
    },
    async (args) => {
      const workspace = workspaces.getWorkspace(args.workspace_id);
      const scopedPath = typeof args.path === "string" ? args.path : undefined;
      const status = gitStatus(config, workspace, guard, scopedPath);
      const includeDiff = parseBool(args.include_diff, true);
      const rawDiff = includeDiff ? normalizeGitOutput(gitDiff(config, guard, workspace, scopedPath, parseBool(args.staged, false))) : "";
      const statusError = looksLikeGitError(status) ? status : "";
      const diffError = rawDiff && looksLikeGitError(rawDiff) ? rawDiff : "";
      const diff = diffError ? "" : rawDiff;
      const stats = diffStats(diff);
      const changedFiles = statusError ? [] : changedStatusLines(status);
      const changedText = statusError
        ? `- Git status unavailable: ${statusError}`
        : changedFiles.length
          ? changedFiles.map((line) => `- ${line}`).join("\n")
          : "- No changed files.";
      const diffText = includeDiff
        ? diffError
          ? `\n\nGit diff unavailable: ${diffError}`
          : diff
          ? diffBlock(diff)
          : "\n\nNo diff output."
        : "\n\nDiff omitted by request.";
      const text = `# Show Changes\n\nWorkspace: ${workspace.root}\n\n## Changed\n\n${changedText}\n\n## Diff stats\n\n+${stats.additions} -${stats.deletions}${diffText}`;
      return textResult(text, {
        workspace_id: workspace.id,
        root: workspace.root,
        path: args.path ?? "workspace changes",
        status,
        status_error: statusError || undefined,
        diff_error: diffError || undefined,
        changed_files: changedFiles,
        staged: parseBool(args.staged, false),
        include_diff: includeDiff,
        additions: stats.additions,
        deletions: stats.deletions,
        changed: !statusError && (changedFiles.length > 0 || stats.changed),
        diff
      });
    }
  );

  registerCodexTool(
    config,
    server,
    "operation_journal",
    {
      title: "Operation Journal",
      description: "Read recent bounded CodexBridge operation journal events for recovery and audit.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace."),
        max_events: z.number().int().min(1).max(500).optional().describe("Maximum recent events to return. Default: 50."),
        event: z.string().optional().describe("Optional event name filter, for example bash or apply_change_set.")
      },
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Reading operation journal...",
        "openai/toolInvocation/invoked": "Operation journal ready"
      }
    },
    async (args) => {
      const workspace = workspaces.getWorkspace(args.workspace_id);
      const result = await readJournalEvents(config, guard, workspace, {
        maxEvents: limitInt(args.max_events, 50, 1, 500),
        event: typeof args.event === "string" ? args.event : undefined
      });
      const rows = result.events.length
        ? result.events.map((event) => `- ${event.ts} ${event.status.toUpperCase()} ${event.event} ${event.paths?.join(", ") ?? event.command ?? ""}`.trim()).join("\n")
        : "- No journal events.";
      const text = `# Operation Journal\n\nPath: ${result.path}\nEvents returned: ${result.events.length}\nTotal matched: ${result.total_read}\n\n${rows}`;
      return textResult(text, {
        workspace_id: workspace.id,
        root: workspace.root,
        path: result.path,
        events: result.events,
        event_count: result.events.length,
        total_read: result.total_read
      });
    }
  );

  registerCodexTool(
    config,
    server,
    "read_handoff",
    {
      title: "Read Handoff",
      description: "Read the shared .ai-bridge planning files used for ChatGPT-to-agent coordination.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace.")
      },
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Reading agent handoff context...",
        "openai/toolInvocation/invoked": "Agent handoff context ready"
      }
    },
    async (args) => {
      const workspace = workspaces.getWorkspace(args.workspace_id);
      const context = await readAiBridgeContext(config, guard, workspace);
      return textResult(context.text, {
        workspace_id: workspace.id,
        root: workspace.root,
        files: context.files,
        file_count: context.files.length,
        preview: previewText(context.text)
      });
    }
  );

  registerCodexTool(
    config,
    server,
    "codex_context",
    {
      title: "Codex Context",
      description:
        "Load Codex-style workspace context in one call: AGENTS instructions for a target path, .ai-bridge handoff files, and optional git status/diff.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace."),
        target_path: z.string().optional().describe("Workspace-relative file or directory whose AGENTS instruction chain should be loaded. Default: ."),
        include_ai_bridge: z.boolean().optional().describe("Include .ai-bridge plan, agent status, diff, decisions, questions, and execution log. Default: true."),
        include_git: z.boolean().optional().describe("Include git status. Default: true."),
        include_diff: z.boolean().optional().describe("Include full git diff. Default: false for speed/noise."),
        max_agent_bytes: z.number().int().min(1000).max(200000).optional().describe("Maximum bytes per AGENTS file. Default: 60000.")
      },
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Loading Codex context...",
        "openai/toolInvocation/invoked": "Codex context ready"
      }
    },
    async (args) => {
      const workspace = workspaces.getWorkspace(args.workspace_id);
      const context = await readCodexContext(config, guard, workspace, {
        targetPath: args.target_path,
        includeAiBridge: args.include_ai_bridge,
        includeGit: args.include_git,
        includeDiff: parseBool(args.include_diff, false),
        maxAgentBytes: args.max_agent_bytes
      });
      return textResult(context.text, {
        workspace_id: context.workspaceId,
        root: context.root,
        target_path: context.targetPath,
        agents_files: context.agentsFiles,
        ai_context_files: context.aiContextFiles,
        included_git_status: context.gitStatus !== undefined,
        included_git_diff: context.gitDiff !== undefined,
        preview: previewText(context.text)
      });
    }
  );

  registerCodexTool(
    config,
    server,
    "export_pro_context",
    {
      title: "Export Pro Context",
      description:
        "Create .ai-bridge/pro-context.md with repo tree, git state, selected files, and handoff context for high-context ChatGPT planning without live MCP tool calls.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace."),
        title: z.string().optional().describe("Markdown title for the context bundle."),
        selected_paths: z.array(z.string()).optional().describe("Specific workspace-relative files to include."),
        extra_globs: z.array(z.string()).optional().describe("Additional workspace-relative glob patterns to include, for example src/**/*.ts."),
        include_important_files: z.boolean().optional().describe("Auto-include important root config/docs such as AGENTS.md, README.md, and package.json. Default: true."),
        include_changed_files: z.boolean().optional().describe("Auto-include currently changed files from git status. Default: true."),
        include_diff: z.boolean().optional().describe("Include the current git diff. Default: true."),
        include_ai_bridge: z.boolean().optional().describe("Include existing .ai-bridge planning files. Default: true."),
        max_depth: z.number().int().min(1).max(6).optional().describe("Repository tree depth. Default: 3."),
        max_files: z.number().int().min(1).max(80).optional().describe("Maximum file contents to include. Default: 24."),
        max_file_bytes: z.number().int().min(1000).max(250000).optional().describe("Maximum bytes per included file. Default: 60000."),
        max_total_bytes: z.number().int().min(20000).max(2000000).optional().describe("Maximum bytes in the generated bundle.")
      },
      annotations: HANDOFF_WRITE_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Exporting Pro context...",
        "openai/toolInvocation/invoked": "Pro context exported"
      }
    },
    async (args) => {
      const workspace = workspaces.getWorkspace(args.workspace_id);
      const result = await exportProContext(config, guard, workspace, {
        title: args.title,
        selectedPaths: args.selected_paths,
        extraGlobs: args.extra_globs,
        includeImportantFiles: args.include_important_files,
        includeChangedFiles: args.include_changed_files,
        includeDiff: args.include_diff,
        includeAiBridge: args.include_ai_bridge,
        maxDepth: args.max_depth,
        maxFiles: args.max_files,
        maxFileBytes: args.max_file_bytes,
        maxTotalBytes: args.max_total_bytes
      });
      const text = `# Export Pro Context\n\nWrote ${result.path}.\nBytes: ${result.bytes}\nFiles included: ${result.filesIncluded.length}\nFiles skipped: ${result.filesSkipped.length}\nTruncated: ${result.truncated}\n\nPaste ${result.path} into a high-context planning model when MCP tools are unavailable, then save the returned plan with codexbridge pro-apply.`;
      return textResult(text, {
        workspace_id: workspace.id,
        root: workspace.root,
        path: result.path,
        bytes: result.bytes,
        files_included: result.filesIncluded,
        files_skipped: result.filesSkipped,
        truncated: result.truncated
      });
    }
  );

  if (config.codexSessions !== "off") {
    registerCodexTool(
      config,
      server,
      "codex_sessions",
      {
        title: "Codex Sessions",
        description:
          "Opt-in, read-only local Codex session history browser. Lists metadata from the user's configured Codex session JSONL files without reading full transcripts.",
        inputSchema: {
          max_sessions: z.number().int().min(1).max(200).optional().describe("Maximum sessions to return. Default: 30."),
          query: z.string().optional().describe("Optional case-insensitive search over session id, title, summary, cwd, and source path.")
        },
        annotations: READ_ONLY_ANNOTATIONS,
        _meta: {
          ...toolCardMeta(),
          "openai/toolInvocation/invoking": "Listing local Codex sessions...",
          "openai/toolInvocation/invoked": "Codex sessions ready"
        }
      },
      async (args) => {
        const result = await listCodexSessions(config, {
          maxSessions: args.max_sessions,
          query: args.query
        });
        const rows = result.sessions.length
          ? result.sessions.map((session) => `- ${session.session_id}  ${session.title || "(untitled)"}${session.project_dir ? `  cwd=${session.project_dir}` : ""}`).join("\n")
          : "- No Codex sessions found.";
        const text = `# Codex Sessions\n\nCodex dir: ${result.codex_dir}\nMode: ${config.codexSessions}\nTotal matched: ${result.total_found}\n\n${rows}`;
        return textResult(text, {
          codex_dir: result.codex_dir,
          roots: result.roots,
          sessions: result.sessions,
          total_found: result.total_found,
          codex_sessions_mode: config.codexSessions
        });
      }
    );

    if (config.codexSessions === "read") {
      registerCodexTool(
        config,
        server,
        "read_codex_session",
        {
          title: "Read Codex Session",
          description:
            "Opt-in, read-only local Codex transcript reader. Requires --codex-sessions read and returns a bounded transcript from a local Codex session JSONL file.",
          inputSchema: {
            session_id: z.string().optional().describe("Codex session id from codex_sessions."),
            source_path: z.string().optional().describe("Source path from codex_sessions. Must be inside the configured Codex session roots."),
            max_messages: z.number().int().min(1).max(400).optional().describe("Maximum transcript messages. Default: 80."),
            max_total_bytes: z.number().int().min(4000).max(400000).optional().describe("Maximum transcript content bytes. Default: 80000.")
          },
          annotations: READ_ONLY_ANNOTATIONS,
          _meta: {
            ...toolCardMeta(),
            "openai/toolInvocation/invoking": "Reading local Codex session...",
            "openai/toolInvocation/invoked": "Codex session read"
          }
        },
        async (args) => {
          const result = await readCodexSession(config, {
            sessionId: args.session_id,
            sourcePath: args.source_path,
            maxMessages: args.max_messages,
            maxTotalBytes: args.max_total_bytes
          });
          return textResult(result.text, {
            session: result.session,
            messages: result.messages,
            message_count: result.messages.length,
            truncated: result.truncated,
            codex_sessions_mode: config.codexSessions
          });
        }
      );
    }
  }

  registerCodexTool(
    config,
    server,
    "handoff_to_agent",
    {
      title: "Handoff To Agent",
      description:
        "Write .ai-bridge/current-plan.md for Codex, OpenCode, Pi, or another local implementation agent. This only creates handoff files; it does not execute local agent commands.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace."),
        agent: z.string().optional().describe("Target agent id, for example codex, opencode, pi, or custom. Default: custom."),
        agent_name: z.string().optional().describe("Human-readable agent name for custom agents."),
        model: z.string().optional().describe("Optional model identifier to include in the handoff plan."),
        title: z.string().optional().describe("Short task title."),
        plan: z.string().describe("Detailed implementation plan for the local agent."),
        append: z.boolean().optional().describe("Append to existing current-plan.md instead of overwriting. Default: false.")
      },
      annotations: HANDOFF_WRITE_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Writing agent handoff plan...",
        "openai/toolInvocation/invoked": "Agent handoff plan written"
      }
    },
    async (args) => {
      const workspace = workspaces.getWorkspace(args.workspace_id);
      const result = await writeAgentHandoff(config, guard, workspace, {
        agent: args.agent ?? "custom",
        agentName: args.agent_name,
        model: args.model,
        title: cleanOneLine(args.title, "Agent implementation plan"),
        plan: String(args.plan ?? ""),
        append: parseBool(args.append, false),
        eventName: "handoff_to_agent"
      });

      const text = `# Handoff To Agent

Agent: ${result.agentName} (${result.agent})
${result.model ? `Model: ${result.model}\n` : ""}Wrote ${result.planPath}.
Status path: ${result.statusPath}
Diff path: ${result.diffPath}
Execution log: ${result.executionLogPath}
Diff stats: +${result.writeResult.diff.additions} -${result.writeResult.diff.deletions}

Agent prompt:

\`\`\`text
${result.prompt}
\`\`\`${diffBlock(result.writeResult.diff.diff)}`;
      return textResult(text, {
        workspace_id: workspace.id,
        root: workspace.root,
        agent: result.agent,
        agent_name: result.agentName,
        model: result.model,
        plan_path: result.planPath,
        status_path: result.statusPath,
        diff_path: result.diffPath,
        log_path: result.logPath,
        execution_log_path: result.executionLogPath,
        additions: result.writeResult.diff.additions,
        deletions: result.writeResult.diff.deletions,
        diff: result.writeResult.diff.diff
      });
    }
  );

  registerCodexTool(
    config,
    server,
    "handoff_to_codex",
    {
      title: "Handoff To Codex",
      description: "Compatibility wrapper for handoff_to_agent with agent=codex.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace."),
        title: z.string().optional().describe("Short task title."),
        plan: z.string().describe("Detailed implementation plan for Codex."),
        append: z.boolean().optional().describe("Append to existing current-plan.md instead of overwriting. Default: false.")
      },
      annotations: HANDOFF_WRITE_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Writing Codex handoff plan...",
        "openai/toolInvocation/invoked": "Codex handoff plan written"
      }
    },
    async (args) => {
      const workspace = workspaces.getWorkspace(args.workspace_id);
      const result = await writeAgentHandoff(config, guard, workspace, {
        agent: "codex",
        title: cleanOneLine(args.title, "Codex implementation plan"),
        plan: String(args.plan ?? ""),
        append: parseBool(args.append, false),
        eventName: "handoff_to_codex"
      });
      const text = `# Handoff To Codex

Wrote ${result.planPath}.
Status path: ${result.statusPath}
Diff path: ${result.diffPath}
Diff stats: +${result.writeResult.diff.additions} -${result.writeResult.diff.deletions}

Codex prompt:

\`\`\`text
${result.prompt}
\`\`\`${diffBlock(result.writeResult.diff.diff)}`;
      return textResult(text, {
        workspace_id: workspace.id,
        root: workspace.root,
        agent: result.agent,
        agent_name: result.agentName,
        plan_path: result.planPath,
        status_path: result.statusPath,
        diff_path: result.diffPath,
        log_path: result.logPath,
        execution_log_path: result.executionLogPath,
        additions: result.writeResult.diff.additions,
        deletions: result.writeResult.diff.deletions,
        diff: result.writeResult.diff.diff
      });
    }
  );

  return server;
}
