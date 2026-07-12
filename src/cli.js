#!/usr/bin/env node

import fs from "node:fs";
import { createDelivery, getDelivery, listThreads, publicDelivery } from "./bridge.js";
import { runDelivery } from "./worker.js";

function usage(exitCode = 0) {
  const output = `Codex Relay

Usage:
  multi-codex threads [SEARCH]
  multi-codex send --target TITLE_OR_ID (--message TEXT | --file FILE) [options]
  multi-codex gui-send --target TITLE_OR_ID (--message TEXT | --file FILE) [options]

Options:
  --mode auto|gui|cli  Delivery backend for send (default: auto)
  --timeout SECONDS   Target turn timeout (default: 900)
  --help              Show help

Use gui-send when the target Thread is open in another Codex App window and must render live.
`;
  (exitCode ? process.stderr : process.stdout).write(output);
  process.exit(exitCode);
}

function parseOptions(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === "--help") usage();
    if (!key.startsWith("--") || argv[index + 1] == null) usage(2);
    options[key.slice(2)] = argv[++index];
  }
  return options;
}

async function send(argv, forcedMode) {
  const options = parseOptions(argv);
  if (!options.target) usage(2);
  if (Boolean(options.message) === Boolean(options.file)) {
    throw new Error("Use exactly one of --message or --file.");
  }
  const message = options.message ?? fs.readFileSync(options.file, "utf8");
  const mode = forcedMode || options.mode || "auto";
  const timeout = Math.max(1, Math.min(Number(options.timeout || 900), 14_400));
  const delivery = createDelivery({
    target: options.target,
    message,
    kind: "request",
    deliveryMode: mode,
    turnTimeoutSeconds: timeout,
  });
  process.stderr.write(
    `Target: ${JSON.stringify(delivery.target_title)} (${delivery.target_thread_id})\n` +
      `Delivery: ${delivery.id} mode=${mode}\n`,
  );
  const result = await runDelivery(delivery.id);
  process.stdout.write(`${JSON.stringify(publicDelivery(getDelivery(delivery.id)), null, 2)}\n`);
  process.exitCode = result.status === "completed" ? 0 : 1;
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === "--help" || command === "help") usage();
  if (command === "threads") {
    const search = args.join(" ").trim();
    const threads = listThreads({ search, limit: 50 });
    for (const thread of threads) {
      process.stdout.write(`${thread.id}\n  ${thread.title}\n  ${thread.cwd}\n`);
    }
    return;
  }
  if (command === "send") return send(args);
  if (command === "gui-send") return send(args, "gui");
  usage(2);
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
