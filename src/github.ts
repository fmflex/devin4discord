/** GitHub REST client for `/devin merge`: one server's token, merging only PRs whose checks passed. */
import type { Secrets } from './crypto.ts';
import type { GuildStore } from './guilds.ts';

export const GITHUB_API_URL = 'https://api.github.com';

export type PrRef = { owner: string; repo: string; number: number };

const PR_URL = /^https:\/\/github\.com\/([\w.-]{1,100})\/([\w.-]{1,100})\/pull\/(\d{1,9})(?:[/?#].*)?$/;

export function parsePrUrl(url: string): PrRef | null {
  const match = PR_URL.exec(url.trim());
  return match ? { owner: match[1], repo: match[2], number: Number(match[3]) } : null;
}

export function prUrl(pr: PrRef) {
  return `https://github.com/${pr.owner}/${pr.repo}/pull/${pr.number}`;
}

export class GitHubError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function githubRequest<T>(
  fetchImpl: typeof fetch,
  token: string,
  path: string,
  method = 'GET',
  body?: unknown
): Promise<T> {
  const response = await fetchImpl(`${GITHUB_API_URL}${path}`, {
    method,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'devin4discord',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  if (!response.ok) {
    let detail = '';
    try {
      const json = (await response.json()) as { message?: unknown };
      if (typeof json.message === 'string') detail = `: ${json.message}`;
    } catch {}
    throw new GitHubError(`GitHub ${method} ${path.split('?')[0]} failed with ${response.status}${detail}`, response.status);
  }
  return (await response.json()) as T;
}

/** Checks a token with `GET /user` and returns its login. */
export async function verifyGithubToken(token: string, fetchImpl: typeof fetch = fetch): Promise<{ login: string }> {
  try {
    const user = await githubRequest<{ login: string }>(fetchImpl, token, '/user');
    return { login: user.login };
  } catch (error) {
    if (error instanceof GitHubError && (error.status === 401 || error.status === 403)) {
      throw new Error('GitHub rejected this token.');
    }
    throw error;
  }
}

export type PullSummary = { title: string; url: string; open: boolean; merged: boolean };

type GithubPull = {
  title: string;
  html_url: string;
  state: 'open' | 'closed';
  merged: boolean;
  draft?: boolean;
  mergeable: boolean | null;
  head: { sha: string };
};

type CheckRun = { name: string; status: string; conclusion: string | null };

const PASSED = new Set(['success', 'neutral', 'skipped']);

/** What the bot needs from GitHub; tests pass fakes. */
export type GitHubApi = Pick<GitHubClient, 'pull' | 'merge'>;

export class GitHubClient {
  private readonly token: string;
  private readonly fetch: typeof fetch;
  private readonly wait: (ms: number) => Promise<void>;

  constructor(token: string, fetchImpl: typeof fetch = fetch, wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))) {
    this.token = token;
    this.fetch = fetchImpl;
    this.wait = wait;
  }

  async pull(pr: PrRef): Promise<PullSummary> {
    const raw = await this.getPull(pr);
    return { title: raw.title, url: raw.html_url, open: raw.state === 'open', merged: raw.merged };
  }

  /**
   * Merges an open, conflict-free PR once every check on its head commit has passed, with the
   * repo's merge method (merge commit, else squash, else rebase). The head SHA is pinned so a
   * push after the check can't be merged unchecked. Throws a readable error otherwise.
   */
  async merge(pr: PrRef): Promise<{ title: string; url: string; method: string }> {
    let raw = await this.getPull(pr);
    // GitHub computes `mergeable` in the background after a push; ask again once.
    if (raw.state === 'open' && raw.mergeable === null) {
      await this.wait(2000);
      raw = await this.getPull(pr);
    }
    if (raw.merged) throw new Error(`${raw.html_url} is already merged.`);
    if (raw.state !== 'open') throw new Error(`${raw.html_url} is closed.`);
    if (raw.draft) throw new Error(`${raw.html_url} is a draft. Mark it ready for review first.`);
    if (raw.mergeable === false) throw new Error(`${raw.html_url} has merge conflicts.`);
    await this.requireChecksPassed(pr, raw.head.sha);
    const repo = await this.request<{ allow_merge_commit?: boolean; allow_squash_merge?: boolean }>(
      `/repos/${pr.owner}/${pr.repo}`
    );
    const method = repo.allow_merge_commit !== false ? 'merge' : repo.allow_squash_merge !== false ? 'squash' : 'rebase';
    try {
      await this.request(`/repos/${pr.owner}/${pr.repo}/pulls/${pr.number}/merge`, 'PUT', {
        merge_method: method,
        sha: raw.head.sha
      });
    } catch (error) {
      if (error instanceof GitHubError && error.status === 409) {
        throw new Error(`${raw.html_url} changed while merging. Run it again once its checks pass.`);
      }
      if (error instanceof GitHubError && error.status === 405) {
        throw new Error(`GitHub won't merge ${raw.html_url}${error.message.replace(/^[^:]*/, '')}`);
      }
      throw error;
    }
    return { title: raw.title, url: raw.html_url, method };
  }

  private async requireChecksPassed(pr: PrRef, sha: string) {
    const base = `/repos/${pr.owner}/${pr.repo}/commits/${sha}`;
    const status = await this.request<{ state: string; total_count: number; statuses: { context: string; state: string }[] }>(
      `${base}/status?per_page=100`
    );
    const runs: CheckRun[] = [];
    for (let page = 1; ; page++) {
      const batch = await this.request<{ total_count: number; check_runs: CheckRun[] }>(
        `${base}/check-runs?per_page=100&page=${page}`
      );
      runs.push(...batch.check_runs);
      if (!batch.check_runs.length || runs.length >= batch.total_count) break;
    }
    const running = runs.filter((run) => run.status !== 'completed').map((run) => run.name);
    const failed = runs.filter((run) => run.status === 'completed' && !PASSED.has(run.conclusion ?? '')).map((run) => run.name);
    for (const item of status.statuses) {
      if (item.state === 'pending') running.push(item.context);
      else if (item.state !== 'success') failed.push(item.context);
    }
    // `state` covers every status, including any beyond the first page.
    if (status.total_count && !failed.length && (status.state === 'failure' || status.state === 'error')) {
      failed.push('commit statuses');
    }
    if (status.total_count && !running.length && status.state === 'pending') running.push('commit statuses');
    if (failed.length) throw new Error(`Checks failed on ${prUrl(pr)}: ${failed.join(', ')}.`);
    if (running.length) throw new Error(`Checks are still running on ${prUrl(pr)}: ${running.join(', ')}. Try again when they pass.`);
  }

  private getPull(pr: PrRef) {
    return this.request<GithubPull>(`/repos/${pr.owner}/${pr.repo}/pulls/${pr.number}`);
  }

  private request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
    return githubRequest<T>(this.fetch, this.token, path, method, body);
  }
}

/** Builds each server's GitHub client from its saved token, cached until it changes. */
export function githubResolver(guilds: GuildStore, secrets: Secrets, fetchImpl: typeof fetch = fetch) {
  const cache = new Map<string, { updatedAt: number; client: GitHubClient }>();
  return (guildId: string): GitHubClient | null => {
    const settings = guilds.github(guildId);
    if (!settings) {
      cache.delete(guildId);
      return null;
    }
    const cached = cache.get(guildId);
    if (cached?.updatedAt === settings.updatedAt) return cached.client;
    const client = new GitHubClient(secrets.decrypt(settings.tokenEncrypted, guildId), fetchImpl);
    cache.set(guildId, { updatedAt: settings.updatedAt, client });
    return client;
  };
}
