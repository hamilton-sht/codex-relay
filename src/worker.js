#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  ensureRuntime,
  getDelivery,
  getRuntimePaths,
  updateDelivery,
} from "./bridge.js";
import { deliverGuiTurn } from "./gui-ipc.js";

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--delivery-id") result.deliveryId = argv[index + 1];
  }
  if (!result.deliveryId) {
    throw new Error("Usage: node src/worker.js --delivery-id <uuid>");
  }
  return result;
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function targetLockFile(threadId, env) {
  const paths = ensureRuntime(getRuntimePaths(env));
  return path.join(paths.locks, `${threadId}.lock`);
}

async function acquireTargetLock(delivery, env) {
  const file = targetLockFile(delivery.target_thread_id, env);
  const waitMilliseconds = Number(delivery.target_wait_seconds || 0) * 1000;
  const deadline = Date.now() + waitMilliseconds;
  let lastStatusUpdate = 0;
  const waitingSince = new Date().toISOString();

  while (true) {
    try {
      const fd = fs.openSync(file, "wx", 0o600);
      fs.writeFileSync(
        fd,
        `${JSON.stringify({
          delivery_id: delivery.id,
          pid: process.pid,
          acquired_at: new Date().toISOString(),
        })}\n`,
      );
      return { fd, file, deliveryId: delivery.id };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;

      // Remove locks left by a dead worker after twice the maximum supported turn duration.
      try {
        let lockOwner = {};
        try {
          lockOwner = JSON.parse(fs.readFileSync(file, "utf8"));
        } catch {
          const stat = fs.statSync(file);
          if (Date.now() - stat.mtimeMs > 60_000) {
            fs.unlinkSync(file);
            continue;
          }
        }
        if (lockOwner.pid) {
          try {
            process.kill(lockOwner.pid, 0);
          } catch (pidError) {
            if (pidError.code === "ESRCH") {
              fs.unlinkSync(file);
              continue;
            }
          }
        }
        const stat = fs.statSync(file);
        if (Date.now() - stat.mtimeMs > 28_800_000) {
          fs.unlinkSync(file);
          continue;
        }
      } catch (statError) {
        if (statError.code === "ENOENT") continue;
        throw statError;
      }

      if (Date.now() >= deadline) {
        const timeoutError = new Error(
          `Target thread remained busy for ${delivery.target_wait_seconds || 0} seconds.`,
        );
        timeoutError.code = "TARGET_BUSY_TIMEOUT";
        throw timeoutError;
      }

      if (Date.now() - lastStatusUpdate >= 1000) {
        updateDelivery(
          delivery.id,
          {
            status: "waiting_for_target",
            waiting_since: waitingSince,
          },
          env,
        );
        lastStatusUpdate = Date.now();
      }
      await sleep(250);
    }
  }
}

function releaseTargetLock(lock) {
  if (!lock) return;
  try {
    fs.closeSync(lock.fd);
  } catch {
    // The descriptor may already be closed after an exceptional path.
  }
  try {
    const current = JSON.parse(fs.readFileSync(lock.file, "utf8"));
    if (current.delivery_id === lock.deliveryId) fs.unlinkSync(lock.file);
  } catch (error) {
    if (error.code !== "ENOENT") {
      process.stderr.write(`Failed to release target lock ${lock.file}: ${error.message}\n`);
    }
  }
}

function waitForChild(child, timeoutMilliseconds) {
  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    let killTimer;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      resolve({ ...result, timedOut });
    };

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 5000);
    }, timeoutMilliseconds);

    child.once("error", (error) => finish({ code: null, signal: null, error }));
    child.once("exit", (code, signal) => finish({ code, signal, error: null }));
  });
}

async function executeCodex(delivery, env) {
  const codexBin = env.MULTI_CODEX_CODEX_BIN || "codex";
  const outputFile = delivery.response_path;
  const logFile = delivery.log_path;
  fs.mkdirSync(path.dirname(outputFile), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.dirname(logFile), { recursive: true, mode: 0o700 });
  fs.rmSync(outputFile, { force: true });

  const logFd = fs.openSync(logFile, "a", 0o600);
  fs.writeSync(logFd, `[${new Date().toISOString()}] Delivering to ${delivery.target_thread_id}\n`);

  const childEnv = { ...env };
  delete childEnv.CODEX_THREAD_ID;
  delete childEnv.CODEX_INTERNAL_ORIGINATOR_OVERRIDE;

  const args = [
    "exec",
    "resume",
  ];
  if (env.MULTI_CODEX_IGNORE_USER_CONFIG === "1") args.push("--ignore-user-config");
  args.push(
    "--json",
    "--output-last-message",
    outputFile,
    delivery.target_thread_id,
    "-",
  );

  let child;
  try {
    child = spawn(codexBin, args, {
      cwd: fs.existsSync(delivery.target_cwd) ? delivery.target_cwd : process.cwd(),
      env: childEnv,
      stdio: ["pipe", logFd, logFd],
    });
  } catch (error) {
    fs.closeSync(logFd);
    return { code: null, signal: null, error, timedOut: false, backend: "cli" };
  }

  if (child.pid) updateDelivery(delivery.id, { codex_pid: child.pid }, env);
  child.stdin.on("error", (error) => {
    try {
      fs.writeSync(logFd, `stdin error: ${error.message}\n`);
    } catch {
      // The process result below is authoritative.
    }
  });
  child.stdin.end(delivery.prompt);

  const result = await waitForChild(
    child,
    Math.max(1, Number(delivery.turn_timeout_seconds || 1800)) * 1000,
  );
  fs.closeSync(logFd);
  return { ...result, backend: "cli" };
}

