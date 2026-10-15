import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SessionEvidence } from '../../../packages/core/src';

/**
 * The Prospector's GitHub source: a reviewer's PR reviews, inline review comments and PR comments,
 * read through `gh api graphql` (the caller's own gh login; read-only, never writes to GitHub).
 */

/** One thing the reviewer wrote on a PR. */
export interface ReviewItem {
  /** Stable id: GitHub node id. */
  readonly id: string;
  /** `review` (a submitted review's body), `inline` (a review comment on a diff line), `comment` (PR conversation). */
  readonly kind: 'review' | 'inline' | 'comment';
  /** The review's state for `review` and `inline` items (CHANGES_REQUESTED, COMMENTED, APPROVED). */
  readonly state?: string;
  readonly body: string;
  readonly at: string;
  readonly url: string;
  /** The review this item belongs to (inline items share it with their review). */
  readonly reviewId?: string;
  readonly path?: string;
  readonly line?: number;
  readonly diffHunk?: string;
  /** The comment this one replies to, when it is a reply in a review thread. */
  readonly replyTo?: string;
}

export interface ReviewedPr {
  readonly repo: string;
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly author: string;
  readonly createdAt: string;
  readonly mergedAt?: string;
  readonly url: string;
  readonly items: readonly ReviewItem[];
  /** Other authors' comments in the same threads, for context (author, body, at). */
  readonly thread: readonly {
    readonly id: string;
    readonly author: string;
    readonly body: string;
    readonly at: string;
    readonly replyTo?: string;
  }[];
}

type Json = Record<string, unknown>;

async function gh(query: string, variables: Record<string, string | number | null>): Promise<Json> {
  const args = ['api', 'graphql', '-f', `query=${query}`];
  for (const [k, v] of Object.entries(variables))
    if (v !== null) args.push(typeof v === 'number' ? '-F' : '-f', `${k}=${v}`);
  for (let attempt = 0; ; attempt++) {
    const proc = Bun.spawn(['gh', ...args], { stdout: 'pipe', stderr: 'pipe' });
    const [out, err] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    if ((await proc.exited) === 0) return JSON.parse(out) as Json;
    if (attempt >= 4) throw Error(`gh api graphql failed: ${err.slice(0, 300)}`);
    await Bun.sleep(2000 * (attempt + 1));
  }
}

const PR_FIELDS = `
  number title body createdAt mergedAt url author { login }
  reviews(first: 100) { nodes { id state body submittedAt url author { login }
    comments(first: 100) { nodes { id body createdAt url path line originalLine diffHunk replyTo { id } author { login } } } } }
  comments(first: 100) { nodes { id body createdAt url author { login } } }
  reviewThreads(first: 100) { nodes { comments(first: 50) { nodes { id body createdAt replyTo { id } author { login } } } } }`;

const SEARCH = `query($q: String!, $after: String) { search(query: $q, type: ISSUE, first: 20, after: $after) {
  pageInfo { hasNextPage endCursor } nodes { ... on PullRequest { ${PR_FIELDS} } } } }`;

const LIST = `query($owner: String!, $name: String!, $after: String) { repository(owner: $owner, name: $name) {
  pullRequests(first: 20, after: $after, orderBy: { field: CREATED_AT, direction: ASC }) {
  pageInfo { hasNextPage endCursor } nodes { ${PR_FIELDS} } } } }`;

const nodes = (v: unknown): Json[] =>
  ((v as { nodes?: Json[] } | null)?.nodes ?? []).filter(Boolean);
const login = (v: unknown) => String((v as { login?: string } | null)?.login ?? 'ghost');

function toPr(repo: string, pr: Json, reviewer: string): ReviewedPr {
  const items: ReviewItem[] = [];
  for (const r of nodes(pr.reviews)) {
    if (login(r.author) !== reviewer) continue;
    const state = String(r.state);
    if (String(r.body ?? '').trim())
      items.push({
        id: String(r.id),
        kind: 'review',
        state,
        body: String(r.body),
        at: String(r.submittedAt),
        url: String(r.url),
      });
    for (const c of nodes(r.comments))
      if (login(c.author) === reviewer && String(c.body ?? '').trim())
        items.push({
          id: String(c.id),
          kind: 'inline',
          state,
          body: String(c.body),
          at: String(c.createdAt),
          url: String(c.url),
          reviewId: String(r.id),
          ...(c.path ? { path: String(c.path) } : {}),
          ...(typeof (c.line ?? c.originalLine) === 'number'
            ? { line: Number(c.line ?? c.originalLine) }
            : {}),
          ...(c.diffHunk ? { diffHunk: String(c.diffHunk) } : {}),
          ...((c.replyTo as Json | null)?.id ? { replyTo: String((c.replyTo as Json).id) } : {}),
        });
  }
  for (const c of nodes(pr.comments))
    if (login(c.author) === reviewer && String(c.body ?? '').trim())
      items.push({
        id: String(c.id),
        kind: 'comment',
        body: String(c.body),
        at: String(c.createdAt),
        url: String(c.url),
      });
  const thread = nodes(pr.reviewThreads).flatMap((t) =>
    nodes(t.comments)
      .filter((c) => login(c.author) !== reviewer)
      .map((c) => ({
        id: String(c.id),
        author: login(c.author),
        body: String(c.body ?? ''),
        at: String(c.createdAt),
        ...((c.replyTo as Json | null)?.id ? { replyTo: String((c.replyTo as Json).id) } : {}),
      })),
  );
  return {
    repo,
    number: Number(pr.number),
    title: String(pr.title ?? ''),
    body: String(pr.body ?? ''),
    author: login(pr.author),
    createdAt: String(pr.createdAt),
    ...(pr.mergedAt ? { mergedAt: String(pr.mergedAt) } : {}),
    url: String(pr.url),
    items: items.sort((a, b) => a.at.localeCompare(b.at)),
    thread,
  };
}

