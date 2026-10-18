import type {
  AgentAdapter,
  AgentMessage,
  Attachment,
  Person,
  StartTaskInput,
  StartedTask,
  TaskState,
  TaskUpdate
} from './types.ts';

export type DevinConfig = {
  apiKey: string;
  orgId: string;
  baseUrl: string;
  maxAcuLimit: number | null;
  repos: string[];
  tags: string[];
  /** Discord user ID -> Devin user ID, so tasks run as that Devin user. */
  userMap: Map<string, string>;
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

export class DevinAdapter implements AgentAdapter {
  readonly name = 'Devin';
  private readonly config: DevinConfig;
  private readonly fetch: typeof fetch;

  constructor(config: DevinConfig, fetchImpl: typeof fetch = fetch) {
    this.config = config;
    this.fetch = fetchImpl;
  }

  async startTask(input: StartTaskInput): Promise<StartedTask> {
    const asUser = this.config.userMap.get(input.requestedBy.discordId);
    const session = await this.request<DevinSession>('/sessions', 'POST', {
      prompt: input.prompt,
      title: input.title,
      tags: ['discord', ...this.config.tags],
      ...(this.config.repos.length ? { repos: this.config.repos } : {}),
      ...(this.config.maxAcuLimit ? { max_acu_limit: this.config.maxAcuLimit } : {}),
      ...(asUser ? { create_as_user_id: asUser } : {}),
      ...attachmentField(input.attachments)
    });
    return { id: session.session_id, url: session.url };
  }

  async sendMessage(
    taskId: string,
    input: { text: string; attachments: Attachment[]; from: Person }
  ) {
    const asUser = this.config.userMap.get(input.from.discordId);
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

  private async request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
    const base = this.config.baseUrl.replace(/\/+$/, '');
    const response = await this.fetch(
      `${base}/v3/organizations/${encodeURIComponent(this.config.orgId)}${path}`,
      {
        method,
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          'Content-Type': 'application/json'
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      }
    );
    if (!response.ok) {
      let detail = '';
      try {
        const json = (await response.json()) as { detail?: unknown };
        if (typeof json.detail === 'string') detail = `: ${json.detail}`;
      } catch {}
      throw new Error(`Devin API ${method} ${path.split('?')[0]} failed with ${response.status}${detail}`);
    }
    return (await response.json()) as T;
  }
}

function attachmentField(attachments: Attachment[]) {
  return attachments.length
    ? { attachment_urls: attachments.map((file) => file.url) }
    : {};
}
