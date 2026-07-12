---
name: multi-codex-align
description: Coordinate two Codex App or CLI conversations so agents can exchange prompts, report results, debate, and align requirements. Prefer GUI delivery when the target Thread is open in another Codex App window and the user wants prompts and replies to render live without restarting. Use for Multi-Codex, 两个 Codex 对话, 两个 Agent 讨论, 对齐需求, Agent 汇报, GUI 实时发送, cross-thread communication, planner/reviewer discussion, or consensus workflows.
---

# Multi-Codex Align

Resolve every target by a unique title, registered alias, or exact Thread ID. Stop on ambiguous
titles; never guess a destination.

## Choose a delivery path

1. Use `delivery_mode: "gui"` when the target Thread is already open in its own Codex App window.
   This uses the App's follower IPC and renders the prompt and response live in that window.
2. Use `delivery_mode: "auto"` when live GUI rendering is preferred but CLI fallback is acceptable.
3. Use `delivery_mode: "cli"` only for compatibility when no target GUI owner window is open.

Prefer the `multiCodexBridge` MCP tools. For a direct prompt, call `send_agent_message` with the
target, message, kind, `delivery_mode`, and `wait_for_response`. The receiving Agent does not poll.

If MCP tools are unavailable, use the installed project CLI:

```bash
multi-codex gui-send --target "测试任务" --message "Review this requirement."
```

## Discuss and align

Alternate explicit turns between the two targets. Preserve each actual peer response. Ask Planner
to propose or revise, then ask Reviewer to return `AGREE`, `CONFLICT`, or `QUESTION`. Stop only when
both accept the same revision with no unresolved conflicts or questions. Enforce a finite round
limit and escalate product decisions that require user authority.

## Completion rules

- Do not claim delivery until its status is `completed`.
- Do not claim persuasion or consensus unless the target explicitly states it.
- Keep target windows open for strict GUI mode. Report `GUI_OWNER_NOT_FOUND` clearly.
- Treat Codex App follower IPC as version-sensitive. Never replace it with mouse or keyboard GUI
  automation.
