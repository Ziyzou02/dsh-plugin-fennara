# dsh-plugin-fennara

[English](README.md) | 中文

在 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）里管理并连接 **Godot 工程**的插件：一个工程仓库、一个实时状态面板，以及按需挂载的 [Fennara](https://github.com/fennaraOfficial/fennara-godot-ai) MCP 桥。

安装后 DSH 侧栏底部会出现 `● Fennara`，圆点即实时状态，点开是面板。

## 功能

- **工程仓库** —— 扫描你指定的目录，列出其中的 Godot 工程，并标出哪些装了 Fennara addon 及其版本。
- **分组显示** —— 工程按「可绑定 / 不可绑定」分成两组，后者默认折叠，不挤占可用工程的显示空间。
- **按最近使用排序** —— 最近用过的工程排在前面，顺序在界面上有依据可循。
- **一键连接 / 切换 / 断开** —— 只有被绑定的工程才会挂上它的 Fennara 工具；切换工程会自动释放上一个。
- **跟随正在运行的编辑器** —— 不必手输路径，插件会识别 Godot 编辑器当前打开的是哪个工程。
- **检查更新** —— 查询 Fennara 在 GitHub 上的最新发布并与本机比对，同时指出哪些工程的 addon 已经落后。

## 要求

| 项 | 要求 |
|---|---|
| Godot | 4.5 或更高，且目标工程内已装入 Fennara addon |
| Fennara | 已在本机安装 |
| DSH | 使用 web profile 才显示侧栏面板；其它 profile 仍可使用对话内的全部工具 |
| 系统 | 完整功能需要 Windows；其它平台可显式指定工程使用 |
| 网络 | 只有「检查更新」需要联网，其余功能完全离线可用 |

## 安装

```powershell
dsh plugin --profile web add github:Ziyzou02/dsh-plugin-fennara   # 从 GitHub
dsh plugin --profile web add link:<本插件目录的绝对路径>            # 本地检出
```

**安装后重启 `dsh web`。** npm 上同名包为 `dsh-plugin-fennara`，发布后可直接用包名安装。

## 使用

### 侧栏面板

圆点：🟢 已连接且有绑定 · 🔵 daemon 就绪但未绑定 · 🔴 daemon 不可达 · 🟡 状态未读到。

面板自上而下为：操作按钮（`跟随当前编辑器`、`重新扫描`、`断开绑定`、`检查更新`）、运行环境（Fennara 版本、当前绑定、扫描根）、运行中的编辑器（工程与场景）、工程仓库（可绑定的工程逐条带 `绑定` 按钮，未装 addon 的折叠在下方）。

面板跟随 DSH 的语言设置，中英双语。

### 对话工具

也可以直接在对话里说「接上我现在开着的 Godot 工程」。

| 工具 | 作用 | 参数 |
|---|---|---|
| `fennara_projects` | 列出工程与运行状态 | `refresh`、`onlyBindable` |
| `fennara_search` | 查找 Godot 工程并加入仓库 | `roots`、`maxDepth`、`withFennaraOnly` |
| `fennara_use` | 绑定工程，或释放当前绑定 | `project`、`auto`、`unbind` |
| `fennara_health` | 报告 Fennara、daemon 与当前绑定状态 | — |
| `fennara_update` | 比对 GitHub 最新发布与本机版本 | `fresh` |

绑定后该工程的工具以 `mcp__<serverName>__<tool>` 出现，例如 `mcp__fennara-mygame__fennara_status`。同一时刻只保留一个绑定；不用时建议 `unbind` 释放。

## 配置

在 `~/.dsh/profiles/web/cordis.patch.yml` 里按 id 覆盖：

```yaml
- id: fennara
  config:
    roots: ['D:\GodotProjects']
    autoBind: true
```

> 请使用上面这种 `- id: fennara` 形式；用 `insert:` 插入同一个 id 会追加出第二行，导致插件被挂载两次。按 id 覆盖会整体替换该行的配置，未列出的字段取插件自身默认值。

| 字段 | 默认 | 说明 |
|---|---|---|
| `roots` | `[]` | 扫描根目录。留空则使用 Godot 编辑器记录的工程列表 |
| `maxDepth` / `nestedDepth` | `4` / `2` | 扫描深度；嵌套工程的搜索层数 |
| `autoBind` | `false` | 设为 `true` 时，启动即绑定唯一在运行的那个编辑器所打开的工程 |
| `toolCallTimeoutMs` | `300000` | 单次 MCP 调用超时 |
| `daemonPort` | `41287` | Fennara 本地 daemon 端口 |
| `usageFile` | `~/.dsh/fennara-usage.json` | 「最近使用」记录的存放位置 |
| `githubRepo` / `githubToken` | `fennaraOfficial/fennara-godot-ai` / — | 检查更新查询的仓库与可选 token |

## 卸载

```powershell
dsh plugin --profile web remove dsh-plugin-fennara
```

插件在本机只留下一份「最近使用」记录（默认 `~/.dsh/fennara-usage.json`），可直接删除。

## 许可证

MIT —— 可自由使用、修改、分发，需保留版权与许可声明。
