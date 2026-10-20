/**
 * The structured log: JSON Lines, one file per day under `<home>/logs/`, kept 14 days. Records carry ids, counts and
 * timings, never tokens, secrets or transaction details. Writes are appended in order and never throw: a broken log
 * never stops the server. Each record is echoed to standard error, which a supervisor's journal keeps.
 */
import { appendFile, mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";

const KEEP_DAYS = 14;

export type Severity = "debug" | "info" | "warn" | "error";

export type Attributes = Record<string, string | number | boolean | null>;

export class Log {
  readonly directory: string;
  private readonly name: string;
  private readonly file: RegExp;
  private writing: Promise<void> = Promise.resolve();
  private day = "";
  private readonly echo: boolean;

  /** `name` (the app's, lowercase letters, digits and dashes) prefixes each day's file: `<name>-<day>.jsonl`. */
  constructor(home: string, name: string, { echo = true }: { echo?: boolean } = {}) {
    if (!/^[a-z0-9-]+$/.test(name)) {
      throw new Error(`a log name is lowercase letters, digits and dashes: ${name}`);
    }

    this.directory = join(home, "logs");
    this.name = name;
    this.file = new RegExp(`^${name}-(\\d{4}-\\d{2}-\\d{2})\\.jsonl$`);
    this.echo = echo;
  }

  /** Append one record, in order with the others. Never throws. */
  write(severity: Severity, scope: string, body: string, attributes?: Attributes): void {
    const time = new Date().toISOString();
    const line = `${JSON.stringify({ time, severity, scope, body, ...(attributes === undefined ? {} : { attributes }) })}\n`;

    if (this.echo) {
      process.stderr.write(line);
    }

    this.writing = this.writing
      .then(async () => {
        const day = time.slice(0, 10);

        if (day !== this.day) {
          this.day = day;
          await mkdir(this.directory, { recursive: true, mode: 0o700 });
          await this.prune(day);
        }

        await appendFile(join(this.directory, `${this.name}-${day}.jsonl`), line, { mode: 0o600 });
      })
      .catch(() => {
        // Logging never fails the caller; a record that can't be written is dropped.
      });
  }

  /** Resolves once every record written so far is on disk. */
  flushed(): Promise<void> {
    return this.writing;
  }

  private async prune(today: string): Promise<void> {
    const oldest = new Date(Date.parse(today) - KEEP_DAYS * 86_400_000).toISOString().slice(0, 10);

    for (const name of await readdir(this.directory).catch(() => [])) {
      const day = this.file.exec(name)?.[1];

      if (day !== undefined && day < oldest) {
        // oxlint-disable-next-line no-await-in-loop -- one file at a time; pruning is rare and never urgent
        await rm(join(this.directory, name), { force: true });
      }
    }
  }
}

/** A log scope's writer. */
export type Logger = (severity: Severity, body: string, attributes?: Attributes) => void;

export function scoped(log: Log, scope: string): Logger {
  return (severity, body, attributes) => log.write(severity, scope, body, attributes);
}
