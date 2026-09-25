/**
 * Persistent "recently used" memory for the project registry.
 *
 * The registry orders projects by recency, and the most trustworthy signal is
 * this plugin's own record of a successful bind — the filesystem fallback in
 * `registry.js` is only an inference. That record has to outlive a DSH restart,
 * so it lives in one small JSON file under the DSH home.
 *
 * Every failure here is non-fatal by design: losing recency data must never
 * break binding, and a corrupt file must never break startup.
 *
 * @module dsh-plugin-fennara/usage
 */

import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** Keep the file bounded; only the most recent entries are worth keeping. */
const MAX_ENTRIES = 200;

/** Where the usage record lives when the profile config names no file. */
export function defaultUsageFile() {
  const home = process.env.DSH_HOME && process.env.DSH_HOME.length > 0 ? process.env.DSH_HOME : join(homedir(), '.dsh');
  return join(home, 'fennara-usage.json');
}

/** One project's usage facts. Paths are compared case-insensitively (Windows). */
export class UsageStore {
  /**
   * @param {{file?: string, logger?: object, writeDelayMs?: number}} [options]
   */
  constructor(options = {}) {
    this.file = options.file ?? defaultUsageFile();
    this.logger = options.logger ?? null;
    this.writeDelayMs = options.writeDelayMs ?? 500;
    /** @type {Map<string, {lastUsedAt: number, useCount: number}>} */
    this.entries = new Map();
    this.loaded = false;
    this.loadPromise = null;
    this.writeTimer = null;
    this.writePromise = null;
  }

  /** Read the record once; a missing or corrupt file simply starts empty. */
  async load() {
    if (this.loaded) return this.entries;
    if (this.loadPromise === null) {
      this.loadPromise = (async () => {
        try {
          const parsed = JSON.parse(await readFile(this.file, 'utf8'));
          const projects = parsed?.projects;
          if (projects !== null && typeof projects === 'object') {
            for (const [path, value] of Object.entries(projects)) {
              const lastUsedAt = value?.lastUsedAt;
              if (typeof path === 'string' && Number.isFinite(lastUsedAt)) {
                this.entries.set(path.toLowerCase(), {
                  lastUsedAt,
                  useCount: Number.isFinite(value?.useCount) ? value.useCount : 0,
                });
              }
            }
          }
        } catch (error) {
          if (error?.code !== 'ENOENT') {
            this.logger?.warn?.(`fennara: usage record unreadable, starting empty: ${error?.message ?? error}`);
          }
        }
        this.loaded = true;
        return this.entries;
      })();
    }
    return this.loadPromise;
  }

  /** Synchronous lookup for the registry's sort; callers load() first. */
  get(path) {
    if (typeof path !== 'string') return null;
    return this.entries.get(path.toLowerCase()) ?? null;
  }

  /** Record a successful use, then persist on a short debounce. */
  async record(path, at = Date.now()) {
    if (typeof path !== 'string' || path === '') return null;
    await this.load();
    const key = path.toLowerCase();
    const previous = this.entries.get(key);
    const entry = { lastUsedAt: at, useCount: (previous?.useCount ?? 0) + 1 };
    this.entries.set(key, entry);
    this.#prune();
    this.#scheduleWrite();
    return entry;
  }

  /** Flush any pending write immediately (used on teardown and by tests). */
  async flush() {
    if (this.writeTimer !== null) {
      clearTimeout(this.writeTimer);
      this.writeTimer = null;
    }
    if (this.writePromise !== null) await this.writePromise;
    if (this.entries.size === 0) return;
    await this.#write();
  }

  #prune() {
    if (this.entries.size <= MAX_ENTRIES) return;
    const ordered = [...this.entries.entries()].sort((a, b) => b[1].lastUsedAt - a[1].lastUsedAt);
    this.entries = new Map(ordered.slice(0, MAX_ENTRIES));
  }

  #scheduleWrite() {
    if (this.writeTimer !== null) return;
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null;
      this.writePromise = this.#write().finally(() => {
        this.writePromise = null;
      });
    }, this.writeDelayMs);
    // A pending usage write must not hold the process open.
    this.writeTimer.unref?.();
  }

  async #write() {
    const payload = {
      version: 1,
      updatedAt: new Date().toISOString(),
      projects: Object.fromEntries(this.entries),
    };
    const temporary = `${this.file}.tmp`;
    try {
      await mkdir(dirname(this.file), { recursive: true });
      await writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
      await rename(temporary, this.file);
    } catch (error) {
      this.logger?.warn?.(`fennara: could not persist the usage record: ${error?.message ?? error}`);
    }
  }
}
