/**
 * Runtime probe: which Godot editors are actually running right now, and
 * whether the Fennara local daemon is up.
 *
 * The window title is the cheapest reliable signal on Windows: a Godot editor
 * titles itself `<open scene> - <project name> - Godot Engine`, so one process
 * listing yields the project, the edited scene, and the PID at once. A running
 * game titles itself `<project> (DEBUG)`.
 *
 * Pure Node built-ins only — no DSH imports.
 *
 * @module dsh-plugin-fennara/probe
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Fennara's local bridge default port (`ws://127.0.0.1:41287/godot/ws`). */
export const DEFAULT_DAEMON_PORT = 41287;

/**
 * The port the daemon actually listened on, read from its own startup log.
 *
 * The port is a compiled-in default on both sides, so this is the one place a
 * real port is written down. It exists to keep the status honest if a future
 * Fennara build picks a different port: the binding path is unaffected either
 * way, because the spawned launcher finds its own daemon.
 *
 * @param {string} appDir Fennara app-data directory
 * @returns {Promise<number|null>} newest logged port, or null when unknown
 */
export async function discoverDaemonPort(appDir) {
  if (typeof appDir !== 'string' || appDir === '') return null;
  let text;
  try {
    text = await readFile(join(appDir, 'logs', 'daemon-startup.log'), 'utf8');
  } catch {
    return null;
  }
  const matches = [...text.matchAll(/listening on https?:\/\/[^:\s/]+:(\d{1,5})/g)];
  if (matches.length === 0) return null;
  const port = Number(matches[matches.length - 1][1]);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : null;
}

const PROCESS_SCRIPT = `
$procs = @(Get-Process | Where-Object { $_.ProcessName -like 'godot*' })
$rows = @(foreach ($p in $procs) {
  $cl = $null
  try { $cl = (Get-CimInstance Win32_Process -Filter "ProcessId=$($p.Id)" -ErrorAction Stop).CommandLine } catch { }
  [pscustomobject]@{ pid = $p.Id; name = $p.ProcessName; title = $p.MainWindowTitle; commandLine = $cl }
})
ConvertTo-Json -InputObject $rows -Compress -Depth 3
`;

function powershellCandidates() {
  return process.platform === 'win32' ? ['pwsh.exe', 'powershell.exe'] : ['pwsh', 'powershell'];
}

/** Run a PowerShell script and return its stdout, or null when unavailable. */
function runPowerShell(script, timeoutMs) {
  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script];
  return new Promise((resolvePromise) => {
    const candidates = powershellCandidates();
    let index = 0;
    const attempt = () => {
      if (index >= candidates.length) return resolvePromise(null);
      const exe = candidates[index++];
      try {
        execFile(exe, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
          if (error && !stdout) {
            if (error.code === 'ENOENT') return attempt();
            return resolvePromise(null);
          }
          resolvePromise(stdout ?? null);
        });
      } catch (error) {
        // A confined sandbox can refuse the spawn synchronously (EPERM); that is
        // an unavailable probe, not a crash. Only a missing binary falls through
        // to the next PowerShell candidate.
        if (error?.code === 'ENOENT') return attempt();
        resolvePromise(null);
      }
    };
    attempt();
  });
}

/**
 * Classify one Godot window title.
 * @param {string} title
 * @returns {{kind: string, project: string|null, scene: string|null}}
 */
export function classifyWindowTitle(title) {
  const text = (title ?? '').trim();
  if (text === '') return { kind: 'unknown', project: null, scene: null };
  if (/project manager/i.test(text)) return { kind: 'project-manager', project: null, scene: null };
  let match = /^(.*?)\s+-\s+(.*?)\s+-\s+Godot Engine$/i.exec(text);
  if (match) return { kind: 'editor', scene: match[1].trim(), project: match[2].trim() };
  match = /^(.*?)\s+-\s+Godot Engine$/i.exec(text);
  if (match) return { kind: 'editor', scene: null, project: match[1].trim() };
  match = /^(.*?)\s+\((DEBUG|Release|Editor|debug|release)\)$/.exec(text);
  if (match) return { kind: 'game', scene: null, project: match[1].trim() };
  return { kind: 'unknown', project: text, scene: null };
}

/** Extract `--path <dir>` / `--path=<dir>` from a Godot command line. */
export function projectPathFromCommandLine(commandLine) {
  if (typeof commandLine !== 'string' || commandLine === '') return null;
  const spaced = /--path\s+"?([^"]+?)"?(?:\s|$)/i.exec(commandLine);
  if (spaced) return spaced[1];
  const joined = /--path=(?:"([^"]+)"|(\S+))/i.exec(commandLine);
  if (joined) return joined[1] ?? joined[2];
  return null;
}

/**
 * List running Godot processes with their window titles classified.
 * @param {{timeoutMs?: number}} [options]
 * @returns {Promise<{supported: boolean, editors: object[], processes: object[], note?: string}>}
 */
export async function listGodotProcesses(options = {}) {
  if (process.platform !== 'win32') {
    return { supported: false, editors: [], processes: [], note: 'process probing is implemented for Windows only' };
  }
  const timeoutMs = options.timeoutMs ?? 15_000;
  const stdout = await runPowerShell(PROCESS_SCRIPT, timeoutMs);
  if (stdout === null) {
    return { supported: false, editors: [], processes: [], note: 'PowerShell is unavailable or denied process access' };
  }
  let parsed;
  try {
    parsed = JSON.parse(stdout.trim() === '' ? '[]' : stdout);
  } catch {
    return { supported: false, editors: [], processes: [], note: 'could not parse the process listing' };
  }
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  const processes = rows
    .filter((row) => row && typeof row === 'object' && row.pid !== undefined)
    .map((row) => {
      const title = typeof row.title === 'string' ? row.title : '';
      return {
        pid: Number(row.pid),
        processName: typeof row.name === 'string' ? row.name : 'godot',
        title,
        commandLine: typeof row.commandLine === 'string' ? row.commandLine : null,
        projectPath: projectPathFromCommandLine(row.commandLine),
        ...classifyWindowTitle(title),
      };
    });
  const editors = processes.filter((p) => p.kind === 'editor');
  return { supported: true, editors, processes };
}

/**
 * Ask Fennara's local daemon whether it is listening.
 * @param {{port?: number, timeoutMs?: number}} [options]
 */
export async function daemonHealth(options = {}) {
  const port = options.port ?? DEFAULT_DAEMON_PORT;
  const timeoutMs = options.timeoutMs ?? 1_500;
  const url = `http://127.0.0.1:${port}/health`;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    const body = await response.text();
    return { reachable: true, port, status: response.status, body: body.slice(0, 500) };
  } catch (error) {
    return {
      reachable: false,
      port,
      status: null,
      body: null,
      reason: error?.cause?.code ?? error?.code ?? error?.name ?? 'unreachable',
    };
  }
}

/**
 * One runtime snapshot: running editors plus daemon state.
 * @param {{port?: number, timeoutMs?: number}} [options]
 */
export async function probeRuntime(options = {}) {
  const [processes, daemon] = await Promise.all([
    listGodotProcesses({ timeoutMs: options.timeoutMs }),
    daemonHealth({ port: options.port }),
  ]);
  return {
    probedAt: new Date().toISOString(),
    processProbe: { supported: processes.supported, note: processes.note ?? null },
    editors: processes.editors,
    processes: processes.processes,
    daemon,
  };
}

/** True when the path exists and looks like a spawnable Fennara MCP launcher. */
export function isSpawnable(path) {
  return typeof path === 'string' && path.length > 0 && existsSync(path);
}
