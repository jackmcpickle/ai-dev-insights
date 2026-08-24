import { extractSkillMentions, looksLikeCorrection } from "./mentions";
import { buildDigest } from "./digest";
import type { InsightsFinding, InsightsReport, StoredEvent } from "./types";

function conversationEvents(
    events: StoredEvent[],
    conversationId: string | null,
): StoredEvent[] {
    return events.filter((event) => event.conversation_id === conversationId);
}

function missingSkillTriggers(events: StoredEvent[]): InsightsFinding[] {
    const findings: InsightsFinding[] = [];
    const byConv = new Map<string, StoredEvent[]>();
    for (const event of events) {
        if (!event.conversation_id) continue;
        const list = byConv.get(event.conversation_id) ?? [];
        list.push(event);
        byConv.set(event.conversation_id, list);
    }

    for (const [id, group] of byConv) {
        const prompts = group
            .filter((event) => event.hook_event === "beforeSubmitPrompt")
            .sort((a, b) => a.id - b.id);
        if (prompts.length < 2) continue;
        for (let i = 1; i < prompts.length; i += 1) {
            const later = prompts[i];
            if (!looksLikeCorrection(later.text)) continue;
            const mentioned = extractSkillMentions(later.text);
            if (mentioned.length === 0) continue;
            const earlierText = prompts
                .slice(0, i)
                .map((event) => event.text ?? "")
                .join("\n");
            const earlierSkills = new Set(extractSkillMentions(earlierText));
            const missing = mentioned.filter((name) => !earlierSkills.has(name));
            if (missing.length === 0) continue;
            findings.push({
                title: `Tune or add ${missing.join(", ")}`,
                reason: `Conversation ${id} corrected the agent toward ${missing.join(", ")} after the first prompt did not mention that skill.`,
                evidence_ids: [prompts[0].id, later.id],
            });
        }
    }
    return findings;
}

export function runInsightsPass(events: StoredEvent[]): InsightsReport {
    const digest = buildDigest(events);
    const proposed_skills: InsightsFinding[] = [...missingSkillTriggers(events)];

    for (const recipe of digest.recipes) {
        proposed_skills.push({
            title: "Capture a repeated recipe",
            reason: `Prompt prefix "${recipe.prefix}" appeared ${recipe.count} times. If this is a team workflow, put it in an existing skill instead of pasting it.`,
            evidence_ids: events
                .filter(
                    (event) =>
                        event.hook_event === "beforeSubmitPrompt" &&
                        (event.text ?? "")
                            .toLowerCase()
                            .replace(/\s+/gu, " ")
                            .includes(recipe.prefix),
                )
                .map((event) => event.id)
                .slice(0, 8),
        });
    }

    const hotspots: InsightsFinding[] = [];
    for (const pr of digest.high_token_prs.slice(0, 5)) {
        const label =
            pr.pr_number != null
                ? `PR #${pr.pr_number}`
                : (pr.git_branch ?? "unknown branch");
        hotspots.push({
            title: `${label} burned context`,
            reason: `${label} has ${pr.input_tokens ?? 0} turn input tokens across ${pr.stop_count} stop events. Look at the files that conversation touched before changing skills.`,
            evidence_ids: events
                .filter(
                    (event) =>
                        (pr.pr_number != null &&
                            event.pr_number === pr.pr_number) ||
                        (pr.git_branch != null &&
                            event.git_branch === pr.git_branch),
                )
                .map((event) => event.id)
                .slice(0, 8),
        });
    }

    for (const failure of digest.failures) {
        const failed = conversationEvents(events, failure.conversation_id).filter(
            (event) =>
                (event.hook_event === "stop" ||
                    event.hook_event === "subagentStop") &&
                (event.status === "error" || event.status === "aborted"),
        );
        hotspots.push({
            title: `Failed run in ${failure.conversation_id}`,
            reason: `${failure.error_count} error/aborted stops. Inspect the code path in that conversation before writing a new skill.`,
            evidence_ids: failed.map((event) => event.id),
        });
    }

    const do_not_change: InsightsFinding[] = [
        {
            title: "Do not invent billed tokens",
            reason: "Hooks omit usage on many events. Treat missing token fields as unknown, not zero, and do not treat context_tokens as spend.",
            evidence_ids: [],
        },
        {
            title: "Do not auto-apply skill edits",
            reason: "Same as reflect: propose edits, wait for a human. Skill text changes every future agent.",
            evidence_ids: [],
        },
        {
            title: "Leave fail-open hooks alone",
            reason: "Observe hooks must keep printing {} and exiting 0. Do not add failClosed or block the agent from this pass.",
            evidence_ids: [],
        },
    ];

    for (const row of digest.conversations) {
        if (
            row.prompt_count <= 1 &&
            row.error_count === 0 &&
            row.stop_count <= 1 &&
            digest.corrections.every(
                (item) => item.conversation_id !== row.conversation_id,
            )
        ) {
            do_not_change.push({
                title: `One-off ${row.conversation_id}`,
                reason: "Single completed turn with no correction. Not a team pattern.",
                evidence_ids: events
                    .filter((event) => event.conversation_id === row.conversation_id)
                    .map((event) => event.id)
                    .slice(0, 4),
            });
        }
    }

    return { proposed_skills, hotspots, do_not_change };
}
