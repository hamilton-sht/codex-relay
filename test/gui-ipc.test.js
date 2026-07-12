import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { deliverGuiTurn, startGuiTurn } from "../src/gui-ipc.js";

function writeFrame(socket, message) {
  const body = Buffer.from(JSON.stringify(message));
  const frame = Buffer.alloc(4 + body.length);
  frame.writeUInt32LE(body.length, 0);
  body.copy(frame, 4);
  socket.write(frame);
}

async function createFakeAppRouter(root, onFollowerRequest) {
  const socketPath = path.join(root, "codex-app.sock");
  const server = net.createServer((socket) => {
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4) {
        const length = buffer.readUInt32LE(0);
        if (buffer.length < 4 + length) return;
        const request = JSON.parse(buffer.subarray(4, 4 + length).toString("utf8"));
        buffer = buffer.subarray(4 + length);
        if (request.method === "initialize") {
          writeFrame(socket, {
            type: "response",
            requestId: request.requestId,
            resultType: "success",
            method: "initialize",
            result: { clientId: "fake-client" },
          });
          continue;
        }
        onFollowerRequest(socket, request);
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  return { server, socketPath };
}

test("GUI delivery starts an owner-window turn and reads its final response", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "multi-codex-gui-test-"));
  const rolloutPath = path.join(root, "rollout.jsonl");
  fs.writeFileSync(rolloutPath, "");
  const threadId = "01900000-0000-7000-8000-000000000099";
  const turnId = "01900000-0000-7000-8000-000000000100";
  const { server, socketPath } = await createFakeAppRouter(root, (socket, request) => {
    assert.equal(request.method, "thread-follower-start-turn");
    assert.equal(request.version, 1);
    assert.equal(request.params.conversationId, threadId);
    assert.equal(request.params.turnStartParams.threadId, threadId);
    assert.equal(request.params.turnStartParams.input[0].text, "GUI test prompt");
    writeFrame(socket, {
      type: "response",
      requestId: request.requestId,
      resultType: "success",
      method: request.method,
      result: { result: { turn: { id: turnId, status: "inProgress" } } },
    });
    setTimeout(() => {
      fs.appendFileSync(
        rolloutPath,
        `${JSON.stringify({
          type: "event_msg",
          payload: {
            type: "task_complete",
            turn_id: turnId,
            last_agent_message: "GUI_TARGET_ACK",
          },
        })}\n`,
      );
    }, 20);
  });
  try {
    const result = await deliverGuiTurn({
      threadId,
      rolloutPath,
      message: "GUI test prompt",
      timeoutSeconds: 5,
      ipcSocket: socketPath,
    });
    assert.deepEqual(result, { turnId, response: "GUI_TARGET_ACK" });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("GUI delivery reports when no target owner window is open", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "multi-codex-gui-test-"));
  const { server, socketPath } = await createFakeAppRouter(root, (socket, request) => {
    writeFrame(socket, {
      type: "response",
      requestId: request.requestId,
      resultType: "error",
      error: "no-client-found",
    });
  });
  try {
    await assert.rejects(
      startGuiTurn({
        threadId: "01900000-0000-7000-8000-000000000099",
        message: "No owner",
        ipcSocket: socketPath,
      }),
      (error) => error.code === "GUI_OWNER_NOT_FOUND",
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
