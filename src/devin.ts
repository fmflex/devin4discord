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

export type AgentMessage = { id: string; text: string };

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
  'startTask' | 'sendMessage' | 'getUpdate' | 'terminate' | 'sleep' | 'unarchive'
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

export class DevinClient {
  private readonly config: DevinConfig;
  private readonly fetch: typeof fetch;

  constructor(config: DevinConfig, fetchImpl: typeof fetch = fetch) {
    this.config = config;
    this.fetch = fetchImpl;
  }

  async startTask(input: StartTaskInput): Promise<StartedTask> {
    const asUser = this.config.userMap[input.requestedBy.discordId];
    const session = await this.request<DevinSession>('/sessions', 'POST', {
      prompt: input.prompt,
      title: input.title,
      tags: ['discord', `discord-guild:${input.guildId}`, `discord-user:${input.requestedBy.discordId}`],
      ...(this.config.repos.length ? { repos: this.config.repos } : {}),
      ...(input.maxAcu ? { max_acu_limit: input.maxAcu } : {}),
      ...(asUser ? { create_as_user_id: asUser } : {}),
      ...attachmentField(input.attachments)
    });
    return { id: session.session_id, url: session.url };
  }

  async sendMessage(
    taskId: string,
    input: { text: string; attachments: Attachment[]; from: Person }
  ) {
    const asUser = this.config.userMap[input.from.discordId];
    await this.request(`/sessions/${encodeURIComponent(taskId)}/messages`, 'POST', {
      message: `${input.from.name} (Discord): ${input.text}`,
      ...attachmentField(input.attachments),
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
      .map((m) => ({ id: m.event_id, text: m.message }));
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

function attachmentField(attachments: Attachment[]) {
  return attachments.length
    ? { attachment_urls: attachments.map((file) => file.url) }
    : {};
}
