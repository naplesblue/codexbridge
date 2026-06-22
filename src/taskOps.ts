import type { CodexBridgeConfig } from "./config.js";
import type { Workspace } from "./guard.js";
import { CodexBridgeError, PathGuard } from "./guard.js";
import { repoTree } from "./fsOps.js";
import { gitDiff, gitStatus } from "./gitOps.js";
import { readCodexContext } from "./workspaceOps.js";
import { previewChangeSet, type ChangeSetInput, type ChangeSetPreview } from "./changeSet.js";
import { readJournalEvents, type JournalEvent } from "./journal.js";
import { decideCommandPolicy, decideSshCommandPolicy, type PolicyDecision, type PolicyDecisionKind, type PolicyRisk } from "./policy.js";

export interface ApprovalActionResult {
  type: "command" | "ssh_command" | "change_set";
  scope: "command" | "remote_command" | "local_write";
  decision: PolicyDecisionKind;
  required: boolean;
  risk: PolicyRisk;
  reason: string;
  command?: string;
  profile?: string;
  change_count?: number;
  additions?: number;
  deletions?: number;
  preview?: ChangeSetPreview;
}

export interface ApprovalReviewResult {
  decision: PolicyDecisionKind;
  required: boolean;
  risk: PolicyRisk;
  actions: ApprovalActionResult[];
}

export interface TaskBriefResult {
  goal: string;
  target_path: string;
  workspace_id: string;
  root: string;
  agents_files: string[];
  ai_context_files: string[];
  git_status?: string;
  git_diff?: string;
  tree?: string;
  recommended_workflow: string[];
  context_text: string;
}

export interface TaskPlanStep {
  order: number;
  tool: string;
  purpose: string;
}

export interface TaskPlanResult {
  goal: string;
  target_paths: string[];
  steps: TaskPlanStep[];
  command_policies: Array<{ command: string; policy: PolicyDecision }>;
  approval_requirements: ApprovalActionResult[];
  change_preview?: ChangeSetPreview;
}

export interface TaskReportResult {
  workspace_id: string;
  root: string;
  changed: boolean;
  changed_files: string[];
  additions: number;
  deletions: number;
  status: string;
  diff: string;
  events: JournalEvent[];
}

function maxRisk(values: PolicyRisk[]): PolicyRisk {
  if (values.includes("high")) return "high";
  if (values.includes("medium")) return "medium";
  return "low";
}

function overallDecision(actions: ApprovalActionResult[]): PolicyDecisionKind {
  if (actions.some((action) => action.decision === "deny")) return "deny";
  if (actions.some((action) => action.decision === "ask")) return "ask";
  return "allow";
}

export async function buildTaskBrief(
  config: CodexBridgeConfig,
  guard: PathGuard,
  workspace: Workspace,
  options: { goal: string; targetPath?: string; includeDiff?: boolean; includeTree?: boolean }
): Promise<TaskBriefResult> {
  const goal = options.goal.trim();
  if (!goal) throw new CodexBridgeError("goal is required.");
  const targetPath = options.targetPath?.trim() || ".";
  const context = await readCodexContext(config, guard, workspace, {
    targetPath,
    includeAiBridge: true,
    includeGit: true,
    includeDiff: options.includeDiff === true
  });
  const tree = options.includeTree === false
    ? undefined
    : (await repoTree(config, guard, workspace, { path: ".", maxDepth: 3, includeHidden: false, maxEntries: 300 })).text;
  return {
    goal,
    target_path: targetPath,
    workspace_id: workspace.id,
    root: workspace.root,
    agents_files: context.agentsFiles,
    ai_context_files: context.aiContextFiles,
    git_status: context.gitStatus,
    git_diff: context.gitDiff,
    tree,
    recommended_workflow: ["task_plan", "preview_change_set", "approval_review", "apply_change_set", "task_verify", "task_report"],
    context_text: context.text
  };
}

