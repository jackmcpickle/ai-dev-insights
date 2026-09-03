import type {
  CorpusDigest,
  InsightsFinding,
  InsightsReport,
  UsageBucket,
  UsageReport,
} from "./types";

const escapeHtml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

const cell = (value: string | number | null | undefined): string => {
  if (value === null || value === undefined || value === "") {
    return "<td>—</td>";
  }
  return `<td>${escapeHtml(String(value))}</td>`;
};

const bucketLabel = (
  bucket: UsageBucket,
  kind: "pr" | "branch" | "user"
): string | null | undefined => {
  if (kind === "user") {
    return bucket.user_email;
  }
  if (kind === "pr") {
    if (bucket.pr_number === null || bucket.pr_number === undefined) {
      return bucket.git_branch;
    }
    return `#${bucket.pr_number}`;
  }
  return bucket.git_branch;
};

const cacheCell = (bucket: UsageBucket): string | null => {
  if (
    (bucket.cache_read_tokens === null ||
      bucket.cache_read_tokens === undefined) &&
    (bucket.cache_write_tokens === null ||
      bucket.cache_write_tokens === undefined)
  ) {
    return null;
  }
  return `${bucket.cache_read_tokens ?? 0} / ${bucket.cache_write_tokens ?? 0}`;
};

const rows = (
  buckets: UsageBucket[],
  kind: "pr" | "branch" | "user"
): string => {
  if (buckets.length === 0) {
    return `<tr><td colspan="10">No events yet.</td></tr>`;
  }
  return buckets
    .map((bucket) => {
      const label = bucketLabel(bucket, kind);
      return `<tr>
                ${cell(label)}
                ${cell(bucket.repo)}
                ${cell(bucket.event_count)}
                ${cell(bucket.prompt_count)}
                ${cell(bucket.stop_count)}
                ${cell(bucket.input_tokens)}
                ${cell(bucket.output_tokens)}
                ${cell(cacheCell(bucket))}
                ${cell(bucket.max_context_tokens)}
                ${cell(bucket.turns_missing_token_fields)}
            </tr>`;
    })
    .join("");
};

const tableHeader = (kind: "pr" | "branch" | "user"): string => {
  if (kind === "user") {
    return "User";
  }
  if (kind === "pr") {
    return "PR";
  }
  return "Branch";
};

const table = (
  title: string,
  buckets: UsageBucket[],
  kind: "pr" | "branch" | "user"
): string => {
  const first = tableHeader(kind);
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
};

export const renderDashboard = (report: UsageReport): string =>
  `<!doctype html>
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
        nav { margin: 0 0 1.5rem; font-size: 0.9rem; }
        nav a { color: #9db4ff; text-decoration: none; margin-right: 1rem; }
        nav a:hover { text-decoration: underline; }
        table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
        th, td { text-align: left; padding: 0.4rem 0.5rem; border-bottom: 1px solid #2a2d33; }
        th { color: #8d897f; font-weight: 500; font-size: 0.8rem; }
        td { font-size: 0.9rem; }
        code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
        .note { font-size: 0.85rem; max-width: 70ch; }
        .finding { border: 1px solid #2a2d33; border-radius: 8px; padding: 0.75rem 1rem; margin: 0.6rem 0; }
        .finding h3 { margin: 0 0 0.35rem; font-size: 0.95rem; font-weight: 600; }
        .finding p { margin: 0; font-size: 0.88rem; }
        .meta { color: #8d897f; font-size: 0.8rem; margin-top: 0.35rem; }
    </style>
</head>
<body>
    <h1>AI dev insights</h1>
    <nav>
        <a href="/">Usage</a>
        <a href="/insights">Insights report</a>
    </nav>
    <p>${report.totals.event_count.toLocaleString("en-US")} events stored.</p>
    ${table("By pull request", report.by_pr, "pr")}
    ${table("By branch", report.by_branch, "branch")}
    ${table("By user", report.by_user, "user")}
    <p class="note">${escapeHtml(report.note)}</p>
</body>
</html>`;

const findingBlock = (finding: InsightsFinding): string => `
        <article class="finding">
            <h3>${escapeHtml(finding.title)}</h3>
            <p>${escapeHtml(finding.reason)}</p>
            <p class="meta">Evidence event ids: ${finding.evidence_ids.length > 0 ? finding.evidence_ids.join(", ") : "none"}</p>
        </article>`;

const findingSection = (title: string, findings: InsightsFinding[]): string => {
  if (findings.length === 0) {
    return `<section><h2>${escapeHtml(title)}</h2><p>Nothing flagged yet.</p></section>`;
  }
  return `<section><h2>${escapeHtml(title)}</h2>${findings.map(findingBlock).join("")}</section>`;
};

export const renderInsightsPage = (
  digest: CorpusDigest,
  insights: InsightsReport
): string =>
  `<!doctype html>
<html lang="en">
<head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>AI dev insights — report</title>
    <style>
        :root { color-scheme: dark; }
        body {
            margin: 0 auto;
            max-width: 900px;
            padding: 2rem 1.25rem 4rem;
            font: 15px/1.45 ui-sans-serif, system-ui, sans-serif;
            background: #121418;
            color: #e8e6e1;
        }
        h1 { font-size: 1.4rem; font-weight: 600; margin: 0 0 0.4rem; }
        h2 { font-size: 1rem; margin: 2rem 0 0.6rem; color: #c8c4bb; }
        p { color: #a8a49c; }
        nav { margin: 0 0 1.5rem; font-size: 0.9rem; }
        nav a { color: #9db4ff; text-decoration: none; margin-right: 1rem; }
        nav a:hover { text-decoration: underline; }
        .finding { border: 1px solid #2a2d33; border-radius: 8px; padding: 0.75rem 1rem; margin: 0.6rem 0; }
        .finding h3 { margin: 0 0 0.35rem; font-size: 0.95rem; font-weight: 600; }
        .finding p { margin: 0; font-size: 0.88rem; }
        .meta { color: #8d897f; font-size: 0.8rem; margin-top: 0.35rem; }
        .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 0.75rem; margin: 1rem 0 1.5rem; }
        .stat { background: #1a1d22; border: 1px solid #2a2d33; border-radius: 8px; padding: 0.75rem; }
        .stat strong { display: block; font-size: 1.2rem; color: #f0ede6; }
        .stat span { font-size: 0.8rem; color: #8d897f; }
        .note { font-size: 0.85rem; max-width: 70ch; }
    </style>
</head>
<body>
    <h1>Insights report</h1>
    <nav>
        <a href="/">Usage</a>
        <a href="/insights">Insights report</a>
    </nav>
    <p>Deterministic first pass over captured hook traffic. Run <code>/agent-insights</code> in Cursor for deeper skill and code proposals.</p>
    <div class="stats">
        <div class="stat"><strong>${digest.event_count.toLocaleString("en-US")}</strong><span>events</span></div>
        <div class="stat"><strong>${digest.conversation_count.toLocaleString("en-US")}</strong><span>conversations</span></div>
        <div class="stat"><strong>${digest.failures.length.toLocaleString("en-US")}</strong><span>failed runs</span></div>
        <div class="stat"><strong>${digest.recipes.length.toLocaleString("en-US")}</strong><span>repeated recipes</span></div>
    </div>
    ${findingSection("Proposed skill changes", insights.proposed_skills)}
    ${findingSection("Code hotspots", insights.hotspots)}
    ${findingSection("Do not change", insights.do_not_change)}
    <p class="note">${escapeHtml(digest.note)}</p>
</body>
</html>`;
