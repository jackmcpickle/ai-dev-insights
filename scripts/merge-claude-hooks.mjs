#!/usr/bin/env node
/**
 * Merge ai-dev-insights observe hooks into ~/.claude/settings.json without
 * clobbering existing entries. Upgrades old project-local ingest paths.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const wrapperPath = path.join(
  homedir(),
  ".claude/hooks/run-ai-dev-insights.sh"
);
const COMMAND = `bash "${wrapperPath}"`;
const INSIGHTS_HOOK = { command: COMMAND, timeout: 8, type: "command" };
const EVENTS = [
  "SessionStart",
  "SessionEnd",
  "UserPromptSubmit",
  "Stop",
  "StopFailure",
  "PreCompact",
  "SubagentStart",
  "SubagentStop",
];

const settingsPath = path.join(homedir(), ".claude/settings.json");
/** @type {{ hooks?: Record<string, unknown[]> }} */
const existing = existsSync(settingsPath)
  ? JSON.parse(readFileSync(settingsPath, "utf-8"))
  : { hooks: {} };

if (!existing.hooks || typeof existing.hooks !== "object") {
  existing.hooks = {};
}

/** @param {unknown} hook - Hook command entry from settings JSON. */
const isInsightsCommand = (hook) =>
  typeof hook === "object" &&
  hook !== null &&
  !Array.isArray(hook) &&
  typeof hook.command === "string" &&
  (hook.command.includes("ingest.mjs") ||
    hook.command.includes("ai-dev-insights"));

/** @param {unknown} entry - Matcher group from Claude settings JSON. */
const isInsightsGroup = (entry) => {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    return false;
  }
  if (Array.isArray(entry.hooks)) {
    return entry.hooks.some(isInsightsCommand);
  }
  return isInsightsCommand(entry);
};

/** @param {unknown} entry - Matcher group to inspect for an existing command. */
const insightsCommand = (entry) => {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    return "";
  }
  if (
    Array.isArray(entry.hooks) &&
    typeof entry.hooks[0]?.command === "string"
  ) {
    return entry.hooks[0].command;
  }
  return typeof entry.command === "string" ? entry.command : "";
};

/** @param {unknown[]} list - Existing hook groups for one event. */
const mergeEventHooks = (list) => {
  let hasInsights = false;
  let upgraded = 0;
  const next = [];
  for (const entry of list) {
    if (!isInsightsGroup(entry)) {
      next.push(entry);
      continue;
    }
    hasInsights = true;
    if (insightsCommand(entry) !== COMMAND) {
      upgraded += 1;
    }
    next.push({ hooks: [{ ...INSIGHTS_HOOK }] });
  }
  if (!hasInsights) {
    next.push({ hooks: [{ ...INSIGHTS_HOOK }] });
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

writeFileSync(settingsPath, `${JSON.stringify(existing, null, 2)}\n`);
process.stdout.write(
  `Merged ai-dev-insights into ${settingsPath} (${added} added, ${upgraded} upgraded)\n`
);
