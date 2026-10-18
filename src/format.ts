import type { Attachment, Person, TaskState } from './devin.ts';

export const DISCORD_MESSAGE_LIMIT = 2000;

/** Splits text into Discord-sized messages, preferring line boundaries. */
export function chunkMessage(text: string, limit = DISCORD_MESSAGE_LIMIT): string[] {
  const chunks: string[] = [];
  let rest = text.trim();
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n', limit);
    if (cut < limit / 2) cut = rest.lastIndexOf(' ', limit);
    if (cut < limit / 2) cut = limit;
    chunks.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

/** A one-line title of at most `max` characters. */
export function shortTitle(text: string, max = 80): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

export type ForwardedMessage = {
  authorName: string;
  authorId: string;
  link: string;
  content: string;
  attachments: Attachment[];
};

export const DEFAULT_INSTRUCTIONS =
  'Work out what is being asked, fix it and open a pull request. If it is unclear or not actionable, say why and what you need.';

export const RELAY_NOTE =
  'Your messages are relayed to a Discord thread where the team follows along; their replies in that thread come back to you.';

function requester(opener: Person) {
  return `Requested on Discord by ${opener.name} (Discord ID ${opener.discordId}).`;
}

/** Prompt for a Discord message someone forwarded to Devin. */
export function forwardedMessagePrompt(
  message: ForwardedMessage,
  opener: Person,
  instructions: string
): string {
  const quoted = message.content.trim()
    ? message.content
        .trim()
        .split('\n')
        .map((line) => `> ${line}`)
        .join('\n')
    : '> (no text, see the attached files)';
  const files = message.attachments.length
    ? `\n\nAttached files (also passed as attachments):\n${message.attachments
        .map((file) => `- ${file.filename}: ${file.url}`)
        .join('\n')}`
    : '';
  return `Someone posted this on Discord and ${opener.name} forwarded it to you.

Author: ${message.authorName} (Discord ID ${message.authorId})
Message: ${message.link}

${quoted}${files}

${instructions}

${requester(opener)} ${RELAY_NOTE}`;
}

export function taskPrompt(task: string, opener: Person, instructions: string): string {
  return `${task}\n\n${instructions}\n\n${requester(opener)} ${RELAY_NOTE}`.replace(
    /\n{3,}/g,
    '\n\n'
  );
}

/** Status changes worth announcing (and pinging the opener for). */
export function stateAnnouncement(
  previousLabel: string | null,
  state: TaskState,
  label: string,
  agentName: string
): string | null {
  if (label === previousLabel) return null;
  switch (state) {
    case 'waiting':
      return `${agentName} is ${label}: reply in this thread.`;
    case 'finished':
      return `${agentName} marked the task as finished.`;
    case 'ended':
    case 'failed':
      return `Task ${label}.`;
    case 'asleep':
      return label.startsWith('suspended') ? `Task ${label}.` : null;
    default:
      return null;
  }
}

export function isFinalState(state: TaskState) {
  return state === 'ended' || state === 'failed';
}
