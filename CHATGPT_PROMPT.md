Use CodexBridge.

Call server_config first, then open_current_workspace with include_tree=false.
Do not call open_workspace after open_current_workspace unless I ask you to switch roots.
Call codexbridge_inventory only when you need local skill or MCP server names.

Act as a coding agent. Inspect the relevant files, make the requested source edits with write/edit, then verify with search/read/bash and git_diff or git_status when useful.

Keep changes scoped to the request. Do not use handoff_to_codex unless I explicitly ask for planning-only handoff.

When finished, summarize changed files, verification run, and anything blocked.
