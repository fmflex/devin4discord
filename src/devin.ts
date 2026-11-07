/** Devin API v3 client: sessions and their messages. */

/** Where a task stands. */
export type TaskState =
  | 'starting'
  | 'working'
  | 'waiting'
  | 'finished'
  | 'asleep'
  | 'ended'
  | 'failed';

export type Attachment = { url: string; filename: string };

export type Person = { discordId: string; name: string };

export type StartTaskInput = {
  prompt: string;
  title: string;
  attachments: Attachment[];
  requestedBy: Person;
  guildId: string;
  maxAcu: number | null;
};

export type StartedTask = { id: string; url: string };

/** A file Devin attached to a message, as `uuid`/`name` of its attachment URL. */
export type AgentFile = { uuid: string; name: string };

export type AgentMessage = { id: string; text: string; files: AgentFile[] };

/** A downloaded attachment, ready to upload to Discord. */
export type DownloadedFile = { name: string; data: Uint8Array };

/** Discord's upload limit for servers without boosts. */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

/** Largest Discord file the bot copies to Devin; bigger ones are passed as a link in the text. */
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

/** Only files on Discord's CDN are fetched, so message content can't make the bot request other URLs. */
const DISCORD_CDN_HOSTS = new Set(['cdn.discordapp.com', 'media.discordapp.net']);

export type TaskUpdate = {
  state: TaskState;
  /** Human-readable state, e.g. "waiting for a reply". */
  stateLabel: string;
  /** Devin messages after the cursor that should be shown in Discord. */
  messages: AgentMessage[];
  /** Opaque position to pass to the next `getUpdate` call. */
  cursor: string | null;
  pullRequests: string[];
};

/** What the bridge needs from Devin; tests pass fakes. */
export type DevinApi = Pick<
  DevinClient,
  'startTask' | 'sendMessage' | 'getUpdate' | 'terminate' | 'sleep' | 'unarchive' | 'downloadAttachment'
>;

export const DEFAULT_DEVIN_API_URL = 'https://api.devin.ai';

export type DevinConfig = {
  apiKey: string;
  orgId: string;
  baseUrl: string;
  repos: string[];
  /** Discord user ID -> Devin user ID, so tasks run as that Devin user. */
  userMap: Record<string, string>;
};

type DevinSession = {
  session_id: string;
  url: string;
  status: string;
  status_detail?: string | null;
  pull_requests?: { pr_url: string }[];
};

type DevinMessage = {
  event_id: string;
  message: string;
  source: 'devin' | 'user';
};

const MAX_MESSAGE_PAGES = 20;

