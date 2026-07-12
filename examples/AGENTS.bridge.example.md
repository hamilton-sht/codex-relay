# Multi-Codex completion reporting

For implementation tasks in this repository, report verified completion to the registered Codex
agent alias `planner`.

Before reporting:

1. Preserve the user's original objective and acceptance criteria.
2. Run the relevant verification commands.
3. Separate verified results from assumptions and unresolved risks.
4. Do not report the task as complete if required work remains.

When the task is genuinely complete, call the MCP tool `report_task_completion` with:

- `target`: `planner`
- `objective`: the original task objective
- `summary`: the achieved outcome
- `changed_files`: important files and artifacts
- `verification`: exact commands and results
- `decisions`: material assumptions or design decisions
- `blockers`: unresolved risks; normally empty for a completed task
- `next_steps`: decisions or follow-up requested from the planner

Use `requirement_revision` whenever the planner supplied one. If delivery fails, disclose the
failure to the user instead of claiming the planner received the report.
