# dsh-plugin-fennara

English | [中文](README.zh.md)

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) plugin that manages and connects **Godot projects** through the [Fennara](https://github.com/fennaraOfficial/fennara-godot-ai) MCP bridge: a project registry, a live status panel, and on-demand attachment.

Once installed, `● Fennara` appears at the bottom of the DSH sidebar — the dot is the live status, and clicking it opens the panel.

## Features

- **Project registry** — scans the folders you point it at and lists the Godot projects it finds, marking which ones carry the Fennara addon and at which version.
- **Grouped display** — projects are split into can-connect and cannot-connect; the second group is collapsed by default so it never crowds out the usable ones.
- **Most recently used first** — the projects you used last sort to the top, with the ordering visible in the UI.
- **One-click connect / switch / disconnect** — only the attached project contributes its Fennara tools, and switching releases the previous attachment.
- **Follow the running editor** — no paths to type: the plugin detects which project the Godot editor currently has open.
- **Update check** — queries the latest Fennara release on GitHub and compares it with the installed version, pointing out projects whose addon is behind.

## Requirements

| Item | Requirement |
|---|---|
| Godot | 4.5 or newer, with the Fennara addon installed in the target project |
| Fennara | installed on this machine |
| DSH | a web profile for the sidebar panel; other profiles still get every tool in conversation |
| OS | full functionality requires Windows; elsewhere, name the project explicitly |
| Network | only the update check needs it; everything else works offline |

## Install

```powershell
dsh plugin --profile web add github:Ziyzou02/dsh-plugin-fennara       # from GitHub
dsh plugin --profile web add link:<absolute path to this directory>   # local checkout
```

**Restart `dsh web` afterwards.** The npm package name is `dsh-plugin-fennara`, installable by name once published.

## Usage

### Sidebar panel

Dot: 🟢 connected with a project attached · 🔵 daemon ready, nothing attached · 🔴 daemon unreachable · 🟡 status not read yet.

Top to bottom the panel shows: action buttons (`Follow editor`, `Rescan`, `Disconnect`, `Check updates`), Environment (Fennara version, current attachment, scan roots), running editors (project and scene), and the project registry (connectable projects each with a `Connect` button, projects without the addon collapsed below).

The panel follows the harness language setting and ships in English and Chinese.

### Conversation tools

You can also simply ask to attach the Godot editor you have open.

| Tool | Purpose | Parameters |
|---|---|---|
| `fennara_projects` | List projects and their runtime state | `refresh`, `onlyBindable` |
| `fennara_search` | Find Godot projects and add them to the registry | `roots`, `maxDepth`, `withFennaraOnly` |
| `fennara_use` | Attach a project, or release the current attachment | `project`, `auto`, `unbind` |
| `fennara_health` | Report Fennara, daemon and attachment state | — |
| `fennara_update` | Compare the latest GitHub release with the installed version | `fresh` |

An attached project's tools appear as `mcp__<serverName>__<tool>`, for example `mcp__fennara-mygame__fennara_status`. Only one project is attached at a time; `unbind` releases it when you are done.

## Configuration

Override by id in `~/.dsh/profiles/web/cordis.patch.yml`:

```yaml
- id: fennara
  config:
    roots: ['D:\GodotProjects']
    autoBind: true
```

> Use the `- id: fennara` form shown above. Inserting the same id with `insert:` appends a second row and mounts the plugin twice. An id-targeted patch replaces that row's configuration wholesale, so any field you leave out falls back to the plugin default.

| Field | Default | Meaning |
|---|---|---|
| `roots` | `[]` | Folders to scan. Empty means "use the project list the Godot editor already keeps" |
| `maxDepth` / `nestedDepth` | `4` / `2` | Scan depth; how far to look for nested projects |
| `autoBind` | `false` | When `true`, attach the project of the only running editor at startup |
| `toolCallTimeoutMs` | `300000` | Per-call MCP timeout |
| `daemonPort` | `41287` | Fennara's local daemon port |
| `usageFile` | `~/.dsh/fennara-usage.json` | Where the "recently used" record is kept |
| `githubRepo` / `githubToken` | `fennaraOfficial/fennara-godot-ai` / — | Repository queried by the update check, and an optional token |

## Uninstall

```powershell
dsh plugin --profile web remove dsh-plugin-fennara
```

The only thing the plugin leaves behind is the "recently used" record (default `~/.dsh/fennara-usage.json`), which you can delete.

## License

MIT — free to use, modify and redistribute, provided the copyright and licence notice are retained.
