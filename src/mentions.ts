const SKILL_PATH =
    /(?:^|[^\w./])(?:\.cursor\/)?skills\/([a-z][a-z0-9-]{1,62})\/SKILL\.md\b/giu;
const SKILL_FILE = /(?:^|[^\w./])([a-z][a-z0-9-]{1,62})\/SKILL\.md\b/giu;
const SLASH_SKILL = /(?:^|[\s`'"(])\/skill(?:s)?(?:\s+|\/)([a-z][a-z0-9-]{1,62})\b/giu;
const AT_SKILL = /(?:^|[\s`'"(])@skill(?:s)?(?:\s+|\/|:)([a-z][a-z0-9-]{1,62})\b/giu;
const SLASH_COMMAND = /(?:^|[\s`'"(])\/([a-z][a-z0-9-]{1,62})\b/gu;
const USE_SKILL =
    /\b(?:use|run|read|invoke|load|open)\s+(?:the\s+)?([a-z][a-z0-9-]{1,62})\s+skill\b/giu;

const IGNORE_SLASH = new Set([
    "v1",
    "api",
    "health",
    "usage",
    "ingest",
    "events",
    "digest",
    "tmp",
    "usr",
    "bin",
    "etc",
    "home",
    "workspace",
]);

function collect(text: string, pattern: RegExp, into: Set<string>): void {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null = pattern.exec(text);
    while (match) {
        const name = match[1]?.toLowerCase();
        if (name) into.add(name);
        match = pattern.exec(text);
    }
}

export function extractSkillMentions(text: string | null | undefined): string[] {
    if (!text) return [];
    const found = new Set<string>();
    collect(text, SKILL_PATH, found);
    collect(text, SKILL_FILE, found);
    collect(text, SLASH_SKILL, found);
    collect(text, AT_SKILL, found);
    collect(text, USE_SKILL, found);

    SLASH_COMMAND.lastIndex = 0;
    let match: RegExpExecArray | null = SLASH_COMMAND.exec(text);
    while (match) {
        const name = match[1]?.toLowerCase();
        if (
            name &&
            !IGNORE_SLASH.has(name) &&
            (name.includes("skill") ||
                name.includes("insight") ||
                /\bskill\b/iu.test(text))
        ) {
            found.add(name);
        }
        match = SLASH_COMMAND.exec(text);
    }

    found.delete("skill");
    found.delete("skills");
    return [...found].sort();
}

const CORRECTION =
    /\b(no,?\s+(don'?t|do not|wrong|stop)|that'?s wrong|i said|i told you|instead\b|actually\b|use .+ not |don'?t (use|do)|try again|you (ignored|missed|used the wrong)|wrong skill|use the .+ skill)\b/iu;

export function looksLikeCorrection(text: string | null | undefined): boolean {
    if (!text) return false;
    return CORRECTION.test(text);
}

export function promptPrefix(text: string, length = 80): string {
    return text.toLowerCase().replace(/\s+/gu, " ").trim().slice(0, length);
}
