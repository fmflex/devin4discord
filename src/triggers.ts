/** Parsing for @mentions of the bot and the Stop / Sleep buttons it posts. */

export type ControlAction = 'stop' | 'sleep';

export type ParsedMention = {
  /** True only for a direct mention of the bot user; role mentions, @everyone and @here don't count. */
  mentioned: boolean;
  /** The content with the bot's mentions removed. */
  text: string;
  /** `@Devin stop` / `@Devin sleep`. */
  command: ControlAction | null;
};

export function parseMention(content: string, botUserId: string): ParsedMention {
  if (!/^\d+$/.test(botUserId)) throw new Error('The bot user ID must be a snowflake.');
  const pattern = new RegExp(`<@!?${botUserId}>`, 'g');
  const mentioned = pattern.test(content);
  const text = content
    .replace(pattern, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .trim();
  const word = text.toLowerCase().replace(/[.!]+$/, '');
  const command = mentioned && (word === 'stop' || word === 'sleep') ? word : null;
  return { mentioned, text, command };
}

const CONTROL_PREFIX = 'devin';

export function controlId(action: ControlAction, taskId: string) {
  return `${CONTROL_PREFIX}:${action}:${taskId}`;
}

/** Null for anything that isn't one of our buttons. The task it names still has to be checked. */
export function parseControlId(customId: string): { action: ControlAction; taskId: string } | null {
  const match = /^devin:(stop|sleep):([A-Za-z0-9_-]{1,100})$/.exec(customId);
  return match ? { action: match[1] as ControlAction, taskId: match[2] } : null;
}