export async function reviewApprovalActions(
  config: CodexBridgeConfig,
  guard: PathGuard,
  workspace: Workspace,
  actions: Array<{ type: "command"; command: string } | { type: "ssh_command"; command: string; profile?: string } | { type: "change_set"; changes: ChangeSetInput[] }>
): Promise<ApprovalReviewResult> {
  if (!actions.length) throw new CodexBridgeError("actions must contain at least one action.");
  const reviewed: ApprovalActionResult[] = [];
  for (const action of actions) {
    if (action.type === "command") {
      const command = action.command.trim();
      if (!command) throw new CodexBridgeError("command action requires command.");
      const policy = decideCommandPolicy(config, command);
      reviewed.push({
        type: "command",
        scope: "command",
        decision: policy.decision,
        required: policy.decision === "ask",
        risk: policy.risk,
        reason: policy.reason,
        command
      });
      continue;
    }
    if (action.type === "ssh_command") {
      const command = action.command.trim();
      if (!command) throw new CodexBridgeError("ssh_command action requires command.");
      const profile = action.profile ? config.sshProfiles[action.profile] : undefined;
      if (action.profile && !profile) throw new CodexBridgeError(`Unknown SSH profile: ${action.profile}`);
      const mode = config.sshMode === "off" ? "off" : profile?.mode ?? config.sshMode;
      const policy = decideSshCommandPolicy(mode, command);
      reviewed.push({
        type: "ssh_command",
        scope: "remote_command",
        decision: policy.decision,
        required: policy.decision === "ask",
        risk: policy.risk,
        reason: policy.reason,
        command,
        ...(action.profile ? { profile: action.profile } : {})
      });
      continue;
    }

    const preview = await previewChangeSet(config, guard, workspace, action.changes);
    reviewed.push({
      type: "change_set",
      scope: "local_write",
      decision: preview.changed ? "ask" : "allow",
      required: preview.changed,
      risk: preview.changed ? "medium" : "low",
      reason: preview.changed
        ? "Local source writes should be previewed and explicitly approved before apply_change_set."
        : "Change set is a no-op and does not require approval.",
      change_count: preview.change_count,
      additions: preview.additions,
      deletions: preview.deletions,
      preview
    });
  }

  return {
    decision: overallDecision(reviewed),
    required: reviewed.some((action) => action.required),
    risk: maxRisk(reviewed.map((action) => action.risk)),
    actions: reviewed
  };
}

export async function buildTaskPlan(
  config: CodexBridgeConfig,
  guard: PathGuard,
  workspace: Workspace,
  options: { goal: string; targetPaths?: string[]; proposedCommands?: string[]; proposedChanges?: ChangeSetInput[] }
): Promise<TaskPlanResult> {
  const goal = options.goal.trim();
  if (!goal) throw new CodexBridgeError("goal is required.");
  const targetPaths = (options.targetPaths ?? []).map((item) => item.trim()).filter(Boolean);
  const commands = (options.proposedCommands ?? []).map((item) => item.trim()).filter(Boolean);
  const commandPolicies = commands.map((command) => ({ command, policy: decideCommandPolicy(config, command) }));
  const approvalRequirements: ApprovalActionResult[] = [];
  let changePreview: ChangeSetPreview | undefined;
  if (options.proposedChanges?.length) {
    changePreview = await previewChangeSet(config, guard, workspace, options.proposedChanges);
    approvalRequirements.push({
      type: "change_set",
      scope: "local_write",
      decision: changePreview.changed ? "ask" : "allow",
      required: changePreview.changed,
      risk: changePreview.changed ? "medium" : "low",
      reason: changePreview.changed
        ? "Preview the diff and get explicit user approval before applying local source writes."
        : "Proposed change set is a no-op.",
      change_count: changePreview.change_count,
      additions: changePreview.additions,
      deletions: changePreview.deletions,
      preview: changePreview
    });
  }
  for (const entry of commandPolicies) {
    if (entry.policy.decision !== "allow") {
      approvalRequirements.push({
        type: "command",
        scope: "command",
        decision: entry.policy.decision,
        required: entry.policy.decision === "ask",
        risk: entry.policy.risk,
        reason: entry.policy.reason,
        command: entry.command
      });
    }
  }

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
    ...(changePreview ? { change_preview: changePreview } : {})
  };
}

export async function buildTaskReport(
  config: CodexBridgeConfig,
  guard: PathGuard,
  workspace: Workspace,
  options: { includeDiff: boolean; maxEvents: number },
  helpers: {
    normalizeGitOutput(output: string): string;
    looksLikeGitError(output: string): boolean;
    changedStatusLines(status: string): string[];
    diffStats(diff: string): { additions: number; deletions: number; changed: boolean };
  }
): Promise<TaskReportResult> {
  const status = gitStatus(config, workspace);
  const statusError = helpers.looksLikeGitError(status) ? status : "";
  const diff = options.includeDiff ? helpers.normalizeGitOutput(gitDiff(config, guard, workspace)) : "";
  const stats = helpers.diffStats(diff);
  const journal = await readJournalEvents(config, guard, workspace, { maxEvents: options.maxEvents });
  return {
    workspace_id: workspace.id,
    root: workspace.root,
    changed: !statusError && (helpers.changedStatusLines(status).length > 0 || stats.changed),
    changed_files: statusError ? [] : helpers.changedStatusLines(status),
    additions: stats.additions,
    deletions: stats.deletions,
    status,
    diff,
    events: journal.events
  };
}
