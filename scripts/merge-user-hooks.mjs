#!/usr/bin/env node
/**
 * Merge ai-dev-insights observe hooks into ~/.cursor/hooks.json without
 * clobbering existing entries. Upgrades direct node paths to the fail-open wrapper.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const INSIGHTS_COMMAND = "bash ./hooks/run-ai-dev-insights.sh";
const INSIGHTS_HOOK = { command: INSIGHTS_COMMAND, timeout: 8 };
const EVENTS = [
  "sessionStart",
  "sessionEnd",
  "beforeSubmitPrompt",
  "afterAgentResponse",
  "afterAgentThought",
  "stop",
  "preCompact",
  "subagentStart",
  "subagentStop",
];

const hooksPath = path.join(homedir(), ".cursor/hooks.json");
/** @type {{ version?: number, hooks?: Record<string, unknown[]> }} */
const existing = existsSync(hooksPath)
  ? JSON.parse(readFileSync(hooksPath, "utf-8"))
  : { version: 1, hooks: {} };

if (!existing.hooks || typeof existing.hooks !== "object") {
  existing.hooks = {};
}
if (!existing.version) {
  existing.version = 1;
}

/** @param {unknown} entry */
const isInsightsHook = (entry) => {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    return false;
  }
  const command = entry.command;
  return (
    typeof command === "string" &&
    (command.includes("ai-dev-insights") || command.includes("ingest.mjs"))
  );
};

let added = 0;
let upgraded = 0;
for (const event of EVENTS) {
  const list = Array.isArray(existing.hooks[event]) ? existing.hooks[event] : [];
  if (!Array.isArray(existing.hooks[event])) {
    existing.hooks[event] = list;
  }

  let hasInsights = false;
  const next = list.map((entry) => {
    if (!isInsightsHook(entry)) {
      return entry;
    }
    hasInsights = true;
    if (entry.command !== INSIGHTS_COMMAND) {
      upgraded += 1;
    }
    return { ...INSIGHTS_HOOK };
  });

  if (!hasInsights) {
    next.push({ ...INSIGHTS_HOOK });
    added += 1;
  }
  existing.hooks[event] = next;
}

writeFileSync(hooksPath, `${JSON.stringify(existing, null, 2)}\n`);
process.stdout.write(
  `Merged ai-dev-insights into ${hooksPath} (${added} added, ${upgraded} upgraded)\n`
);
