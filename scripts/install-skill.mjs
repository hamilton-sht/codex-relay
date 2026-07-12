#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(projectRoot, "skills", "multi-codex-align");
const codexHome = path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"));
const destination = path.join(codexHome, "skills", "multi-codex-align");

if (!fs.existsSync(path.join(source, "SKILL.md"))) {
  throw new Error(`Skill source not found: ${source}`);
}
fs.mkdirSync(path.dirname(destination), { recursive: true });
fs.rmSync(destination, { recursive: true, force: true });
fs.cpSync(source, destination, { recursive: true });
process.stdout.write(`Installed multi-codex-align to ${destination}\n`);
