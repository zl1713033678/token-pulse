# AGENTS.md · 研发与 AI 编程协作宪章

> 任何开发者或 AI Agent 在修改本项目前，**必须先阅读本文档与 [`docs/STATUS.md`](./docs/STATUS.md)**，严守以下领域不变量与工程门禁。

## 1. 核心代码地图

```text
token-pulse/
├── plugin.json / mcp_config.json    # Antigravity 原生插件清单与 stdio MCP 挂载
├── assets/logo.svg                  # 128x128 透明背景矢量图标
├── skills/telemetry/SKILL.md        # /telemetry 快捷技能入口
├── scripts/
│   ├── sqlite-reader.mjs            # 只读 node:sqlite + 实测校准 Protobuf 解析器
│   └── server.mjs                   # 零依赖 stdio MCP Server（资源 + 4 工具分层）
├── src/ui/                          # template.html / styles.css / app.js（ext-apps SDK）
├── build.mjs                        # esbuild 单文件打包并部署至 ~/.gemini/config/plugins/
└── test/verify.mjs                  # SQLite / Manifest / CSS合规 / Stdio MCP 端到端校验
```

## 2. 不可违背的领域与工程红线（Hard Invariants）

1. **纯本地原生边界（禁止外部抓取与成本估算）**：严禁采集第三方工具、严禁抓取 `language_server` 进程命令行/端口 Token、严禁新增估算费用（USD/等价成本）字段；全部数据仅来自只读本地 SQLite。
2. **零运行时依赖交付**：部署至 `~/.gemini/config/plugins/token-pulse/` 的插件包不得包含 `node_modules/`；`npm` 安装与缓存必须留在 `D:` 盘（`--cache D:\Cache\npm-cache`）。
3. **原生主题合规**：UI 严禁硬编码白色卡片背景（`#fff`/`#ffffff`/`rgba(255,255,255,...)`），严禁在 `color-mix()` 中使用 `in oklch`（防 Chromium 低彩度洋红偏色 bug），严禁对 `scrollbar-color` 添加过渡动画；表面色与强调色必须由宿主 CSS 变量（`--color-background-primary`、`--color-ring-primary`）与 `color-mix(in oklab, ...)` 派生。
4. **平台与协议精确约束**：
   - `plugin.json` 严禁写入 `$schema` 或任何未定义顶层字段（加载器会静默丢弃）；
   - `server.mjs` 的 `stdout` 仅用于 JSON-RPC 帧，诊断日志一律输出到 `stderr`；
   - 真实库中 `gen_metadata.size` 恒为 `0`，判空必须检查 `data` Blob 长度；`genInfo.11` 为 TTFT、`genInfo.12` 为流生成耗时，`latencySec = ttftSec + streamSec`。

## 3. 文档、排障与特性孵化流规

1. **特性孵化禁令（Spec Gate）**：新想法先写入 [`docs/specs/`](./docs/specs/README.md) 登记为 `PLANNED`，**未经用户明确指令严禁修改业务代码**；落地后回填完成时间戳与关联代码。
2. **科学排障闭环（Bug Fix Gate）**：新缺陷先记入 [`docs/BUGS.md`](./docs/BUGS.md) → 先写最小失败用例（Red）→ 最小修复（Green）→ 全量回归后移入 [`CHANGELOG.md`](./CHANGELOG.md)。
3. **状态覆写纪律**：[`docs/STATUS.md`](./docs/STATUS.md) 每次交付直接覆写刷新（≤ 80 行），严禁堆砌过期流水账。

## 4. 构建、回归与文档必跑命令

- **构建并部署插件**：`npm run build`
- **功能与协议回归**：`npm run verify`
- **文档体检门禁**：`python -X utf8 "<dev-docs-skill>/scripts/verify_docs.py" .`
