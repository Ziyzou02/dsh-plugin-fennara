/**
 * Update check: compare the installed Fennara against its GitHub releases.
 *
 * The repository is the one Fennara itself publishes from. The check is
 * on-demand only (a button or a tool call) and the network is reached with an
 * injectable `fetch`, so the whole module is testable without a connection.
 *
 * Every failure is reported as data, never thrown at the caller: an offline
 * machine or a rate limit must not break the panel.
 *
 * @module dsh-plugin-fennara/update
 */

/** Fennara's public repository, as named by the addon's own release metadata. */
export const DEFAULT_REPO = 'fennaraOfficial/fennara-godot-ai';

/** Releases fetched per check; enough to see past a draft or a broken entry. */
const RELEASES_PER_PAGE = 10;

/**
 * Parse a version string into comparable parts.
 * Accepts a leading `v`, missing minor/patch, and a prerelease/build suffix.
 * @param {unknown} text
 * @returns {{core: [number, number, number], prerelease: string|null, raw: string, normalized: string}|null}
 */
export function parseVersion(text) {
  if (typeof text !== 'string') return null;
  const raw = text.trim();
  const match = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:[-+](.+))?$/i.exec(raw);
  if (match === null) return null;
  const core = [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)];
  const prerelease = match[4] ?? null;
  return {
    core,
    prerelease,
    raw,
    // Display form: a tag's `v` prefix is dropped, missing parts are filled in,
    // so a release reads consistently next to the locally installed version.
    normalized: `${core.join('.')}${prerelease === null ? '' : `-${prerelease}`}`,
  };
}

/**
 * Compare two versions.
 * A release outranks its own prereleases; prerelease labels compare as text,
 * which is enough to tell `beta.1` from `beta.2` for a "newer version" notice.
 * @returns {number|null} -1 when a < b, 0 when equal, 1 when a > b, null when either is unparseable
 */
export function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (left === null || right === null) return null;
  for (let index = 0; index < 3; index += 1) {
    if (left.core[index] !== right.core[index]) return left.core[index] < right.core[index] ? -1 : 1;
  }
  if (left.prerelease === right.prerelease) return 0;
  if (left.prerelease === null) return 1;
  if (right.prerelease === null) return -1;
  if (left.prerelease === right.prerelease) return 0;
  return left.prerelease < right.prerelease ? -1 : 1;
}

/** Whether `local` is older than `latest`; false whenever that cannot be decided. */
export function isBehind(local, latest) {
  return compareVersions(local, latest) === -1;
}

/** A check failure carrying the HTTP status, when there was one. */
export class UpdateCheckError extends Error {
  constructor(message, status = null) {
    super(message);
    this.name = 'UpdateCheckError';
    this.status = status;
  }
}

/** Turn a non-OK GitHub response into an actionable sentence. */
function describeFailure(status, repo) {
  if (status === 404) return `GitHub 上找不到仓库 ${repo}（可能已改名或转为私有）`;
  if (status === 403 || status === 429) return 'GitHub 接口限流（未认证请求每小时 60 次），稍后再试或配置 githubToken';
  if (status >= 500) return `GitHub 暂时不可用（HTTP ${status}）`;
  return `GitHub 返回 HTTP ${status}`;
}

/**
 * Fetch the newest published release.
 * @param {{repo?: string, token?: string|null, timeoutMs?: number, fetchImpl?: Function}} [options]
 * @returns {Promise<object>} the newest release, normalized
 */
