#!/usr/bin/env node
/**
 * Merge ai-dev-insights observe hooks into ~/.claude/settings.json without
 * clobbering existing entries. Upgrades old project-local ingest paths.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const wrapperPath = path.join(homedir(), ".claude/hooks/run-ai-dev-insights.sh");
const COMMAND = `bash "${wrapperPath}"`;
const INSIGHTS_HOOK = { type: "command", command: COMMAND, timeout: 8 };
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

/** @param {unknown} hook */
const isInsightsCommand = (hook) =>
  typeof hook === "object" &&
  hook !== null &&
  !Array.isArray(hook) &&
  typeof hook.command === "string" &&
  (hook.command.includes("ingest.mjs") ||
    hook.command.includes("ai-dev-insights"));

/** @param {unknown} entry */
const isInsightsGroup = (entry) => {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    return false;
  }
  if (Array.isArray(entry.hooks)) {
    return entry.hooks.some(isInsightsCommand);
  }
  return isInsightsCommand(entry);
};

/** @param {unknown} entry */
const toInsightsGroup = (entry) => {
  if (isInsightsGroup(entry)) {
    return { hooks: [{ ...INSIGHTS_HOOK }] };
  }
  return entry;
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
    if (!isInsightsGroup(entry)) {
      return entry;
    }
    hasInsights = true;
    const command =
      typeof entry === "object" &&
      entry !== null &&
      !Array.isArray(entry) &&
      Array.isArray(entry.hooks) &&
      typeof entry.hooks[0]?.command === "string"
        ? entry.hooks[0].command
        : typeof entry.command === "string"
          ? entry.command
          : "";
    if (command !== COMMAND) {
      upgraded += 1;
    }
    return { hooks: [{ ...INSIGHTS_HOOK }] };
  });

  if (!hasInsights) {
    next.push({ hooks: [{ ...INSIGHTS_HOOK }] });
    added += 1;
  }
  existing.hooks[event] = next;
}

writeFileSync(settingsPath, `${JSON.stringify(existing, null, 2)}\n`);
process.stdout.write(
  `Merged ai-dev-insights into ${settingsPath} (${added} added, ${upgraded} upgraded)\n`
);
