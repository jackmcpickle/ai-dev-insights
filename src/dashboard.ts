import type { UsageBucket, UsageReport } from "./types";

function escapeHtml(value: string): string {
    return value
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;");
}

function cell(value: string | number | null | undefined): string {
    if (value == null || value === "") return "<td>—</td>";
    return `<td>${escapeHtml(String(value))}</td>`;
}

function rows(buckets: UsageBucket[], kind: "pr" | "branch" | "user"): string {
    if (buckets.length === 0) {
        return `<tr><td colspan="10">No events yet.</td></tr>`;
    }
    return buckets
        .map((bucket) => {
            const label =
                kind === "user"
                    ? bucket.user_email
                    : kind === "pr"
                      ? bucket.pr_number != null
                          ? `#${bucket.pr_number}`
                          : bucket.git_branch
                      : bucket.git_branch;
            return `<tr>
                ${cell(label)}
                ${cell(bucket.repo)}
                ${cell(bucket.event_count)}
                ${cell(bucket.prompt_count)}
                ${cell(bucket.stop_count)}
                ${cell(bucket.input_tokens)}
                ${cell(bucket.output_tokens)}
                ${cell(
                    bucket.cache_read_tokens == null &&
                        bucket.cache_write_tokens == null
                        ? null
                        : `${bucket.cache_read_tokens ?? 0} / ${bucket.cache_write_tokens ?? 0}`,
                )}
                ${cell(bucket.max_context_tokens)}
                ${cell(bucket.turns_missing_token_fields)}
            </tr>`;
        })
        .join("");
}

function table(title: string, buckets: UsageBucket[], kind: "pr" | "branch" | "user"): string {
    const first =
        kind === "user" ? "User" : kind === "pr" ? "PR" : "Branch";
    return `
        <section>
            <h2>${escapeHtml(title)}</h2>
            <table>
                <thead>
                    <tr>
                        <th>${first}</th>
                        <th>Repo</th>
                        <th>Events</th>
                        <th>Prompts</th>
                        <th>Turns</th>
                        <th>Input</th>
                        <th>Output</th>
                        <th>Cache r/w</th>
                        <th>Max context</th>
                        <th>Turns w/o tokens</th>
                    </tr>
                </thead>
                <tbody>${rows(buckets, kind)}</tbody>
            </table>
        </section>`;
}

export function renderDashboard(report: UsageReport): string {
    return `<!doctype html>
<html lang="en">
<head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>AI dev insights</title>
    <style>
        :root { color-scheme: dark; }
        body {
            margin: 0 auto;
            max-width: 1100px;
            padding: 2rem 1.25rem 4rem;
            font: 15px/1.45 ui-sans-serif, system-ui, sans-serif;
            background: #121418;
            color: #e8e6e1;
        }
        h1 { font-size: 1.4rem; font-weight: 600; margin: 0 0 0.4rem; }
        h2 { font-size: 1rem; margin: 2rem 0 0.6rem; color: #c8c4bb; }
        p { color: #a8a49c; }
        table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
        th, td { text-align: left; padding: 0.4rem 0.5rem; border-bottom: 1px solid #2a2d33; }
        th { color: #8d897f; font-weight: 500; font-size: 0.8rem; }
        td { font-size: 0.9rem; }
        code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
        .note { font-size: 0.85rem; max-width: 70ch; }
    </style>
</head>
<body>
    <h1>AI dev insights</h1>
    <p>${report.totals.event_count.toLocaleString("en-US")} events stored.</p>
    ${table("By pull request", report.by_pr, "pr")}
    ${table("By branch", report.by_branch, "branch")}
    ${table("By user", report.by_user, "user")}
    <p class="note">${escapeHtml(report.note)}</p>
</body>
</html>`;
}
