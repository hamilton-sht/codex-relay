---
name: multi-codex-align
description: Coordinate two Codex App or CLI conversations by their persisted Codex conversation titles so agents can exchange prompts, report results, debate, and align requirements. Prefer GUI delivery when the target Thread is open in another Codex App window and the user wants prompts and replies to render live without restarting. Use for Multi-Codex, Codex Relay, 两个 Codex 对话, 两个 Agent 讨论, 对齐需求, Agent 汇报, 按对话名字发送, 重命名对话, GUI 实时发送, cross-thread communication, planner/reviewer discussion, or consensus workflows.
---

# Multi-Codex Align

## Resolve the target

Use the Codex conversation's persisted title as the default human-facing address. Codex App writes
renames to the local Thread state, and Codex Relay reads that state for every delivery.

1. Ask the user to give important target conversations short, unique Codex titles such as `MOE`,
   `EXP`, or `Reviewer` by using the App's native rename action.
2. Resolve and send by that exact title. A saved rename requires no Codex App restart.
3. If no exact title exists, list nearby recent Threads and tell the user to rename the intended
   conversation. Do not immediately ask for a Thread ID and do not guess from semantic similarity.
4. If titles are duplicated, stop and ask the user to make them unique. Use an exact Thread ID only
   as an advanced escape hatch.
5. Treat registered aliases as optional automation compatibility for frequently renamed Threads,
   not as the normal setup requirement.

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
- Prefer the persisted Codex title over aliases and raw Thread IDs in user-facing instructions.
- Do not claim persuasion or consensus unless the target explicitly states it.
- Keep target windows open for strict GUI mode. Report `GUI_OWNER_NOT_FOUND` clearly.
- Treat Codex App follower IPC as version-sensitive. Never replace it with mouse or keyboard GUI
  automation.
