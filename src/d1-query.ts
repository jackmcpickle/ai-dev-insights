import type { EventFilter } from "./types";

export interface EventQuery {
  binds: (string | number)[];
  limit: number;
  where: string;
}

const appendClause = (
  clauses: string[],
  binds: (string | number)[],
  sql: string,
  value: string | number
): void => {
  clauses.push(sql);
  binds.push(value);
};

const appendBranchPrClauses = (
  filter: EventFilter,
  clauses: string[],
  binds: (string | number)[]
): void => {
  const hasBranch = Boolean(filter.branch);
  const hasPr = filter.pr !== null && filter.pr !== undefined;
  if (hasBranch && hasPr) {
    clauses.push("(git_branch = ? OR pr_number = ?)");
    binds.push(filter.branch as string, filter.pr as number);
    return;
  }
  if (hasBranch) {
    appendClause(clauses, binds, "git_branch = ?", filter.branch as string);
  }
  if (hasPr) {
    appendClause(clauses, binds, "pr_number = ?", filter.pr as number);
  }
};

const appendStringFilters = (
  filter: EventFilter,
  clauses: string[],
  binds: (string | number)[]
): void => {
  if (filter.user) {
    appendClause(clauses, binds, "user_email = ?", filter.user);
  }
  if (filter.repo) {
    appendClause(clauses, binds, "repo = ?", filter.repo);
  }
  if (filter.hook) {
    appendClause(clauses, binds, "hook_event = ?", filter.hook);
  }
  if (filter.conversation_id) {
    appendClause(clauses, binds, "conversation_id = ?", filter.conversation_id);
  }
};

const appendTimeFilters = (
  filter: EventFilter,
  clauses: string[],
  binds: (string | number)[]
): void => {
  if (filter.since !== null && filter.since !== undefined) {
    appendClause(clauses, binds, "received_at >= ?", filter.since);
  }
  if (filter.until !== null && filter.until !== undefined) {
    appendClause(clauses, binds, "received_at <= ?", filter.until);
  }
  if (filter.after_id !== null && filter.after_id !== undefined) {
    appendClause(clauses, binds, "id > ?", filter.after_id);
  }
};

export const buildEventQuery = (filter: EventFilter): EventQuery => {
  const clauses: string[] = [];
  const binds: (string | number)[] = [];
  appendBranchPrClauses(filter, clauses, binds);
  appendStringFilters(filter, clauses, binds);
  appendTimeFilters(filter, clauses, binds);
  return {
    binds,
    limit: filter.limit ?? 5000,
    where: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "",
  };
};
