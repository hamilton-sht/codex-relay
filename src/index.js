#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  BridgeError,
  createDelivery,
  formatCompletionReport,
  getDelivery,
  listDeliveries,
  listRegisteredAgents,
  listThreads,
  publicDelivery,
  registerAgent,
  updateDelivery,
} from "./bridge.js";

const currentFile = fileURLToPath(import.meta.url);
const workerFile = path.join(path.dirname(currentFile), "worker.js");

function textResult(value, isError = false) {
  return {
    ...(isError ? { isError: true } : {}),
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
  };
}

function toolHandler(fn) {
  return async (args) => {
    try {
      return textResult(await fn(args || {}));
    } catch (error) {
      if (error instanceof BridgeError) {
        return textResult(
          { error: error.code, message: error.message, details: error.details },
          true,
        );
      }
      return textResult(
        { error: "INTERNAL_ERROR", message: error.message || String(error) },
        true,
      );
    }
  };
}

async function waitForDelivery(id, timeoutSeconds) {
  const deadline = Date.now() + Math.max(1, Math.min(timeoutSeconds, 1800)) * 1000;
  while (Date.now() < deadline) {
    const delivery = getDelivery(id);
    if (["completed", "failed"].includes(delivery.status)) return delivery;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return getDelivery(id);
}

function launchWorker(deliveryId) {
  const child = spawn(process.execPath, [workerFile, "--delivery-id", deliveryId], {
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
  child.once("error", (error) => {
    updateDelivery(deliveryId, {
      status: "failed",
      completed_at: new Date().toISOString(),
      error_code: error.code || "WORKER_LAUNCH_FAILED",
      error: error.message,
    });
  });
  child.unref();
  updateDelivery(deliveryId, { launcher_pid: child.pid || null });
  return child.pid;
}

async function dispatch(args, message, kind, subject) {
  const delivery = createDelivery({
    target: args.target,
    message,
    subject,
    kind,
    sourceThreadId: args.source_thread_id,
    allowSelf: args.allow_self,
    targetWaitSeconds: args.target_wait_seconds,
    turnTimeoutSeconds: args.turn_timeout_seconds,
    deliveryMode: args.delivery_mode,
  });
  launchWorker(delivery.id);
  if (args.wait_for_response) {
    return publicDelivery(await waitForDelivery(delivery.id, args.timeout_seconds));
  }
  return {
    ...publicDelivery(getDelivery(delivery.id)),
    note: "Prompt delivery is running in the background. Use get_agent_delivery to retrieve status and the target agent response.",
  };
}

const deliveryOptionsSchema = {
  delivery_mode: z
    .enum(["auto", "gui", "cli"])
    .default("auto")
    .describe("gui renders live in an open Codex App window; cli is the compatibility fallback."),
  source_thread_id: z.string().uuid().optional(),
  allow_self: z.boolean().default(false),
  target_wait_seconds: z
    .number()
    .int()
    .min(0)
    .max(1800)
    .default(300)
    .describe("How long a delivery waits behind another bridge delivery to the same target."),
  turn_timeout_seconds: z
    .number()
    .int()
    .min(1)
    .max(14400)
    .default(1800)
    .describe("Maximum runtime of the target Codex turn."),
  wait_for_response: z.boolean().default(false),
  timeout_seconds: z
    .number()
    .int()
    .min(1)
    .max(1800)
    .default(300)
    .describe("How long this MCP call waits; the delivery continues in the background afterward."),
};

export function createServer() {
  const server = new McpServer({
    name: "multi-codex-agent-bridge",
    version: "0.1.0",
  });

  server.registerTool(
    "list_codex_threads",
    {
      title: "List Codex threads",
      description:
        "List local Codex conversations so another thread can be selected as a push target.",
      inputSchema: {
        search: z.string().optional().describe("Title, preview, or thread-ID substring."),
        cwd: z.string().optional().describe("Exact workspace path filter."),
        limit: z.number().int().min(1).max(100).default(20),
        include_archived: z.boolean().default(false),
      },
    },
    toolHandler(({ search, cwd, limit, include_archived: includeArchived }) => ({
      current_thread_id: process.env.CODEX_THREAD_ID || null,
      threads: listThreads({ search, cwd, limit, includeArchived }),
    })),
  );

  server.registerTool(
    "register_codex_agent",
    {
      title: "Register Codex agent alias",
      description:
        "Bind a stable alias such as reviewer or planner to an existing Codex thread ID.",
      inputSchema: {
        alias: z.string().min(1).max(64),
        thread_id: z.string().uuid(),
        description: z.string().max(500).default(""),
      },
    },
    toolHandler(({ alias, thread_id: threadId, description }) =>
      registerAgent({ alias, threadId, description }),
    ),
  );

  server.registerTool(
    "list_codex_agents",
    {
      title: "List registered Codex agents",
      description: "List aliases registered as message targets.",
      inputSchema: {},
    },
    toolHandler(() => ({ agents: listRegisteredAgents() })),
  );

  server.registerTool(
    "send_agent_message",
    {
      title: "Push prompt to Codex agent",
      description:
        "Push a report, request, handoff, or question into another Codex conversation. The target agent starts a new turn automatically and does not need to poll or call a receive tool.",
      inputSchema: {
        target: z
          .string()
          .min(1)
          .describe("Registered alias, exact thread UUID, or a uniquely matching thread title."),
        kind: z.enum(["report", "request", "handoff", "question"]).default("report"),
        subject: z.string().max(500).default(""),
        message: z.string().min(1).max(100000),
        ...deliveryOptionsSchema,
      },
    },
    toolHandler((args) => dispatch(args, args.message, args.kind, args.subject)),
  );

  server.registerTool(
    "report_task_completion",
    {
      title: "Report completed task to Codex agent",
      description:
        "Send a structured completion report with objective, requirement revision, artifacts, verification evidence, decisions, risks, and next steps to another Codex thread.",
      inputSchema: {
        target: z.string().min(1),
        task_id: z.string().max(200).optional(),
        requirement_revision: z.string().max(200).optional(),
        objective: z.string().min(1).max(5000),
        summary: z.string().min(1).max(20000),
        changed_files: z.array(z.string().max(2000)).max(200).default([]),
        verification: z.array(z.string().max(5000)).max(200).default([]),
        decisions: z.array(z.string().max(5000)).max(200).default([]),
        blockers: z.array(z.string().max(5000)).max(200).default([]),
        next_steps: z.array(z.string().max(5000)).max(200).default([]),
        ...deliveryOptionsSchema,
      },
    },
    toolHandler((args) => {
      const message = formatCompletionReport({
        taskId: args.task_id,
        requirementRevision: args.requirement_revision,
        objective: args.objective,
        summary: args.summary,
        changedFiles: args.changed_files,
        verification: args.verification,
        decisions: args.decisions,
        blockers: args.blockers,
        nextSteps: args.next_steps,
      });
      return dispatch(args, message, "report", `Task completed: ${args.objective.slice(0, 300)}`);
    }),
  );

  server.registerTool(
    "get_agent_delivery",
    {
      title: "Get agent delivery",
      description: "Get push status, delivery log tail, and the target agent's final response.",
      inputSchema: {
        delivery_id: z.string().uuid(),
      },
    },
    toolHandler(({ delivery_id: deliveryId }) => publicDelivery(getDelivery(deliveryId))),
  );

  server.registerTool(
    "list_agent_deliveries",
    {
      title: "List agent deliveries",
      description: "List recent inter-thread prompt deliveries.",
      inputSchema: {
        limit: z.number().int().min(1).max(100).default(20),
        status: z
          .enum(["queued", "waiting_for_target", "running", "completed", "failed"])
          .optional(),
      },
    },
    toolHandler(({ limit, status }) => ({ deliveries: listDeliveries({ limit, status }) })),
  );

  return server;
}

async function main() {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}
