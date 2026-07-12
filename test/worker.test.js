import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { createDelivery, getDelivery } from "../src/bridge.js";
import { runDelivery } from "../src/worker.js";
import { createFakeCodex, createFixture } from "./helpers.js";

test("worker pushes the prompt and captures the target response", async () => {
  const fixture = createFixture();
  try {
    const fakeCodex = createFakeCodex(fixture.root);
    const events = path.join(fixture.root, "events.jsonl");
    const env = {
      ...fixture.env,
      MULTI_CODEX_CODEX_BIN: fakeCodex,
      FAKE_CODEX_EVENTS: events,
      FAKE_CODEX_RESPONSE: "TARGET_ACK",
    };
    const delivery = createDelivery(
      {
        target: "Reviewer",
        kind: "request",
        message: "Please continue the task.",
        turnTimeoutSeconds: 10,
      },
      env,
    );

    const result = await runDelivery(delivery.id, env);
    assert.equal(result.status, "completed");
    assert.equal(getDelivery(delivery.id, env).response, "TARGET_ACK");
    const event = JSON.parse(fs.readFileSync(events, "utf8").trim().split("\n")[0]);
    assert.match(event.input, /Please continue the task/);
    assert.deepEqual(event.args.slice(0, 2), ["exec", "resume"]);
    assert.ok(event.args.includes(delivery.target_thread_id));
  } finally {
    fixture.cleanup();
  }
});

test("worker records executable launch failures", async () => {
  const fixture = createFixture();
  try {
    const env = {
      ...fixture.env,
      MULTI_CODEX_CODEX_BIN: path.join(fixture.root, "missing-codex"),
    };
    const delivery = createDelivery(
      { target: "Reviewer", message: "This should fail to launch.", targetWaitSeconds: 0 },
      env,
    );
    const result = await runDelivery(delivery.id, env);
    assert.equal(result.status, "failed");
    assert.equal(result.error_code, "ENOENT");
  } finally {
    fixture.cleanup();
  }
});

test("deliveries to the same target are serialized", async () => {
  const fixture = createFixture();
  try {
    const fakeCodex = createFakeCodex(fixture.root);
    const events = path.join(fixture.root, "events.jsonl");
    const env = {
      ...fixture.env,
      MULTI_CODEX_CODEX_BIN: fakeCodex,
      FAKE_CODEX_EVENTS: events,
      FAKE_CODEX_DELAY_MS: "150",
    };
    const first = createDelivery(
      { target: "Reviewer", message: "First", targetWaitSeconds: 5, turnTimeoutSeconds: 10 },
      env,
    );
    const second = createDelivery(
      { target: "Reviewer", message: "Second", targetWaitSeconds: 5, turnTimeoutSeconds: 10 },
      env,
    );

    const results = await Promise.all([runDelivery(first.id, env), runDelivery(second.id, env)]);
    assert.deepEqual(
      results.map((item) => item.status),
      ["completed", "completed"],
    );
    const recorded = fs
      .readFileSync(events, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    let active = 0;
    for (const event of recorded) {
      active += event.event === "start" ? 1 : -1;
      assert.ok(active >= 0 && active <= 1, "target executions must not overlap");
    }
    assert.equal(active, 0);
  } finally {
    fixture.cleanup();
  }
});

test("a delivery fails clearly when the target queue wait expires", async () => {
  const fixture = createFixture();
  try {
    const fakeCodex = createFakeCodex(fixture.root);
    const env = {
      ...fixture.env,
      MULTI_CODEX_CODEX_BIN: fakeCodex,
      FAKE_CODEX_DELAY_MS: "500",
    };
    const first = createDelivery(
      { target: "Reviewer", message: "Hold lock", targetWaitSeconds: 5 },
      env,
    );
    const second = createDelivery(
      { target: "Reviewer", message: "Do not wait", targetWaitSeconds: 0 },
      env,
    );
    const firstRun = runDelivery(first.id, env);
    const lockFile = path.join(
      env.MULTI_CODEX_DATA_DIR,
      "locks",
      `${first.target_thread_id}.lock`,
    );
    for (let index = 0; index < 100 && !fs.existsSync(lockFile); index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const secondResult = await runDelivery(second.id, env);
    assert.equal(secondResult.status, "failed");
    assert.equal(secondResult.error_code, "TARGET_BUSY_TIMEOUT");
    assert.equal((await firstRun).status, "completed");
  } finally {
    fixture.cleanup();
  }
});

test("a target turn is terminated after its configured timeout", async () => {
  const fixture = createFixture();
  try {
    const fakeCodex = createFakeCodex(fixture.root);
    const env = {
      ...fixture.env,
      MULTI_CODEX_CODEX_BIN: fakeCodex,
      FAKE_CODEX_DELAY_MS: "2000",
    };
    const delivery = createDelivery(
      { target: "Reviewer", message: "Timeout", turnTimeoutSeconds: 1 },
      env,
    );
    const result = await runDelivery(delivery.id, env);
    assert.equal(result.status, "failed");
    assert.equal(result.error_code, "TURN_TIMEOUT");
  } finally {
    fixture.cleanup();
  }
});