async function executeGui(delivery, env) {
  const outputFile = delivery.response_path;
  const logFile = delivery.log_path;
  fs.mkdirSync(path.dirname(outputFile), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.dirname(logFile), { recursive: true, mode: 0o700 });
  fs.rmSync(outputFile, { force: true });
  fs.appendFileSync(
    logFile,
    `[${new Date().toISOString()}] Delivering through Codex App GUI IPC to ${delivery.target_thread_id}\n`,
    { mode: 0o600 },
  );
  try {
    const result = await deliverGuiTurn({
      threadId: delivery.target_thread_id,
      rolloutPath: delivery.target_rollout_path,
      message: delivery.prompt,
      timeoutSeconds: Math.max(1, Number(delivery.turn_timeout_seconds || 1800)),
      env,
    });
    fs.writeFileSync(outputFile, result.response, { mode: 0o600 });
    fs.appendFileSync(
      logFile,
      `[${new Date().toISOString()}] GUI turn completed: ${result.turnId}\n`,
    );
    return {
      code: 0,
      signal: null,
      error: null,
      timedOut: false,
      backend: "gui",
      turnId: result.turnId,
    };
  } catch (error) {
    fs.appendFileSync(
      logFile,
      `[${new Date().toISOString()}] GUI delivery failed: ${error.code || "GUI_DELIVERY_FAILED"} ${error.message}\n`,
    );
    return {
      code: null,
      signal: null,
      error,
      timedOut: error.code === "TURN_TIMEOUT",
      backend: "gui",
    };
  }
}

async function executeDelivery(delivery, env) {
  const mode = delivery.delivery_mode || "auto";
  if (mode !== "cli") {
    const guiResult = await executeGui(delivery, env);
    if (!guiResult.error || mode === "gui") return guiResult;
    fs.appendFileSync(
      delivery.log_path,
      `[${new Date().toISOString()}] Falling back to CLI delivery.\n`,
    );
  }
  return executeCodex(delivery, env);
}

export async function runDelivery(deliveryId, env = process.env) {
  const delivery = getDelivery(deliveryId, env);
  let lock;

  try {
    lock = await acquireTargetLock(delivery, env);
    updateDelivery(
      deliveryId,
      {
        status: "running",
        started_at: new Date().toISOString(),
        worker_pid: process.pid,
        attempts: Number(delivery.attempts || 0) + 1,
      },
      env,
    );

    const result = await executeDelivery(delivery, env);
    if (result.timedOut) {
      return updateDelivery(
        deliveryId,
        {
          status: "failed",
          completed_at: new Date().toISOString(),
          exit_code: result.code,
          signal: result.signal || null,
          error_code: "TURN_TIMEOUT",
          error: `Target Codex turn exceeded ${delivery.turn_timeout_seconds} seconds.`,
          delivery_backend: result.backend,
        },
        env,
      );
    }

    if (result.error || result.code !== 0) {
      return updateDelivery(
        deliveryId,
        {
          status: "failed",
          completed_at: new Date().toISOString(),
          exit_code: result.code,
          signal: result.signal || null,
          error_code: result.error?.code || "CODEX_EXEC_FAILED",
          error: result.error?.message || `codex exited with code ${result.code}`,
          delivery_backend: result.backend,
        },
        env,
      );
    }

    return updateDelivery(
      deliveryId,
      {
        status: "completed",
        completed_at: new Date().toISOString(),
        exit_code: 0,
        response_available: fs.existsSync(delivery.response_path),
        delivery_backend: result.backend,
        target_turn_id: result.turnId || null,
      },
      env,
    );
  } catch (error) {
    return updateDelivery(
      deliveryId,
      {
        status: "failed",
        completed_at: new Date().toISOString(),
        error_code: error.code || "WORKER_FAILED",
        error: error.message,
      },
      env,
    );
  } finally {
    releaseTargetLock(lock);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const { deliveryId } = parseArgs(process.argv.slice(2));
    const result = await runDelivery(deliveryId);
    process.exitCode = result.status === "completed" ? 0 : 1;
  } catch (error) {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  }
}
