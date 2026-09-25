/**
 * Fennara project registry: Fennara install discovery + Godot project inventory.
 *
 * Pure Node built-ins only — this module has no DSH imports and is testable
 * standalone (`node test/selftest.mjs`).
 *
 * @module dsh-plugin-fennara/registry
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, sep, basename } from 'node:path';

/** Directories never worth descending into while scanning for Godot projects. */
const SKIP_DIRS = new Set([
  '.git', '.godot', '.import', 'node_modules', 'bin', 'obj', 'Library',
  'Temp', 'Logs', 'Build', 'Builds', '.vs', '.idea', '__pycache__',
  '$RECYCLE.BIN', 'System Volume Information',
]);

/** Where the Fennara CLI/daemon/MCP runtime is installed on this machine. */
export function fennaraAppDir() {
  const local = process.env.LOCALAPPDATA;
  if (!local) throw new Error('LOCALAPPDATA is not set; cannot locate the Fennara app directory');
  return join(local, 'Fennara');
}

/**
 * The version-independent launcher shim. It reads `current.json` itself and
 * starts whichever `fennara-mcp-runtime.exe` that record names, so spawning it
 * survives Fennara self-updates and `current.json` schema drift alike.
 */
export function launcherPath(appDir) {
  return join(appDir, 'bin', process.platform === 'win32' ? 'fennara-mcp.exe' : 'fennara-mcp');
}

/**
 * Read `current.json`, the record the Fennara addon maintains for the active
 * install. It is the only stable way to find version-pinned runtime binaries.
 * @returns {Promise<object>} install record
 */
export async function resolveFennaraInstall() {
  const appDir = fennaraAppDir();
  const currentPath = join(appDir, 'current.json');
  const record = {
    appDir,
    version: null,
    mcpRuntime: null,
    daemonRuntime: null,
    addonPath: null,
    releaseTag: null,
    launcher: null,
    recordReadable: false,
    installed: false,
  };
  const launcher = launcherPath(appDir);
  record.launcher = existsSync(launcher) ? launcher : null;

  let parsed = null;
  try {
    parsed = JSON.parse(await readFile(currentPath, 'utf8'));
    record.recordReadable = parsed !== null && typeof parsed === 'object';
  } catch {
    parsed = null;
  }
  if (record.recordReadable) {
    const rel = (value) => (typeof value === 'string' && value.length > 0 ? join(appDir, value) : null);
    record.version = typeof parsed.version === 'string' ? parsed.version : null;
    record.releaseTag = typeof parsed.release_tag === 'string' ? parsed.release_tag : null;
    record.mcpRuntime = rel(parsed.mcp_runtime);
    record.daemonRuntime = rel(parsed.daemon_runtime);
    record.addonPath = rel(parsed.addon);
  }
  // A readable record is not required for a usable install: the launcher stands
  // on its own, so a renamed or removed current.json field must not make a
  // working install report as missing.
  record.installed = record.launcher !== null || (record.mcpRuntime !== null && existsSync(record.mcpRuntime));
  return record;
}

/**
 * The executable a client should spawn: the launcher when present, else the
 * version-pinned runtime the install record names.
 * @returns {{command: string|null, via: string}}
 */
export function resolveMcpCommand(install) {
  if (typeof install?.launcher === 'string' && existsSync(install.launcher)) {
    return { command: install.launcher, via: 'launcher' };
  }
  const fallbackLauncher = launcherPath(install?.appDir ?? fennaraAppDir());
  if (existsSync(fallbackLauncher)) return { command: fallbackLauncher, via: 'launcher' };
  if (install?.mcpRuntime && existsSync(install.mcpRuntime)) {
    return { command: install.mcpRuntime, via: 'runtime' };
  }
  return { command: null, via: 'missing' };
}

/** Minimal Godot `project.godot` reader — enough for identity and routing. */
export function parseProjectGodot(text) {
  const grab = (key) => {
    const pattern = new RegExp(`^${key.replace(/\//g, '\\/')}="((?:[^"\\\\]|\\\\.)*)"`, 'm');
    const match = pattern.exec(text);
    return match ? match[1].replace(/\\"/g, '"') : null;
  };
  const features = /^config\/features=PackedStringArray\(([^)]*)\)/m.exec(text);
  return {
    name: grab('config/name'),
    mainScene: grab('run/main_scene'),
    features: features
      ? features[1].split(',').map((part) => part.trim().replace(/^"|"$/g, '')).filter(Boolean)
      : [],
  };
}

