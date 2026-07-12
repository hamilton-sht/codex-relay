import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createFakeCodex, createFixture } from "./helpers.js";

test("MCP server exposes and executes bridge tools", async () => {
  const fixture = createFixture();
  const fakeCodex = createFakeCodex(fixture.root);
  const serverEnv = {
    ...fixture.env,
    MULTI_CODEX_CODEX_BIN: fakeCodex,
    FAKE_CODEX_RESPONSE: "MCP_TARGET_ACK",
  };
  const client = new Client({ name: "multi-codex-test", version: "0.1.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["src/index.js"],
    cwd: process.cwd(),
    env: serverEnv,
    stderr: "pipe",
  });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    const names = tools.tools.map((tool) => tool.name);
    assert.ok(names.includes("send_agent_message"));
    assert.ok(names.includes("report_task_completion"));

    const result = await client.callTool({
      name: "list_codex_threads",
      arguments: { limit: 10 },
    });
    assert.equal(result.isError, undefined);
    assert.equal(result.structuredContent.current_thread_id, fixture.env.CODEX_THREAD_ID);
    assert.equal(result.structuredContent.threads.length, 2);

    const registered = await client.callTool({
      name: "register_codex_agent",
      arguments: {
        alias: "reviewer",
        thread_id: "01900000-0000-7000-8000-000000000002",
      },
    });
    assert.equal(registered.isError, undefined);

    const delivered = await client.callTool({
      name: "report_task_completion",
      arguments: {
        target: "reviewer",
        objective: "Verify the complete MCP delivery path.",
        summary: "The bridge implementation is ready for review.",
        changed_files: ["src/index.js"],
        verification: ["Automated MCP integration test"],
        wait_for_response: true,
        timeout_seconds: 10,
        turn_timeout_seconds: 10,
      },
    });
    assert.equal(delivered.isError, undefined);
    assert.equal(delivered.structuredContent.status, "completed");
    assert.equal(delivered.structuredContent.response, "MCP_TARGET_ACK");
  } finally {
    await client.close();
    fixture.cleanup();
  }
});
