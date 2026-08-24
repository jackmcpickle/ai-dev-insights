import { extractSkillMentions, looksLikeCorrection, promptPrefix } from "./mentions";
import type {
    ConversationDigest,
    CorpusDigest,
    EventFilter,
    StoredEvent,
} from "./types";
import { USAGE_GAP_NOTE, selectTurnUsage, summarizeEvents } from "./usage";

function conversationKey(event: StoredEvent): string {
    return event.conversation_id ?? `loose:${event.id}`;
}

function addModel(models: string[], model: string | null): void {
    if (model && !models.includes(model)) models.push(model);
}

function addSkill(skills: string[], names: string[]): void {
    for (const name of names) {
        if (!skills.includes(name)) skills.push(name);
    }
}

function addTokens(
    current: number | null,
    next: number | undefined,
): number | null {
    if (next == null) return current;
    return (current ?? 0) + next;
}

export function buildConversations(events: StoredEvent[]): ConversationDigest[] {
    const groups = new Map<string, StoredEvent[]>();
    for (const event of events) {
        const key = conversationKey(event);
        const list = groups.get(key) ?? [];
        list.push(event);
        groups.set(key, list);
    }

    const out: ConversationDigest[] = [];
    for (const [id, group] of groups) {
        const digest: ConversationDigest = {
            conversation_id: id.startsWith("loose:") ? id : id,
            prompt_count: 0,
            stop_count: 0,
            error_count: 0,
            models: [],
            skills: [],
            git_branch: group[0]?.git_branch ?? null,
            pr_number: group[0]?.pr_number ?? null,
            repo: group[0]?.repo ?? null,
            last_status: null,
            input_tokens: null,
            output_tokens: null,
        };
        for (const event of group) {
            if (event.hook_event === "beforeSubmitPrompt") digest.prompt_count += 1;
            if (event.hook_event === "stop") {
                digest.stop_count += 1;
                digest.last_status = event.status;
            }
            if (
                (event.hook_event === "stop" ||
                    event.hook_event === "subagentStop") &&
                (event.status === "error" || event.status === "aborted")
            ) {
                digest.error_count += 1;
            }
            addModel(digest.models, event.model);
            addSkill(digest.skills, extractSkillMentions(event.text));
        }
        for (const turn of selectTurnUsage(group)) {
            digest.input_tokens = addTokens(
                digest.input_tokens,
                turn.usage.input_tokens,
            );
            digest.output_tokens = addTokens(
                digest.output_tokens,
                turn.usage.output_tokens,
            );
        }
        out.push(digest);
    }
    return out.sort((a, b) => b.prompt_count - a.prompt_count);
}

function skillStats(events: StoredEvent[]): CorpusDigest["skills"] {
    const byName = new Map<
        string,
        { mentions: number; conversations: Set<string> }
    >();
    for (const event of events) {
        const names = extractSkillMentions(event.text);
        for (const name of names) {
            const row = byName.get(name) ?? {
                mentions: 0,
                conversations: new Set<string>(),
            };
            row.mentions += 1;
            row.conversations.add(conversationKey(event));
            byName.set(name, row);
        }
    }
    return [...byName.entries()]
        .map(([name, row]) => ({
            name,
            mentions: row.mentions,
            conversations: row.conversations.size,
        }))
        .sort((a, b) => b.mentions - a.mentions);
}

function recipes(events: StoredEvent[]): CorpusDigest["recipes"] {
    const counts = new Map<string, number>();
    for (const event of events) {
        if (event.hook_event !== "beforeSubmitPrompt" || !event.text) continue;
        const prefix = promptPrefix(event.text);
        if (prefix.length < 16) continue;
        counts.set(prefix, (counts.get(prefix) ?? 0) + 1);
    }
    return [...counts.entries()]
        .filter(([, count]) => count >= 2)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 20)
        .map(([prefix, count]) => ({ prefix, count }));
}

export function buildDigest(
    events: StoredEvent[],
    filter: EventFilter = {},
): CorpusDigest {
    const conversations = buildConversations(events);
    const usage = summarizeEvents(events, filter);
    return {
        filter,
        event_count: events.length,
        conversation_count: conversations.length,
        usage,
        skills: skillStats(events),
        retries: conversations.filter(
            (row) => row.stop_count > 1 || row.error_count > 0,
        ),
        failures: conversations.filter((row) => row.error_count > 0),
        high_token_prs: usage.by_pr
            .filter((row) => (row.input_tokens ?? 0) > 0)
            .sort((a, b) => (b.input_tokens ?? 0) - (a.input_tokens ?? 0))
            .slice(0, 10),
        corrections: events
            .filter(
                (event) =>
                    event.hook_event === "beforeSubmitPrompt" &&
                    looksLikeCorrection(event.text),
            )
            .map((event) => ({
                conversation_id: event.conversation_id,
                event_id: event.id,
                text: event.text ?? "",
                skill_mentions: extractSkillMentions(event.text),
            })),
        recipes: recipes(events),
        conversations: conversations.slice(0, 50),
        note: USAGE_GAP_NOTE,
    };
}