/**
 * Files whose newest modification time is the best local proxy for "when was
 * this project last touched": Godot rewrites its editor metadata each session,
 * and opening a project in the editor updates the cache directory.
 */
const RECENCY_MARKERS = [
  ['.godot', 'editor', 'project_metadata.cfg'],
  ['.godot'],
  ['project.godot'],
  ['addons', 'fennara', 'VERSION'],
];

/** Newest mtime among a project's recency markers, or null when none exist. */
async function projectRecency(dir) {
  let newest = null;
  for (const parts of RECENCY_MARKERS) {
    try {
      const info = await stat(join(dir, ...parts));
      const stamp = info.mtimeMs;
      if (Number.isFinite(stamp) && (newest === null || stamp > newest)) newest = stamp;
    } catch {
      /* a missing marker is not an error */
    }
  }
  return newest;
}

/**
 * Inspect one directory as a Godot project root.
 * @returns {Promise<object|null>} a project record, or null when not a project root.
 */
export async function inspectProject(dir) {
  const godotFile = join(dir, 'project.godot');
  if (!existsSync(godotFile)) return null;
  let meta = { name: null, mainScene: null, features: [] };
  try {
    meta = parseProjectGodot(await readFile(godotFile, 'utf8'));
  } catch {
    /* an unreadable project.godot still marks a project root */
  }
  const addonDir = join(dir, 'addons', 'fennara');
  const hasAddon = existsSync(join(addonDir, 'fennara.gdextension'));
  let addonVersion = null;
  if (hasAddon && existsSync(join(addonDir, 'VERSION'))) {
    try {
      addonVersion = (await readFile(join(addonDir, 'VERSION'), 'utf8')).trim();
    } catch {
      /* ignore */
    }
  }
  return {
    path: resolve(dir),
    name: meta.name ?? basename(dir),
    dirName: basename(dir),
    mainScene: meta.mainScene,
    features: meta.features,
    hasFennaraAddon: hasAddon,
    fennaraVersion: addonVersion,
    imported: existsSync(join(dir, '.godot')),
    isGitRepo: existsSync(join(dir, '.git')),
    recentAt: await projectRecency(dir),
  };
}

/**
 * Breadth-first scan for Godot project roots.
 *
 * A project root is recorded but NOT treated as a leaf: Godot projects nested
 * inside another project are common (editor tooling, split-out sub-projects),
 * so the scan keeps descending inside a project subtree for `nestedDepth`
 * further levels before giving up. Known-heavy folders are skipped outright.
 *
 * @param {string[]} roots
 * @param {{maxDepth?: number, nestedDepth?: number, limit?: number, onVisit?: (path: string) => void}} [options]
 * @returns {Promise<object[]>}
 */
export async function scanForProjects(roots, options = {}) {
  const maxDepth = Number.isInteger(options.maxDepth) ? options.maxDepth : 4;
  const nestedDepth = Number.isInteger(options.nestedDepth) ? options.nestedDepth : 2;
  const limit = Number.isInteger(options.limit) ? options.limit : 500;
  const found = [];
  /** @type {{dir: string, depth: number, insideProject: number}[]} */
  const queue = [];
  for (const root of roots) {
    const abs = resolve(root);
    if (existsSync(abs)) queue.push({ dir: abs, depth: 0, insideProject: 0 });
  }
  const seen = new Set();
  while (queue.length > 0 && found.length < limit) {
    const { dir, depth, insideProject } = queue.shift();
    if (seen.has(dir)) continue;
    seen.add(dir);
    options.onVisit?.(dir);
    const record = await inspectProject(dir);
    if (record) found.push(record);
    if (depth >= maxDepth) continue;
    // The nested budget bounds how far we look inside a project's own tree, so a
    // game's asset folders are never walked just because the game is a project.
    if (insideProject >= nestedDepth) continue;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    // Children of a project root start a fresh budget; deeper non-project
    // folders keep counting against the enclosing project's budget.
    const childInside = record ? 1 : insideProject > 0 ? insideProject + 1 : 0;
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
      queue.push({ dir: join(dir, entry.name), depth: depth + 1, insideProject: childInside });
    }
  }
  return found;
}

