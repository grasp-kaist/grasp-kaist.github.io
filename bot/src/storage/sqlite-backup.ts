import { randomUUID } from 'node:crypto';
import {
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';

const BACKUP_FILE_PATTERN = /^grasp-profile-bot-\d{8}T\d{6}\.\d{3}Z-[0-9a-f]{8}\.sqlite$/;

export type SqliteBackupSource = {
  backupTo(path: string): Promise<void>;
  verifyBackup(path: string): void;
};

export type SqliteBackupSchedulerOptions = {
  source: SqliteBackupSource;
  directory: string;
  intervalMs: number;
  retentionCount: number;
  now?: () => Date;
  newId?: () => string;
  onError?: (error: unknown) => void;
};

export class SqliteBackupScheduler {
  readonly #source: SqliteBackupSource;
  readonly #directory: string;
  readonly #intervalMs: number;
  readonly #retentionCount: number;
  readonly #now: () => Date;
  readonly #newId: () => string;
  readonly #onError: (error: unknown) => void;
  #timer: ReturnType<typeof setInterval> | undefined;
  #active: Promise<string> | undefined;

  constructor(options: SqliteBackupSchedulerOptions) {
    this.#source = options.source;
    this.#directory = options.directory;
    this.#intervalMs = positiveInteger(options.intervalMs, 'intervalMs');
    this.#retentionCount = positiveInteger(options.retentionCount, 'retentionCount');
    this.#now = options.now ?? (() => new Date());
    this.#newId = options.newId ?? randomUUID;
    this.#onError = options.onError ?? (() => undefined);
  }

  start() {
    if (this.#timer) {
      return;
    }

    this.#timer = setInterval(() => {
      void this.backupNow().catch(this.#onError);
    }, this.#intervalMs);
    this.#timer.unref();
  }

  backupNow() {
    if (!this.#active) {
      this.#active = this.#createVerifiedBackup().finally(() => {
        this.#active = undefined;
      });
    }
    return this.#active;
  }

  async stop() {
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
    await this.#active;
  }

  async #createVerifiedBackup() {
    mkdirSync(this.#directory, { recursive: true });
    const timestamp = this.#now().toISOString().replaceAll(':', '').replaceAll('-', '');
    const suffix = this.#newId().replaceAll('-', '').slice(0, 8).toLowerCase();
    const filename = `grasp-profile-bot-${timestamp}-${suffix}.sqlite`;
    const destination = join(this.#directory, filename);
    const temporary = `${destination}.tmp`;

    try {
      await this.#source.backupTo(temporary);
      this.#source.verifyBackup(temporary);
      renameSync(temporary, destination);
    } catch (error) {
      rmSync(temporary, { force: true });
      throw error;
    }

    this.#pruneBackups();
    return destination;
  }

  #pruneBackups() {
    const backups = readdirSync(this.#directory)
      .filter((name) => BACKUP_FILE_PATTERN.test(name))
      .sort()
      .reverse();

    for (const expired of backups.slice(this.#retentionCount)) {
      rmSync(join(this.#directory, expired), { force: true });
    }
  }
}

function positiveInteger(value: number, name: string) {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}