export async function fetchLatestRelease(options = {}) {
  const repo = options.repo ?? DEFAULT_REPO;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new UpdateCheckError('当前运行环境没有可用的 fetch');
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'dsh-plugin-fennara',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (typeof options.token === 'string' && options.token.length > 0) {
    headers.Authorization = `Bearer ${options.token}`;
  }

  let response;
  try {
    response = await fetchImpl(`https://api.github.com/repos/${repo}/releases?per_page=${RELEASES_PER_PAGE}`, {
      headers,
      signal: AbortSignal.timeout(options.timeoutMs ?? 8_000),
    });
  } catch (error) {
    const reason = error?.cause?.code ?? error?.code ?? error?.name ?? 'unreachable';
    throw new UpdateCheckError(`无法连接 GitHub（${reason}）`);
  }
  if (response.ok !== true) {
    throw new UpdateCheckError(describeFailure(response.status, repo), response.status);
  }

  let releases;
  try {
    releases = await response.json();
  } catch {
    throw new UpdateCheckError('GitHub 返回的内容无法解析');
  }
  if (!Array.isArray(releases) || releases.length === 0) {
    throw new UpdateCheckError(`${repo} 还没有发布任何 release`);
  }

  const candidates = releases
    .filter((release) => release !== null && typeof release === 'object' && release.draft !== true)
    .map((release) => ({ release, version: parseVersion(release.tag_name ?? release.name) }))
    .filter((entry) => entry.version !== null);
  // Newest by version, not by list order: GitHub lists by creation date, which
  // a back-ported patch release can contradict.
  candidates.sort((a, b) => compareVersions(b.version.raw, a.version.raw) ?? 0);
  const chosen = candidates[0] ?? null;
  if (chosen === null) throw new UpdateCheckError(`${repo} 的 release 都没有可识别的版本号`);

  return {
    tag: chosen.release.tag_name ?? null,
    version: chosen.version.normalized,
    name: chosen.release.name ?? null,
    prerelease: chosen.release.prerelease === true,
    publishedAt: chosen.release.published_at ?? null,
    releaseUrl: chosen.release.html_url ?? `https://github.com/${repo}/releases`,
    notes: typeof chosen.release.body === 'string' ? chosen.release.body.slice(0, 2_000) : null,
    releaseCount: releases.length,
  };
}

/**
 * Runs the check, remembers the last result, and answers from that memory
 * until its TTL expires. The panel shows the remembered result, so opening it
 * never triggers network traffic on its own.
 */
export class UpdateChecker {
  /**
   * @param {{repo?: string, token?: string|null, timeoutMs?: number, cacheTtlMs?: number, logger?: object, fetchImpl?: Function}} [options]
   */
  constructor(options = {}) {
    this.repo = options.repo ?? DEFAULT_REPO;
    this.token = options.token ?? null;
    this.timeoutMs = options.timeoutMs ?? 8_000;
    this.cacheTtlMs = options.cacheTtlMs ?? 300_000;
    this.logger = options.logger ?? null;
    this.fetchImpl = options.fetchImpl ?? null;
    this.lastResult = null;
    this.inFlight = null;
  }

  /** The remembered result, without touching the network. */
  last() {
    return this.lastResult;
  }

  /**
   * @param {{localVersion?: string|null, staleProjects?: object[], force?: boolean}} [options]
   * @returns {Promise<object>} an always-`ok`-shaped result; failures set `ok: false`
   */
  async check(options = {}) {
    const localVersion = options.localVersion ?? null;
    const staleProjects = Array.isArray(options.staleProjects) ? options.staleProjects : [];
    const cached = this.lastResult;
    if (options.force !== true && cached !== null && Date.now() - cached.checkedAt < this.cacheTtlMs) {
      return { ...cached, cached: true, localVersion, staleProjects };
    }
    if (this.inFlight !== null) return this.inFlight;

    this.inFlight = (async () => {
      const base = {
        repo: this.repo,
        repoUrl: `https://github.com/${this.repo}`,
        localVersion,
        staleProjects,
        checkedAt: Date.now(),
      };
      try {
        const release = await fetchLatestRelease({
          repo: this.repo,
          token: this.token,
          timeoutMs: this.timeoutMs,
          fetchImpl: this.fetchImpl ?? undefined,
        });
        const comparison = compareVersions(localVersion, release.version);
        const result = {
          ok: true,
          ...base,
          latestVersion: release.version,
          latestTag: release.tag,
          releaseName: release.name,
          releaseUrl: release.releaseUrl,
          publishedAt: release.publishedAt,
          prerelease: release.prerelease,
          notes: release.notes,
          // `null` comparison means one side was unparseable; do not claim either way.
          upToDate: comparison === null ? null : comparison >= 0,
          comparable: comparison !== null,
        };
        this.lastResult = result;
        return result;
      } catch (error) {
        const result = {
          ok: false,
          ...base,
          error: error?.message ?? String(error),
          status: error?.status ?? null,
          latestVersion: null,
          upToDate: null,
        };
        this.lastResult = result;
        this.logger?.warn?.(`fennara: update check failed: ${result.error}`);
        return result;
      } finally {
        this.inFlight = null;
      }
    })();
    return this.inFlight;
  }
}