/** Pick the project a user reference points at: exact path, dir name, or name. */
export function matchProject(projects, reference) {
  if (typeof reference !== 'string' || reference.trim() === '') return null;
  const needle = reference.trim().replace(/[\\/]+$/, '');
  const lowered = needle.toLowerCase();
  const byPath = projects.find((p) => p.path.toLowerCase() === resolve(needle).toLowerCase());
  if (byPath) return byPath;
  const exactName = projects.find(
    (p) => p.name.toLowerCase() === lowered || p.dirName.toLowerCase() === lowered,
  );
  if (exactName) return exactName;
  const suffix = projects.filter(
    (p) => p.path.toLowerCase().endsWith(sep + lowered) || p.path.toLowerCase().endsWith('/' + lowered),
  );
  if (suffix.length === 1) return suffix[0];
  const partial = projects.filter(
    (p) => p.name.toLowerCase().includes(lowered) || p.dirName.toLowerCase().includes(lowered),
  );
  return partial.length === 1 ? partial[0] : null;
}

/**
 * In-memory project inventory with a TTL. `refresh()` rescans; `list()` serves
 * the cache and rescans once the TTL expires.
 *
 * Every read returns projects ordered by most-recently-used, descending: the
 * plugin's own record of a successful bind wins, and a project never bound here
 * falls back to the newest local marker time (see {@link RECENCY_MARKERS}).
 */
export class ProjectRegistry {
  /**
   * @param {{roots?: string[], maxDepth?: number, nestedDepth?: number, ttlMs?: number, usage?: object}} options
   *   `usage` is an optional store exposing `get(path) -> {lastUsedAt, useCount}`.
   */
  constructor(options = {}) {
    /** @type {string[]} */
    this.roots = [...(options.roots ?? [])];
    this.maxDepth = options.maxDepth ?? 4;
    this.nestedDepth = options.nestedDepth ?? 2;
    this.ttlMs = options.ttlMs ?? 60_000;
    this.usage = options.usage ?? null;
    /** @type {object[]} */
    this.projects = [];
    this.scannedAt = 0;
  }

  /** @param {{force?: boolean, roots?: string[]}} [options] */
  async refresh(options = {}) {
    const roots = options.roots && options.roots.length > 0 ? options.roots : this.roots;
    for (const root of roots) if (!this.roots.includes(root)) this.roots.push(root);
    const found = await scanForProjects(roots, { maxDepth: this.maxDepth, nestedDepth: this.nestedDepth });
    const byPath = new Map(found.map((p) => [p.path.toLowerCase(), p]));
    // Keep previously-known projects that live outside the scanned roots.
    for (const existing of this.projects) {
      if (!byPath.has(existing.path.toLowerCase())) byPath.set(existing.path.toLowerCase(), existing);
    }
    this.projects = [...byPath.values()];
    this.scannedAt = Date.now();
    return this.ordered();
  }

  async list(options = {}) {
    const stale = Date.now() - this.scannedAt > this.ttlMs;
    if (options.force === true || this.scannedAt === 0 || stale) await this.refresh(options);
    return this.ordered();
  }

  /**
   * Decorate with usage facts and sort by recency. Cheap enough to run on every
   * read, so a bind shows up in the order immediately without a rescan.
   */
  ordered() {
    const decorated = this.projects.map((project) => {
      const used = this.usage?.get(project.path) ?? null;
      const lastUsedAt = Number.isFinite(used?.lastUsedAt) ? used.lastUsedAt : null;
      const recentAt = Number.isFinite(project.recentAt) ? project.recentAt : null;
      return {
        ...project,
        lastUsedAt,
        recentAt,
        useCount: Number.isFinite(used?.useCount) ? used.useCount : 0,
        // Bound-by-us beats inferred-from-disk; both are "how recently used".
        sortAt: lastUsedAt ?? recentAt ?? 0,
        recentSource: lastUsedAt !== null ? 'plugin' : recentAt !== null ? 'filesystem' : 'unknown',
      };
    });
    decorated.sort((a, b) => b.sortAt - a.sortAt || a.name.localeCompare(b.name));
    return decorated;
  }

  /** @param {string} reference */
  async resolve(reference) {
    return matchProject(await this.list(), reference);
  }

  /** Projects that carry the Fennara addon. */
  async bindable() {
    return (await this.list()).filter((p) => p.hasFennaraAddon);
  }
}

/** Default scan roots when the profile config supplies none: Godot's own registry. */
export async function rootsFromGodotEditor() {
  const appData = process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming');
  const cfg = join(appData, 'Godot', 'projects.cfg');
  if (!existsSync(cfg)) return [];
  try {
    const text = await readFile(cfg, 'utf8');
    return [...text.matchAll(/^\[(.+?)\]$/gm)].map((m) => m[1].replace(/\//g, sep)).filter(Boolean);
  } catch {
    return [];
  }
}