/**
 * Every PR in `repo` the reviewer wrote on. `all` lists the repo's PRs (repos where the reviewer
 * also authors, so review search misses self-reviews); otherwise search finds reviewed/commented PRs.
 */
export async function fetchReviewedPrs(
  repo: string,
  reviewer: string,
  opts: { all?: boolean; progress?: (line: string) => void } = {},
): Promise<ReviewedPr[]> {
  const [owner, name] = repo.split('/') as [string, string];
  const seen = new Map<number, ReviewedPr>();
  const queries = opts.all
    ? [null]
    : [`repo:${repo} is:pr reviewed-by:${reviewer}`, `repo:${repo} is:pr commenter:${reviewer}`];
  for (const q of queries) {
    let after: string | null = null;
    for (;;) {
      const data = q
        ? ((await gh(SEARCH, { q, after })).data as Json).search
        : (((await gh(LIST, { owner, name, after })).data as Json).repository as Json).pullRequests;
      const page = data as { pageInfo: { hasNextPage: boolean; endCursor: string }; nodes: Json[] };
      for (const pr of page.nodes.filter((n) => n && 'number' in n)) {
        const parsed = toPr(repo, pr, reviewer);
        if (parsed.items.length) seen.set(parsed.number, parsed);
      }
      opts.progress?.(`${repo}: ${seen.size} PRs`);
      if (!page.pageInfo.hasNextPage) break;
      after = page.pageInfo.endCursor;
    }
  }
  return [...seen.values()].sort((a, b) => a.number - b.number);
}

function* jsonlFiles(roots: readonly string[]): Generator<string> {
  for (const root of roots) {
    let entries: string[];
    try {
      entries = readdirSync(root, { recursive: true }) as string[];
    } catch {
      continue;
    }
    for (const entry of entries) if (entry.endsWith('.jsonl')) yield join(root, entry);
  }
}

/** Commands and files through which an agent posts review text to GitHub. */
const POSTING =
  /gh (?:pr (?:comment|review)|api)|--body|body-file|addPullRequestReview|\/comments|\/reviews|"name":"Write"[^\n]*(?:comment|review|reply|body)/i;

/**
 * Find the session that wrote each comment: its snippet inside a tool call that posts to GitHub (an
 * agent posted it), inside another tool call (an agent drafted it, e.g. a body file), or inside a
 * message the person typed (they dictated it). Text an agent only read back (tool results) is not
 * evidence.
 */
export async function sessionEvidence(
  items: readonly { id: string; body: string }[],
  roots: readonly string[],
  snippetOf: (text: string) => string | undefined,
): Promise<Map<string, SessionEvidence>> {
  const snippets = new Map<string, string[]>();
  for (const item of items) {
    const snippet = snippetOf(item.body);
    if (snippet) snippets.set(snippet, [...(snippets.get(snippet) ?? []), item.id]);
  }
  const evidence = new Map<string, SessionEvidence>();
  if (!snippets.size) return evidence;
  for (const file of jsonlFiles(roots)) {
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n')) {
      const toolCall =
        /"type":"tool_use"|"type":"function_call"|"type":"custom_tool_call"/.test(line) &&
        !/"type":"tool_result"|function_call_output/.test(line);
      const typed =
        !toolCall &&
        /"type":"user"|"role":"user"/.test(line) &&
        !/"tool_result"|"toolUseResult"|function_call_output|"isMeta":true/.test(line);
      if (!toolCall && !typed) continue;
      const kind = typed ? 'typed' : POSTING.test(line) ? 'posted' : 'drafted';
      for (const [snippet, ids] of snippets) {
        if (!line.includes(snippet)) continue;
        for (const id of ids) evidence.set(id, { ...evidence.get(id), [kind]: true });
      }
    }
  }
  return evidence;
}
