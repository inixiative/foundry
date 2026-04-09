import type {
  FixtureSource,
  PRFixture,
  PRFileChange,
  ExtractOpts,
} from "./types";

export interface GitHubFixtureConfig {
  /** GitHub API token with repo read access. */
  token: string;
  owner: string;
  repo: string;
  /** Override GitHub API base URL (for GitHub Enterprise). */
  baseUrl?: string;
}

/**
 * Extracts PR fixtures from GitHub's API.
 *
 * Each merged PR becomes a fixture with:
 * - Ticket: linked issue (parsed from PR body "Closes #N" / "Fixes #N")
 * - Base SHA: the commit before the squash merge
 * - Golden diff: the squash merge diff
 * - File changes: per-file patches
 */
export class GitHubFixtureSource implements FixtureSource {
  readonly id: string;

  private _token: string;
  private _owner: string;
  private _repo: string;
  private _baseUrl: string;

  constructor(config: GitHubFixtureConfig) {
    this.id = `github:${config.owner}/${config.repo}`;
    this._token = config.token;
    this._owner = config.owner;
    this._repo = config.repo;
    this._baseUrl = (config.baseUrl ?? "https://api.github.com").replace(
      /\/$/,
      ""
    );
  }

  async extract(opts?: ExtractOpts): Promise<PRFixture[]> {
    const limit = opts?.limit ?? 20;
    const prs = await this._listMergedPRs(limit, opts?.since);

    const fixtures: PRFixture[] = [];

    for (const pr of prs) {
      const fixture = await this._extractOne(pr);
      if (!fixture) continue;

      // Apply filters
      if (opts?.labels?.length) {
        const has = opts.labels.some((l) =>
          fixture.meta.labels.includes(l)
        );
        if (!has) continue;
      }

      if (opts?.complexity?.length) {
        if (!opts.complexity.includes(fixture.meta.complexity)) continue;
      }

      fixtures.push(fixture);
      if (fixtures.length >= limit) break;
    }

    return fixtures;
  }

  async getByPR(prNumber: number): Promise<PRFixture | null> {
    const pr = await this._fetch(`/repos/${this._owner}/${this._repo}/pulls/${prNumber}`);
    if (!pr || !pr.merged_at) return null;
    return this._extractOne(pr);
  }

  // -- Internal --

  private async _listMergedPRs(
    limit: number,
    since?: string
  ): Promise<any[]> {
    const perPage = Math.min(limit * 2, 100); // Fetch extra since not all may be merged
    let page = 1;
    const maxPages = 20; // Safety guard against infinite pagination
    const results: any[] = [];

    while (results.length < limit && page <= maxPages) {
      const prs = await this._fetch(
        `/repos/${this._owner}/${this._repo}/pulls?state=closed&sort=updated&direction=desc&per_page=${perPage}&page=${page}`
      );

      if (!prs || prs.length === 0) break;

      for (const pr of prs) {
        if (!pr.merged_at) continue;
        if (since && pr.merged_at < since) continue;
        results.push(pr);
        if (results.length >= limit) break;
      }

      page++;
      if (prs.length < perPage) break; // No more pages
    }

    return results;
  }

  private async _extractOne(pr: any): Promise<PRFixture | null> {
    if (!pr.merged_at || !pr.merge_commit_sha) return null;

    // Fetch the diff
    const diff = await this._fetchRaw(
      `/repos/${this._owner}/${this._repo}/pulls/${pr.number}`,
      "application/vnd.github.v3.diff"
    );

    // Fetch file changes
    const filesData = await this._fetch(
      `/repos/${this._owner}/${this._repo}/pulls/${pr.number}/files`
    );

    const files: PRFileChange[] = (filesData ?? []).map((f: any) => ({
      path: f.filename,
      status: f.status as PRFileChange["status"],
      patch: f.patch,
      previousPath: f.previous_filename,
    }));

    // Try to find linked issue
    const ticket = await this._extractTicket(pr);

    // Compute metadata
    const additions = (filesData ?? []).reduce(
      (sum: number, f: any) => sum + (f.additions ?? 0),
      0
    );
    const deletions = (filesData ?? []).reduce(
      (sum: number, f: any) => sum + (f.deletions ?? 0),
      0
    );
    const totalLines = additions + deletions;

    const labels = (pr.labels ?? []).map((l: any) => l.name);

    return {
      id: `${this._owner}/${this._repo}#${pr.number}`,
      pr: {
        owner: this._owner,
        repo: this._repo,
        number: pr.number,
        title: pr.title,
        url: pr.html_url,
        mergedAt: pr.merged_at,
        mergeCommitSha: pr.merge_commit_sha,
      },
      ticket,
      baseSha: pr.base?.sha ?? "",
      goldenDiff: diff ?? "",
      files,
      meta: {
        filesChanged: files.length,
        additions,
        deletions,
        labels,
        complexity:
          totalLines < 50 ? "small" : totalLines < 200 ? "medium" : "large",
      },
    };
  }

  /**
   * Extract linked issue from PR body.
   * Looks for patterns: "Closes #N", "Fixes #N", "Resolves #N"
   */
  private async _extractTicket(
    pr: any
  ): Promise<PRFixture["ticket"]> {
    const body: string = pr.body ?? "";

    // Match "Closes #123", "Fixes #123", "Resolves #123" patterns
    const match = body.match(
      /(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)/i
    );

    if (!match) return null;

    const issueNumber = parseInt(match[1], 10);

    try {
      const issue = await this._fetch(
        `/repos/${this._owner}/${this._repo}/issues/${issueNumber}`
      );

      if (!issue) return null;

      return {
        number: issue.number,
        title: issue.title,
        body: issue.body ?? "",
        labels: (issue.labels ?? []).map((l: any) =>
          typeof l === "string" ? l : l.name
        ),
        url: issue.html_url,
      };
    } catch {
      return null;
    }
  }

  private async _fetch(path: string): Promise<any> {
    const res = await fetch(`${this._baseUrl}${path}`, {
      headers: {
        authorization: `Bearer ${this._token}`,
        accept: "application/vnd.github.v3+json",
      },
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`GitHub API ${res.status}: ${text}`);
    }

    return res.json();
  }

  private async _fetchRaw(path: string, accept: string): Promise<string> {
    const res = await fetch(`${this._baseUrl}${path}`, {
      headers: {
        authorization: `Bearer ${this._token}`,
        accept,
      },
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`GitHub API ${res.status}: ${text}`);
    }

    return res.text();
  }
}
