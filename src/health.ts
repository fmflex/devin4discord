import { format } from 'node:util';

export type LoggedError = { at: number; text: string };
export type PruneStatus = { at: number; removed: number; error: string | null };

const MAX_ERRORS = 500;
const MAX_ERROR_TEXT = 300;

/** In-memory host state for the admin page: start time, recent errors and the last prune. Lost on restart. */
export class HostHealth {
  readonly startedAt: number;
  private readonly errors: LoggedError[] = [];
  lastPrune: PruneStatus | null = null;

  constructor(now = Date.now()) {
    this.startedAt = now;
  }

  recordError(text: string, at = Date.now()) {
    const line = text.split('\n')[0].slice(0, MAX_ERROR_TEXT);
    this.errors.push({ at, text: line });
    if (this.errors.length > MAX_ERRORS) this.errors.splice(0, this.errors.length - MAX_ERRORS);
  }

  recordPrune(removed: number, error: unknown = null, at = Date.now()) {
    this.lastPrune = { at, removed, error: error === null ? null : error instanceof Error ? error.message : String(error) };
  }

  /** Errors logged since `since`, newest first. */
  errorsSince(since: number): LoggedError[] {
    return this.errors.filter((error) => error.at >= since).reverse();
  }

  /** Records everything passed to `console.error` while still printing it. */
  captureConsole(target: Pick<Console, 'error'> = console) {
    const original = target.error.bind(target);
    target.error = (...args: unknown[]) => {
      try {
        this.recordError(format(...args));
      } catch {
        // Never let bookkeeping hide the real error.
      }
      original(...args);
    };
  }
}
