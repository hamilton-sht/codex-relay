import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const FOLLOWER_METHOD = "thread-follower-start-turn";
const FOLLOWER_PROTOCOL_VERSION = 1;

export class GuiDeliveryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "GuiDeliveryError";
    this.code = code;
  }
}

export function defaultAppIpcSocket(env = process.env) {
  if (env.MULTI_CODEX_APP_IPC_SOCKET) return path.resolve(env.MULTI_CODEX_APP_IPC_SOCKET);
  if (typeof process.getuid !== "function") {
    throw new GuiDeliveryError(
      "GUI_IPC_UNSUPPORTED",
      "Codex App GUI delivery currently requires macOS or another Unix platform.",
    );
  }
  return path.join(env.TMPDIR || os.tmpdir(), "codex-ipc", `ipc-${process.getuid()}.sock`);
}

class AppIpcClient {
  constructor(socketPath) {
    this.socketPath = socketPath;
    this.buffer = Buffer.alloc(0);
    this.pending = new Map();
    this.clientId = "initializing-client";
  }

  async connect() {
    if (!fs.existsSync(this.socketPath)) {
      throw new GuiDeliveryError(
        "GUI_IPC_NOT_FOUND",
        `Codex App IPC socket not found: ${this.socketPath}`,
      );
    }
    this.socket = net.createConnection(this.socketPath);
    this.socket.on("data", (chunk) => this.handleData(chunk));
    await new Promise((resolve, reject) => {
      this.socket.once("connect", resolve);
      this.socket.once("error", reject);
    });
    const response = await this.request("initialize", { clientType: "multi-codex" }, 0, 5000);
    if (response.resultType !== "success") {
      throw new GuiDeliveryError(
        "GUI_IPC_INITIALIZE_FAILED",
        `Codex App IPC initialization failed: ${response.error || "unknown error"}`,
      );
    }
    this.clientId = response.result.clientId;
    return this;
  }

  request(method, params, version, timeoutMs) {
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(
          new GuiDeliveryError("GUI_IPC_TIMEOUT", `Codex App IPC request timed out: ${method}`),
        );
      }, timeoutMs + 1000);
      this.pending.set(requestId, { resolve, reject, timer });
      this.write({
        type: "request",
        requestId,
        sourceClientId: this.clientId,
        version,
        method,
        params,
        timeoutMs,
      });
    });
  }

  write(message) {
    const body = Buffer.from(JSON.stringify(message));
    const frame = Buffer.alloc(4 + body.length);
    frame.writeUInt32LE(body.length, 0);
    body.copy(frame, 4);
    this.socket.write(frame);
  }

  handleData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32LE(0);
      if (this.buffer.length < 4 + length) return;
      const message = JSON.parse(this.buffer.subarray(4, 4 + length).toString("utf8"));
      this.buffer = this.buffer.subarray(4 + length);
      if (message.type !== "response") continue;
      const pending = this.pending.get(message.requestId);
      if (!pending) continue;
      this.pending.delete(message.requestId);
      clearTimeout(pending.timer);
      pending.resolve(message);
    }
  }

  close() {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new GuiDeliveryError("GUI_IPC_CLOSED", "Codex App IPC connection closed."));
    }
    this.pending.clear();
    this.socket?.end();
  }
}

function findCompletedTurn(rollout, turnId) {
  for (const line of rollout.split("\n")) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      const payload = event.type === "event_msg" ? event.payload : null;
      if (payload?.type === "task_complete" && payload.turn_id === turnId) {
        return payload.last_agent_message || "";
      }
    } catch {
      // The final line can be incomplete while Codex is appending to the rollout.
    }
  }
  return null;
}

export async function waitForRolloutTurn({ rolloutPath, turnId, timeoutSeconds = 900 }) {
  if (!rolloutPath || !fs.existsSync(rolloutPath)) {
    throw new GuiDeliveryError(
      "ROLLOUT_NOT_FOUND",
      `Target rollout file not found: ${rolloutPath || "unknown"}`,
    );
  }
  const deadline = Date.now() + Math.max(1, Number(timeoutSeconds)) * 1000;
  while (Date.now() < deadline) {
    const answer = findCompletedTurn(fs.readFileSync(rolloutPath, "utf8"), turnId);
    if (answer !== null) return answer;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new GuiDeliveryError(
    "TURN_TIMEOUT",
    `Target GUI turn exceeded ${timeoutSeconds} seconds: ${turnId}`,
  );
}

export async function startGuiTurn({ threadId, message, ipcSocket, env = process.env }) {
  const client = await new AppIpcClient(ipcSocket || defaultAppIpcSocket(env)).connect();
  let response;
  try {
    response = await client.request(
      FOLLOWER_METHOD,
      {
        conversationId: threadId,
        turnStartParams: {
          threadId,
          input: [{ type: "text", text: message, text_elements: [] }],
        },
      },
      FOLLOWER_PROTOCOL_VERSION,
      15000,
    );
  } finally {
    client.close();
  }
  if (response.resultType !== "success") {
    const detail = response.error || "unknown error";
    const code = detail === "no-client-found" ? "GUI_OWNER_NOT_FOUND" : "GUI_TURN_START_FAILED";
    throw new GuiDeliveryError(
      code,
      `Codex App could not deliver to the target GUI owner: ${detail}`,
    );
  }
  const turnId = response.result?.result?.turn?.id;
  if (!turnId) {
    throw new GuiDeliveryError(
      "GUI_TURN_ID_MISSING",
      "Codex App accepted the request but returned no Turn ID.",
    );
  }
  return turnId;
}

export async function deliverGuiTurn({
  threadId,
  rolloutPath,
  message,
  timeoutSeconds = 900,
  ipcSocket,
  env = process.env,
}) {
  const turnId = await startGuiTurn({ threadId, message, ipcSocket, env });
  const response = await waitForRolloutTurn({ rolloutPath, turnId, timeoutSeconds });
  return { turnId, response };
}
