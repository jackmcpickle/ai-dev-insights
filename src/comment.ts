import type { UsageBucket, UsageReport } from "./types";

export const COMMENT_MARKER = "<!-- ai-dev-insights -->";

const fmt = (value: number | null | undefined): string => {
  if (value === null || value === undefined) {
    return "—";
  }
  return value.toLocaleString("en-US");
};

const bucketLines = (bucket: UsageBucket): string[] => [
  `| Prompts | ${fmt(bucket.prompt_count)} |`,
  `| Responses | ${fmt(bucket.response_count)} |`,
  `| Thoughts | ${fmt(bucket.thought_count)} |`,
  `| Turns (\`stop\`) | ${fmt(bucket.stop_count)} |`,
  `| Subagent start/stop | ${fmt(bucket.subagent_count)} |`,
  `| Compactions | ${fmt(bucket.compact_count)} |`,
  `| Input tokens (turn) | ${fmt(bucket.input_tokens)} |`,
  `| Output tokens (turn) | ${fmt(bucket.output_tokens)} |`,
  `| Cache read / write | ${fmt(bucket.cache_read_tokens)} / ${fmt(bucket.cache_write_tokens)} |`,
  `| Max context tokens | ${fmt(bucket.max_context_tokens)} |`,
  `| Turns with token fields | ${fmt(bucket.turns_with_token_fields)} |`,
  `| Turns missing token fields | ${fmt(bucket.turns_missing_token_fields)} |`,
];

export const formatPrComment = (report: UsageReport): string => {
  const titleBits = [
    report.filter.pr === null || report.filter.pr === undefined
      ? null
      : `PR #${report.filter.pr}`,
    report.filter.branch ? `\`${report.filter.branch}\`` : null,
  ].filter((bit): bit is string => bit !== null && bit !== undefined);
  const heading =
    titleBits.length > 0 ? `AI usage for ${titleBits.join(" / ")}` : "AI usage";

  return [
    COMMENT_MARKER,
    `## ${heading}`,
    "",
    "| Metric | Value |",
    "| --- | ---: |",
    ...bucketLines(report.totals),
    "",
    report.note,
    "",
    `_Events: ${report.totals.event_count.toLocaleString("en-US")}_`,
  ].join("\n");
};
