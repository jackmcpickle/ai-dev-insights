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
  : { hooks: {}, version: 1 };

if (!existing.hooks || typeof existing.hooks !== "object") {
  existing.hooks = {};
}
if (!existing.version) {
  existing.version = 1;
}

/** @param {unknown} entry - Hook entry from Cursor hooks JSON. */
const isInsightsHook = (entry) => {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    return false;
  }
  const { command } = entry;
  return (
    typeof command === "string" &&
    (command.includes("ai-dev-insights") || command.includes("ingest.mjs"))
  );
};

/** @param {unknown[]} list - Existing hooks for one event. */
const mergeEventHooks = (list) => {
  let hasInsights = false;
  let upgraded = 0;
  const next = [];
  for (const entry of list) {
    if (!isInsightsHook(entry)) {
      next.push(entry);
      continue;
    }
    hasInsights = true;
    if (
      typeof entry === "object" &&
      entry !== null &&
      !Array.isArray(entry) &&
      entry.command !== INSIGHTS_COMMAND
    ) {
      upgraded += 1;
    }
    next.push({ ...INSIGHTS_HOOK });
  }
  if (!hasInsights) {
    next.push({ ...INSIGHTS_HOOK });
    return { added: 1, hooks: next, upgraded };
  }
  return { added: 0, hooks: next, upgraded };
};

let added = 0;
let upgraded = 0;
for (const event of EVENTS) {
  const list = Array.isArray(existing.hooks[event])
    ? existing.hooks[event]
    : [];
  const merged = mergeEventHooks(list);
  existing.hooks[event] = merged.hooks;
  added += merged.added;
  upgraded += merged.upgraded;
}

writeFileSync(hooksPath, `${JSON.stringify(existing, null, 2)}\n`);
process.stdout.write(
  `Merged ai-dev-insights into ${hooksPath} (${added} added, ${upgraded} upgraded)\n`
);
