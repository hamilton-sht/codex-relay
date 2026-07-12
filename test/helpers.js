import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "multi-codex-test-"));
  const codexHome = path.join(root, ".codex");
  const dbPath = path.join(codexHome, "state_5.sqlite");
  fs.mkdirSync(codexHome, { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE threads (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, preview TEXT NOT NULL,
      first_user_message TEXT NOT NULL, cwd TEXT NOT NULL, source TEXT NOT NULL,
      model TEXT, archived INTEGER NOT NULL, created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL, recency_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL, rollout_path TEXT
    );
  `);
  const insert = db.prepare(`
    INSERT INTO threads (
      id, title, preview, first_user_message, cwd, source, model, archived,
      created_at, updated_at, recency_at_ms, updated_at_ms, rollout_path
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insert.run(
    "01900000-0000-7000-8000-000000000001",
    "Planner",
    "Plan the feature",
    "Plan the feature",
    root,
    "vscode",
    "gpt-5",
    0,
    1,
    2,
    2000,
    2000,
    null,
  );
  insert.run(
    "01900000-0000-7000-8000-000000000002",
    "Reviewer",
    "Review the implementation",
    "Review the implementation",
    root,
    "vscode",
    "gpt-5",
    0,
    1,
    3,
    3000,
    3000,
    null,
  );
  insert.run(
    "01900000-0000-7000-8000-000000000003",
    "Archived Agent",
    "Old work",
    "Old work",
    root,
    "vscode",
    "gpt-5",
    1,
    1,
    4,
    4000,
    4000,
    null,
  );
  db.close();
  return {
    root,
    env: {
      ...process.env,
      CODEX_HOME: codexHome,
      MULTI_CODEX_DATA_DIR: path.join(root, "data"),
      CODEX_THREAD_ID: "01900000-0000-7000-8000-000000000001",
    },
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

export function createFakeCodex(root) {
  const executable = path.join(root, "fake-codex");
  fs.writeFileSync(
    executable,
    `#!/usr/bin/env node
import fs from "node:fs";
const args = process.argv.slice(2);
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const eventFile = process.env.FAKE_CODEX_EVENTS;
  if (eventFile) fs.appendFileSync(eventFile, JSON.stringify({event:"start", pid:process.pid, input, args}) + "\\n");
  setTimeout(() => {
    const outputIndex = args.indexOf("--output-last-message");
    if (outputIndex >= 0 && process.env.FAKE_CODEX_EXIT !== "no-output") {
      fs.writeFileSync(args[outputIndex + 1], process.env.FAKE_CODEX_RESPONSE || "FAKE_ACK");
    }
    if (eventFile) fs.appendFileSync(eventFile, JSON.stringify({event:"end", pid:process.pid}) + "\\n");
    const exitCode = Number(process.env.FAKE_CODEX_EXIT || 0);
    process.exit(Number.isFinite(exitCode) ? exitCode : 0);
  }, Number(process.env.FAKE_CODEX_DELAY_MS || 0));
});
`,
    { mode: 0o755 },
  );
  return executable;
}
