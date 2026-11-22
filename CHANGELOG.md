# Changelog · 版本演进与修复归档

本项目的重要功能里程碑与已完成的安全、逻辑、UI 修复均归档于此（遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 精神）。当前未修复问题请查阅 [`docs/BUGS.md`](./docs/BUGS.md)。

---

## [1.0.0] - 2026-11-23

### Added
- **纯本地 SQLite/Protobuf 遥测读取器**（[`scripts/sqlite-reader.mjs`](./scripts/sqlite-reader.mjs)）：零依赖只读扫描 Antigravity Desktop 与 CLI 会话库，提取动态上下文上限、Input/Cache Read/Thinking/Text 拆解、观测到的上下文回落事件与 5h/多日趋势聚合（不含任何费用估算）。
- **零依赖 Stdio MCP Server**（[`scripts/server.mjs`](./scripts/server.mjs)）：提供 `open_telemetry_panel`（支持 `aux_pane` 侧边栏与 `global` 全页入口）及 3 个 `app` 私有刷新/分析/诊断工具。
- **原生主题单文件 MCP App UI**（[`src/ui/`](./src/ui/app.js)）：基于 `@modelcontextprotocol/ext-apps` 打包为 694.1 KB 自包含页面，实现无白底同色系分层、设置强调色跟随、4 个无障碍标签页、隐私脱敏切换及侧边栏一键发送 `/compact`。
- **原生插件打包与自动化校验体系**（[`build.mjs`](./build.mjs), [`test/verify.mjs`](./test/verify.mjs), [`skills/telemetry/SKILL.md`](./skills/telemetry/SKILL.md)）：支持一键单文件打包、零 `node_modules` 热部署与端到端回归测试。

### Security & Fixed
- **校准 Protobuf 时延字段映射**（`scripts/sqlite-reader.mjs`）：经真实库交叉验证，修正 `genInfo.11` 为首字延迟（`ttftSec`）、`genInfo.12` 为流式生成耗时（`streamSec`），确保 `latencySec = ttftSec + streamSec` 物理关系准确。