const ATTACHMENT_LINE = /^[ \t]*ATTACHMENT:(\{.*\})[ \t]*$/gm;
const ATTACHMENT_PATH = /\/attachments\/([\w-]{1,100})\/([^/?#]{1,255})$/;

/**
 * Splits the `ATTACHMENT:{"url": …}` lines Devin appends for attached files out of a
 * message. Lines that don't hold a Devin attachment URL stay in the text.
 */
export function parseAgentMessage(message: string): { text: string; files: AgentFile[] } {
  const files: AgentFile[] = [];
  const text = message.replace(ATTACHMENT_LINE, (line, json: string) => {
    let url: URL;
    try {
      const parsed = JSON.parse(json) as { url?: unknown };
      if (typeof parsed.url !== 'string') return line;
      url = new URL(parsed.url);
    } catch {
      return line;
    }
    const match = ATTACHMENT_PATH.exec(url.pathname);
    if (!match) return line;
    let name: string;
    try {
      name = decodeURIComponent(match[2]);
    } catch {
      return line;
    }
    files.push({ uuid: match[1], name });
    return '';
  });
  return { text: text.replace(/\n{3,}/g, '\n\n').trim(), files };
}

export function devinState(
  session: Pick<DevinSession, 'status' | 'status_detail'>
): { state: TaskState; label: string } {
  const detail = session.status_detail;
  switch (session.status) {
    case 'running':
      if (detail === 'waiting_for_user') {
        return { state: 'waiting', label: 'waiting for a reply' };
      }
      if (detail === 'waiting_for_approval') {
        return { state: 'waiting', label: 'waiting for approval' };
      }
      if (detail === 'finished') return { state: 'finished', label: 'finished' };
      return { state: 'working', label: 'working' };
    case 'suspended':
      return !detail || detail === 'inactivity' || detail === 'user_request'
        ? { state: 'asleep', label: 'asleep (a reply wakes it)' }
        : { state: 'asleep', label: `suspended (${detail.replace(/_/g, ' ')})` };
    case 'exit':
      return { state: 'ended', label: 'ended' };
    case 'error':
      return { state: 'failed', label: 'failed' };
    default:
      return { state: 'starting', label: 'starting' };
  }
}

export class DevinApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function devinRequest<T>(
  fetchImpl: typeof fetch,
  baseUrl: string,
  apiKey: string,
  path: string,
  method = 'GET',
  body?: unknown
): Promise<T> {
  const response = await fetchImpl(`${baseUrl.replace(/\/+$/, '')}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  if (!response.ok) {
    let detail = '';
    try {
      const json = (await response.json()) as { detail?: unknown };
      if (typeof json.detail === 'string') detail = `: ${json.detail}`;
    } catch {}
    const shown = path.split('?')[0].replace(/^\/v3\/organizations\/[^/]+/, '');
    throw new DevinApiError(
      `Devin API ${method} ${shown || '/'} failed with ${response.status}${detail}`,
      response.status
    );
  }
  return (await response.json()) as T;
}

/**
 * Checks a key and org ID with read-only calls: `GET /v3/self`, then listing
 * one session in the org. Returns the key's display name.
 */
export async function verifyDevinCredentials(
  input: { apiKey: string; orgId: string; baseUrl: string },
  fetchImpl: typeof fetch = fetch
): Promise<{ name: string }> {
  let self: { principal_type?: string; service_user_name?: string; org_id?: string | null };
  try {
    self = await devinRequest(fetchImpl, input.baseUrl, input.apiKey, '/v3/self');
  } catch (error) {
    if (error instanceof DevinApiError && (error.status === 401 || error.status === 403)) {
      throw new Error('Devin rejected this API key.');
    }
    throw error;
  }
  if (self.org_id && self.org_id !== input.orgId) {
    throw new Error(`This key belongs to organization ${self.org_id}, not ${input.orgId}.`);
  }
  try {
    await devinRequest(
      fetchImpl,
      input.baseUrl,
      input.apiKey,
      `/v3/organizations/${encodeURIComponent(input.orgId)}/sessions?first=1`
    );
  } catch (error) {
    if (error instanceof DevinApiError && [401, 403, 404].includes(error.status)) {
      throw new Error(
        `This key can't read sessions in organization ${input.orgId}. Check the org ID and the service user's role.`
      );
    }
    throw error;
  }
  return { name: self.service_user_name ?? self.principal_type ?? 'API key' };
}

/** Devin user IDs as the API returns them, e.g. `user-0123abcd`. */
export const DEVIN_USER_ID = /^user-[\w-]{1,100}$/;

/**
 * Checks that `userId` is a member of the org with
 * `GET /v3beta1/organizations/{org}/members/users/{id}` (needs `ViewOrgMembership`).
 */
export async function verifyDevinOrgUser(
  input: { apiKey: string; orgId: string; baseUrl: string; userId: string },
  fetchImpl: typeof fetch = fetch
): Promise<void> {
  let user: { user_id?: string };
  try {
    user = await devinRequest(
      fetchImpl,
      input.baseUrl,
      input.apiKey,
      `/v3beta1/organizations/${encodeURIComponent(input.orgId)}/members/users/${encodeURIComponent(input.userId)}`
    );
  } catch (error) {
    if (error instanceof DevinApiError && error.status === 404) {
      throw new Error(`${input.userId} isn't a user in organization ${input.orgId}.`);
    }
    if (error instanceof DevinApiError && (error.status === 401 || error.status === 403)) {
      throw new Error(
        `This key can't look up users in organization ${input.orgId}. Give the service user's role ViewOrgMembership to use "Run as Devin users".`
      );
    }
    throw error;
  }
  if (user.user_id && user.user_id !== input.userId) {
    throw new Error(`Devin returned a different user for ${input.userId}.`);
  }
}

export class DevinClient {
  private readonly config: DevinConfig;
  private readonly fetch: typeof fetch;

  constructor(config: DevinConfig, fetchImpl: typeof fetch = fetch) {
    this.config = config;
    this.fetch = fetchImpl;
  }

  async startTask(input: StartTaskInput): Promise<StartedTask> {
    const asUser = this.config.userMap[input.requestedBy.discordId];
    const files = await this.uploadAll(input.attachments);
    const session = await this.request<DevinSession>('/sessions', 'POST', {
      prompt: `${input.prompt}${files.note}`,
      title: input.title,
      tags: ['discord', `discord-guild:${input.guildId}`, `discord-user:${input.requestedBy.discordId}`],
      ...(this.config.repos.length ? { repos: this.config.repos } : {}),
      ...(input.maxAcu ? { max_acu_limit: input.maxAcu } : {}),
      ...(asUser ? { create_as_user_id: asUser } : {}),
      ...files.field
    });
    return { id: session.session_id, url: session.url };
  }

  async sendMessage(
    taskId: string,
    input: { text: string; attachments: Attachment[]; from: Person }
  ) {
    const asUser = this.config.userMap[input.from.discordId];
    const files = await this.uploadAll(input.attachments);
    await this.request(`/sessions/${encodeURIComponent(taskId)}/messages`, 'POST', {
      message: `${input.from.name} (Discord): ${input.text}${files.note}`,
      ...files.field,
      ...(asUser ? { message_as_user_id: asUser } : {})
    });
  }

  async getUpdate(taskId: string, cursor: string | null): Promise<TaskUpdate> {
    const id = encodeURIComponent(taskId);
    const session = await this.request<DevinSession>(`/sessions/${id}`);
    const all = await this.listMessages(id);
    const lastSeen = cursor ? all.findIndex((m) => m.event_id === cursor) : -1;
    const messages: AgentMessage[] = all
      .slice(lastSeen + 1)
      .filter((m) => m.source === 'devin' && m.message.trim())
      .map((m) => ({ id: m.event_id, ...parseAgentMessage(m.message) }));
    const { state, label } = devinState(session);
    return {
      state,
      stateLabel: label,
      messages,
      cursor: all.at(-1)?.event_id ?? cursor,
      pullRequests: (session.pull_requests ?? []).map((pr) => pr.pr_url)
    };
  }

  /** `DELETE /v3/organizations/{org}/sessions/{id}`. A terminated session can't be resumed. */
  async terminate(taskId: string) {
    await this.request(`/sessions/${encodeURIComponent(taskId)}`, 'DELETE');
  }

  /**
   * `POST .../sessions/{id}/archive`: archives the session and puts it to sleep if
   * it's running. v3 has no sleep-only call; a message wakes an archived session.
   */
  async sleep(taskId: string) {
    await this.request(`/sessions/${encodeURIComponent(taskId)}/archive`, 'POST');
  }

  /** `POST .../sessions/{id}/unarchive`, after a reply wakes a session we put to sleep. */
  async unarchive(taskId: string) {
    await this.request(`/sessions/${encodeURIComponent(taskId)}/unarchive`, 'POST');
  }

  /**
   * Copies a Discord file to Devin with `POST /v3/organizations/{org}/attachments` and returns
   * its Devin URL: `attachment_urls` only takes Devin attachment URLs, not Discord CDN links.
   */
  async uploadAttachment(file: Attachment): Promise<string> {
    const source = new URL(file.url);
    if (source.protocol !== 'https:' || !DISCORD_CDN_HOSTS.has(source.hostname)) {
      throw new Error(`${file.filename} isn't a Discord attachment.`);
    }
    const download = await this.fetch(source, { redirect: 'error' });
    if (!download.ok) throw new Error(`Downloading ${file.filename} from Discord failed with ${download.status}.`);
    if (Number(download.headers.get('content-length')) > MAX_UPLOAD_BYTES) {
      throw new Error(`${file.filename} is too large to copy to Devin.`);
    }
    const data = await download.arrayBuffer();
    if (data.byteLength > MAX_UPLOAD_BYTES) throw new Error(`${file.filename} is too large to copy to Devin.`);
    const form = new FormData();
    const type = download.headers.get('content-type') ?? 'application/octet-stream';
    form.append('file', new Blob([data], { type }), file.filename);
    const path = `/v3/organizations/${encodeURIComponent(this.config.orgId)}/attachments`;
    const response = await this.fetch(`${this.config.baseUrl.replace(/\/+$/, '')}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.config.apiKey}` },
      body: form
    });
    if (!response.ok) {
      throw new DevinApiError(`Devin API POST /attachments failed with ${response.status}`, response.status);
    }
    const uploaded = (await response.json()) as { url?: unknown };
    if (typeof uploaded.url !== 'string') throw new Error('Devin returned no attachment URL.');
    return uploaded.url;
  }

  /** Uploads every file it can; the rest are named with their Discord link in `note` so nothing is lost. */
  private async uploadAll(attachments: Attachment[]) {
    const urls: string[] = [];
    const failed: Attachment[] = [];
    for (const file of attachments) {
      try {
        urls.push(await this.uploadAttachment(file));
      } catch (error) {
        console.error(`Copying ${file.filename} to Devin failed:`, error instanceof Error ? error.message : String(error));
        failed.push(file);
      }
    }
    const note = failed.length
      ? `\n\nThese files couldn't be attached; open them from Discord:\n${failed.map((file) => `- ${file.filename}: ${file.url}`).join('\n')}`
      : '';
    return { field: urls.length ? { attachment_urls: urls } : {}, note };
  }

  /**
   * `GET /v3/organizations/{org}/attachments/{uuid}/{name}`. It redirects to a presigned
   * URL, which is fetched without the API key.
   */
  async downloadAttachment(file: AgentFile): Promise<DownloadedFile> {
    const path = `/v3/organizations/${encodeURIComponent(this.config.orgId)}/attachments/${encodeURIComponent(file.uuid)}/${encodeURIComponent(file.name)}`;
    let response = await this.fetch(`${this.config.baseUrl.replace(/\/+$/, '')}${path}`, {
      headers: { Authorization: `Bearer ${this.config.apiKey}` },
      redirect: 'manual'
    });
    const location = response.headers.get('location');
    if (response.status >= 300 && response.status < 400 && location) {
      response = await this.fetch(new URL(location, response.url || this.config.baseUrl), { redirect: 'follow' });
    }
    if (!response.ok) {
      throw new DevinApiError(`Downloading attachment ${file.name} failed with ${response.status}`, response.status);
    }
    const length = Number(response.headers.get('content-length'));
    if (length > MAX_ATTACHMENT_BYTES) throw new Error(`Attachment ${file.name} is too large to upload.`);
    const data = new Uint8Array(await response.arrayBuffer());
    if (data.byteLength > MAX_ATTACHMENT_BYTES) throw new Error(`Attachment ${file.name} is too large to upload.`);
    return { name: file.name, data };
  }

  private async listMessages(sessionId: string) {
    const messages: DevinMessage[] = [];
    let after: string | null = null;
    for (let page = 0; page < MAX_MESSAGE_PAGES; page++) {
      const params = new URLSearchParams({ first: '100' });
      if (after) params.set('after', after);
      const result: {
        items: DevinMessage[];
        end_cursor?: string | null;
        has_next_page?: boolean;
      } = await this.request(`/sessions/${sessionId}/messages?${params}`);
      messages.push(...result.items);
      if (!result.has_next_page || !result.end_cursor) break;
      after = result.end_cursor;
    }
    return messages;
  }

  private request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
    return devinRequest<T>(
      this.fetch,
      this.config.baseUrl,
      this.config.apiKey,
      `/v3/organizations/${encodeURIComponent(this.config.orgId)}${path}`,
      method,
      body
    );
  }
}

