/**
 * @atlas
 * @kind client
 * @partOf feature:evals
 */
/**
 * The Prospector's Linear source: the API key's user's own comments, the issues and projects they
 * wrote, read through Linear's GraphQL API (read-only). The key is read from an env file and never
 * printed.
 */
import { existsSync, readFileSync } from 'node:fs';

/** One thing the person wrote in Linear. */
export interface LinearItem {
  readonly id: string;
  /** `comment` on an issue, an `issue` description, a `project` description. */
  readonly kind: 'comment' | 'issue' | 'project';
  readonly body: string;
  readonly at: string;
  readonly url: string;
  /** The issue (or project) it belongs to: identifier and title, its description, and who opened it. */
  readonly subject: {
    readonly ref: string;
    readonly title: string;
    readonly description: string;
    readonly creator: string;
  };
  /** The comment this one replies to, when it is a reply. */
  readonly replyTo?: string;
}

/** The value of one variable in an env file, or undefined. Only that line is parsed. */
export function envValue(file: string, name: string): string | undefined {
  if (!existsSync(file)) return undefined;
  const line = readFileSync(file, 'utf8')
    .split('\n')
    .find((l) => new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=`).test(l));
  const value = line
    ?.slice(line.indexOf('=') + 1)
    .trim()
    .replace(/^["']|["']$/g, '');
  return value || undefined;
}

type Json = Record<string, unknown>;

async function linear(key: string, query: string, variables: Json): Promise<Json> {
  for (let attempt = 0; ; attempt++) {
    const response = await fetch('https://api.linear.app/graphql', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: key },
      body: JSON.stringify({ query, variables }),
    });
    const body = (await response.json().catch(() => ({}))) as { data?: Json; errors?: unknown };
    if (response.ok && body.data && !body.errors) return body.data;
    if (attempt >= 4)
      throw Error(`Linear API ${response.status}: ${JSON.stringify(body.errors).slice(0, 300)}`);
    await Bun.sleep(3000 * (attempt + 1));
  }
}

async function* pages(
  key: string,
  query: string,
  field: string,
  variables: Json,
): AsyncGenerator<Json> {
  let after: string | null = null;
  for (;;) {
    const data = (await linear(key, query, { ...variables, after }))[field] as {
      nodes: Json[];
      pageInfo: { hasNextPage: boolean; endCursor: string };
    };
    yield* data.nodes;
    if (!data.pageInfo.hasNextPage) return;
    after = data.pageInfo.endCursor;
  }
}

const COMMENTS = `query($id: ID!, $after: String) { comments(first: 50, after: $after, filter: { user: { id: { eq: $id } } }) {
  pageInfo { hasNextPage endCursor }
  nodes { id body createdAt url parent { body }
    issue { identifier title description creator { name } }
    projectUpdate { id } } } }`;

const ISSUES = `query($id: ID!, $after: String) { issues(first: 50, after: $after, filter: { creator: { id: { eq: $id } } }) {
  pageInfo { hasNextPage endCursor }
  nodes { id identifier title description createdAt url } } }`;

const PROJECTS = `query($after: String) { projects(first: 50, after: $after) {
  pageInfo { hasNextPage endCursor }
  nodes { id name description content createdAt url creator { id } } } }`;

const name = (v: unknown) => String((v as { name?: string } | null)?.name ?? 'unknown');

/** Everything the key's user wrote: comments, issue descriptions, project descriptions. */
export async function fetchLinearItems(
  key: string,
  progress?: (line: string) => void,
): Promise<{ workspace: string; items: LinearItem[] }> {
  const head = await linear(key, '{ viewer { id } organization { urlKey } }', {});
  const me = String((head.viewer as Json).id);
  const workspace = String((head.organization as Json).urlKey);
  const items: LinearItem[] = [];
  for await (const c of pages(key, COMMENTS, 'comments', { id: me })) {
    const issue = c.issue as Json | null;
    if (!issue || !String(c.body ?? '').trim()) continue;
    const parent = (c.parent as Json | null)?.body;
    items.push({
      id: String(c.id),
      kind: 'comment',
      body: String(c.body),
      at: String(c.createdAt),
      url: String(c.url),
      subject: {
        ref: String(issue.identifier),
        title: String(issue.title ?? ''),
        description: String(issue.description ?? ''),
        creator: name(issue.creator),
      },
      ...(parent ? { replyTo: String(parent) } : {}),
    });
    if (items.length % 100 === 0) progress?.(`${workspace}: ${items.length} items`);
  }
  for await (const i of pages(key, ISSUES, 'issues', { id: me })) {
    if (!String(i.description ?? '').trim()) continue;
    items.push({
      id: String(i.id),
      kind: 'issue',
      body: String(i.description),
      at: String(i.createdAt),
      url: String(i.url),
      subject: {
        ref: String(i.identifier),
        title: String(i.title ?? ''),
        description: '',
        creator: 'the person',
      },
    });
  }
  for await (const p of pages(key, PROJECTS, 'projects', {})) {
    if (String((p.creator as Json | null)?.id) !== me) continue;
    const body = [p.description, p.content].filter((t) => String(t ?? '').trim()).join('\n\n');
    if (!body.trim()) continue;
    items.push({
      id: String(p.id),
      kind: 'project',
      body,
      at: String(p.createdAt),
      url: String(p.url),
      subject: {
        ref: 'project',
        title: String(p.name ?? ''),
        description: '',
        creator: 'the person',
      },
    });
  }
  progress?.(`${workspace}: ${items.length} items`);
  return { workspace, items: items.sort((a, b) => a.at.localeCompare(b.at)) };
}
