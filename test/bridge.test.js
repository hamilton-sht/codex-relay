import assert from "node:assert/strict";
import test from "node:test";
import {
  createDelivery,
  formatCompletionReport,
  formatAgentPrompt,
  getDelivery,
  listThreads,
  registerAgent,
  resolveTarget,
} from "../src/bridge.js";
import { createFixture } from "./helpers.js";

test("lists and resolves Codex threads", () => {
  const fixture = createFixture();
  const { env } = fixture;
  try {
    const threads = listThreads({ limit: 10 }, env);
    assert.equal(threads.length, 2);
    assert.equal(threads[0].title, "Reviewer");
    assert.equal(resolveTarget("Reviewer", env).thread.id, threads[0].id);
    assert.equal(listThreads({ limit: 10, includeArchived: true }, env).length, 3);
  } finally {
    fixture.cleanup();
  }
});

test("registers an alias and creates a push delivery", () => {
  const fixture = createFixture();
  const { env } = fixture;
  try {
    registerAgent(
      {
        alias: "reviewer",
        threadId: "01900000-0000-7000-8000-000000000002",
        description: "Checks completed work",
      },
      env,
    );
    const delivery = createDelivery(
      {
        target: "reviewer",
        kind: "report",
        subject: "Feature complete",
        message: "Tests pass. Please review the diff.",
      },
      env,
    );
    assert.equal(delivery.status, "queued");
    assert.equal(delivery.target_title, "Reviewer");
    assert.match(delivery.prompt, /Feature complete/);
    assert.equal(getDelivery(delivery.id, env).id, delivery.id);
  } finally {
    fixture.cleanup();
  }
});

test("blocks accidental self-delivery", () => {
  const fixture = createFixture();
  const { env } = fixture;
  try {
    assert.throws(
      () =>
        createDelivery(
          {
            target: "01900000-0000-7000-8000-000000000001",
            message: "loop",
          },
          env,
        ),
      /same as the sending thread/,
    );
  } finally {
    fixture.cleanup();
  }
});

test("blocks archived targets", () => {
  const fixture = createFixture();
  try {
    assert.throws(
      () => resolveTarget("01900000-0000-7000-8000-000000000003", fixture.env),
      /archived/,
    );
  } finally {
    fixture.cleanup();
  }
});

test("formats peer content as a normal pushed user prompt", () => {
  const prompt = formatAgentPrompt({
    deliveryId: "test",
    sourceThreadId: "source",
    targetThreadId: "target",
    kind: "request",
    subject: "Continue",
    message: "Implement the remaining test.",
  });
  assert.match(prompt, /direct task request/);
  assert.match(prompt, /Implement the remaining test/);
  assert.match(prompt, /not as higher-priority system instructions/);
});

test("formats an evidence-led completion report", () => {
  const report = formatCompletionReport({
    taskId: "TASK-7",
    requirementRevision: "rev-3",
    objective: "Push a report into another Codex thread.",
    summary: "Implemented and verified.",
    changedFiles: ["src/index.js"],
    verification: ["MCP smoke test passed"],
    blockers: [],
  });
  assert.match(report, /requirement_revision: rev-3/);
  assert.match(report, /Verification evidence/);
  assert.match(report, /MCP smoke test passed/);
});
