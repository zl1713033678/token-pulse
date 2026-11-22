# Token Pulse · Antigravity 原生侧边栏遥测插件

纯本地、零额外模型 Token 消耗的 Antigravity 原生 MCP App 插件：在右侧边栏（`aux_pane`）或全局视图（`global`）实时监测上下文窗口占用、Prompt Cache 命中率、TTFT/总耗时、5 小时滚动消耗节奏及多日模型/项目/会话分析。**完全移除第三方工具抓取、进程端口扫描与虚拟 API 成本估算。**

## 1. 核心架构与模块速览

- **只读本地数据采集 ([`scripts/sqlite-reader.mjs`](./scripts/sqlite-reader.mjs))**：基于 Node.js 内置 `node:sqlite` 与零依赖 Protobuf 解析器，只读扫描 `antigravity/conversations/*.db`、`conversation_summaries.db` 与 `antigravity-cli/conversations/*.db`。
- **零依赖 Stdio MCP Server ([`scripts/server.mjs`](./scripts/server.mjs))**：暴露 `open_telemetry_panel`（挂载 `aux_pane` 与 `global` 入口指向 `ui://token-pulse/dashboard`）及 3 个仅 UI 内部可见的 `visibility: ["app"]` 数据工具。
- **原生主题单文件 UI ([`src/ui/`](./src/ui/app.js))**：基于 `@modelcontextprotocol/ext-apps` 构建，继承宿主 `--color-background-primary` 与 `--color-ring-primary` 强调色，支持 4 个无障碍标签页与侧边栏一键发送 `/compact`。

## 2. 技术栈与快速启动

- **运行时**：Antigravity 内置 Node.js（验证于 `v24.19.0` + `node:sqlite`），部署产物零 `node_modules`。
- **构建与UI**：`@modelcontextprotocol/ext-apps` + `esbuild` 单文件打包（输出 < 1 MiB）。

```bash
# 安装构建依赖（缓存路由至 D 盘）
npm install --cache D:\Cache\npm-cache

# 打包单文件 UI 并同步精简运行包到 ~/.gemini/config/plugins/token-pulse/
npm run build

# 运行本地数据库解析、原生主题静态扫描与 Stdio MCP 全链路回归校验
npm run verify
```

## 3. 环境变量配置速查

| 环境变量 | 默认值 | 说明 |
| :--- | :--- | :--- |
| `TOKEN_PULSE_UI_HTML` | `../ui/dashboard.html` | 开发调试时指向未打包/热更新的 HTML 路径 |
| `ANTIGRAVITY_GEMINI_DIR` | `~/.gemini` | 覆盖本地 Antigravity 会话库根目录 |
| `ANTIGRAVITY_CONVERSATION_ID` | *(宿主注入)* | 自动锁定当前活跃对话的上下文窗口 |

## 4. 项目文档导航地图

| 文档路径 | 用途与目标读者 |
| :--- | :--- |
| [`AGENTS.md`](./AGENTS.md) | **研发与 AI 协作宪章**：硬红线、Proto 实测约束与必跑验证门禁 |
| [`docs/STATUS.md`](./docs/STATUS.md) | **实时状态快照**：模块成熟度真伪矩阵（L1~L4）与下一步高优行动 |
| [`docs/BUGS.md`](./docs/BUGS.md) | **活跃缺陷台账**：当前未修复的 S0~S3 缺陷与精确代码坐标 |
| [`docs/adr/`](./docs/adr/0001-native-plugin-local-sqlite.md) | **架构决策记录 (ADR)**：本地只读采集与宿主原生主题适配决策 |
| [`docs/specs/`](./docs/specs/README.md) | **特性孵化器 (Specs)**：待开发特性的设计台账（未经指令不写代码） |
| [`CHANGELOG.md`](./CHANGELOG.md) | **版本演进归档**：已完成里程碑与已闭环修复记录 |
