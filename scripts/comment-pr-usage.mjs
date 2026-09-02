#!/usr/bin/env node
/**
 * Fetch /v1/usage/comment for the current PR branch and upsert a review comment.
 * Used by .github/workflows/pr-usage.yml. No-ops when secrets are missing.
 */
const MARKER = "<!-- ai-dev-insights -->";

const requiredEnv = function requiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    console.log(`skip: ${name} is not set`);
    process.exit(0);
  }
  return value;
};

const main = async function main() {
  const ingestUrl = process.env.AI_DEV_INSIGHTS_URL || process.env.INGEST_URL;
  const token = process.env.AI_DEV_INSIGHTS_TOKEN || process.env.INGEST_TOKEN;
  if (!ingestUrl || !token) {
    console.log("skip: AI_DEV_INSIGHTS_URL / AI_DEV_INSIGHTS_TOKEN not set");
    process.exit(0);
  }

  const repo = requiredEnv("GITHUB_REPOSITORY");
  const apiUrl = process.env.GITHUB_API_URL || "https://api.github.com";
  const ghToken = requiredEnv("GITHUB_TOKEN");
  const branch = process.env.PR_HEAD_REF || process.env.GITHUB_HEAD_REF || "";
  const pr = Number(process.env.PR_NUMBER || "");
  if (!branch || !Number.isFinite(pr) || pr <= 0) {
    console.log("skip: missing PR_HEAD_REF or PR_NUMBER");
    process.exit(0);
  }

  const query = new URL(`${ingestUrl.replace(/\/$/u, "")}/v1/usage/comment`);
  query.searchParams.set("branch", branch);
  query.searchParams.set("pr", String(pr));
  query.searchParams.set("repo", repo);

  const usageRes = await fetch(query, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!usageRes.ok) {
    throw new Error(`usage API ${usageRes.status}: ${await usageRes.text()}`);
  }
  /** @type {{ markdown: string }} */
  const payload = await usageRes.json();
  const body = payload.markdown;
  if (typeof body !== "string" || !body.includes(MARKER)) {
    throw new Error("usage API did not return a marked comment");
  }

  const [owner, name] = repo.split("/");
  const commentsRes = await fetch(
    `${apiUrl}/repos/${owner}/${name}/issues/${pr}/comments?per_page=100`,
    {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${ghToken}`,
      },
    }
  );
  if (!commentsRes.ok) {
    throw new Error(`github comments ${commentsRes.status}`);
  }
  /** @type {{ id: number, body: string }[]} */
  const comments = await commentsRes.json();
  const existing = comments.find((comment) => comment.body.includes(MARKER));
  const endpoint = existing
    ? `${apiUrl}/repos/${owner}/${name}/issues/comments/${existing.id}`
    : `${apiUrl}/repos/${owner}/${name}/issues/${pr}/comments`;
  const method = existing ? "PATCH" : "POST";
  const writeRes = await fetch(endpoint, {
    body: JSON.stringify({ body }),
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${ghToken}`,
      "content-type": "application/json",
    },
    method,
  });
  if (!writeRes.ok) {
    throw new Error(
      `github write ${writeRes.status}: ${await writeRes.text()}`
    );
  }
  console.log(existing ? `updated comment ${existing.id}` : "created comment");
};

try {
  await main();
} catch (error) {
  console.error(error);
  process.exit(1);
}
