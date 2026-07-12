#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import {
  createDelivery,
  findStateDatabase,
  getDelivery,
  getRuntimePaths,
} from "../src/bridge.js";
import { runDelivery } from "../src/worker.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const codexBin = process.env.MULTI_CODEX_CODEX_BIN || "codex";

function run(
  command,
  args,
  { cwd = projectRoot, env = process.env, input = "", timeoutMs = 180_000 } = {},
) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let killTimer;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      resolve({ ...result, stdout, stderr });
    };
    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 5000);
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", (error) => {
      if (settled) return;
      if (timedOut) {
        finish({ code: null, signal: null, timedOut: true, error: error.message });
        return;
      }
      clearTimeout(timeoutTimer);
      reject(error);
    });
    child.once("exit", (code, signal) => finish({ code, signal, timedOut }));
    child.stdin.end(input);
  });
}

function threadIdFromEvents(stdout) {
  for (const line of stdout.split("\n")) {
    try {
      const event = JSON.parse(line);
      if (event.type === "thread.started" && event.thread_id) return event.thread_id;
    } catch {
      // Ignore non-JSON diagnostics.
    }
  }
  return null;
}

function rolloutPath(threadId, env) {
  const db = new DatabaseSync(findStateDatabase(env), { readOnly: true });
  try {
    return db.prepare("SELECT rollout_path FROM threads WHERE id = ?").get(threadId)?.rollout_path;
  } finally {
    db.close();
  }
}

async function main() {
  const token = crypto.randomBytes(6).toString("hex");
  const expected = `BRIDGE_ACK_${token}`;
  const readyOutput = path.join(os.tmpdir(), `multi-codex-ready-${token}.txt`);
  const cleanEnv = { ...process.env };
  delete cleanEnv.CODEX_THREAD_ID;
  delete cleanEnv.CODEX_INTERNAL_ORIGINATOR_OVERRIDE;
  let threadId;
  let deliveryId;

  try {
    const created = await run(
      codexBin,
      [
        "exec",
        "--ignore-user-config",
        "--json",
        "--output-last-message",
        readyOutput,
        "Reply with exactly TARGET_READY and nothing else.",
      ],
      { env: cleanEnv },
    );
    threadId = threadIdFromEvents(created.stdout);
    if (created.timedOut) {
      throw new Error(`Timed out while creating the target Codex thread:\n${created.stderr}`);
    }
    if (created.code !== 0) {
      throw new Error(`Failed to create target Codex thread:\n${created.stderr || created.stdout}`);
    }
    if (!threadId) throw new Error(`No thread.started event found:\n${created.stdout}`);

    const bridgeEnv = {
      ...cleanEnv,
      MULTI_CODEX_IGNORE_USER_CONFIG: "1",
    };
    const delivery = createDelivery(
      {
        target: threadId,
        kind: "request",
        subject: "Multi-Codex bridge end-to-end verification",
        message: `Reply with exactly ${expected} and nothing else.`,
        targetWaitSeconds: 30,
        turnTimeoutSeconds: 300,
      },
      bridgeEnv,
    );
    deliveryId = delivery.id;
    const completed = await runDelivery(delivery.id, bridgeEnv);
    const finalRecord = getDelivery(delivery.id, bridgeEnv);
    if (completed.status !== "completed") {
      throw new Error(`Delivery failed: ${JSON.stringify(finalRecord, null, 2)}`);
    }
    if (finalRecord.response !== expected) {
      throw new Error(`Unexpected target response: ${JSON.stringify(finalRecord.response)}`);
    }

    const rollout = rolloutPath(threadId, bridgeEnv);
    if (!rollout || !fs.existsSync(rollout)) {
      throw new Error(`Persisted rollout was not found for target thread ${threadId}`);
    }
    const history = fs.readFileSync(rollout, "utf8");
    if (!history.includes(delivery.id) || !history.includes(expected)) {
      throw new Error("Target rollout does not contain both the delivery prompt and target reply.");
    }

    process.stdout.write(
      `${JSON.stringify(
        {
          ok: true,
          thread_id: threadId,
          delivery_id: delivery.id,
          response: finalRecord.response,
          persisted_rollout_verified: true,
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    fs.rmSync(readyOutput, { force: true });
    if (threadId) {
      await run(codexBin, ["delete", "--force", threadId], {
        env: cleanEnv,
        timeoutMs: 30_000,
      }).catch(() => {});
    }
    if (deliveryId) {
      const paths = getRuntimePaths(cleanEnv);
      for (const file of [
        path.join(paths.deliveries, `${deliveryId}.json`),
        path.join(paths.logs, `${deliveryId}.log`),
        path.join(paths.responses, `${deliveryId}.txt`),
      ]) {
        fs.rmSync(file, { force: true });
      }
    }
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
