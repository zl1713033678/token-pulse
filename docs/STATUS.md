# Token Pulse 当前工程状态快照 (Single Source of Truth)

> **最后更新**：`2026-11-26` ｜ **当前基线**：`v1.1.0` ｜ **版本库**：`main (已同步 origin/main · zl1713033678/token-pulse)` ｜ **自动化测试**：`npm run verify (4/4 PASS · 含前端全按钮运行时交互模拟) + verify_docs.py PASS`
> **维护规则**：本文件采用**覆写式更新**（上限 80 行），始终真实反映当下代码库的成熟度边界与下一步焦点。

---

## 1. 模块成熟度真伪矩阵 (Truth Matrix)

> **成熟度定义**：`L1 [Demo模拟]` ｜ `L1.5 [混合原型]` ｜ `L2 [真实逻辑闭环]` ｜ `L3 [自动化测试与并发锁加固]` ｜ `L4 [生产就绪]`

| 模块 | 等级 | 已真实落地并验证的能力 (Real & Verified) | 仍属演示模拟或待补齐缺口 (Mock / Gap) |
| :--- | :---: | :--- | :--- |
| `scripts/sqlite-reader.mjs` | **L3** | 只读 `node:sqlite` + 64位 Protobuf 解析 + stat 缓存；支持 `Carbon/Neon/Argon` 识别、步数、实时 `tok/s`、子代理归集、5h 滑窗回血倒计时与自然周分模型池统计 | 无 Mock；官方云端配额百分比未落盘至 SQLite，本模块严格只展示本地真实消耗与滑窗回血时间 |
| `scripts/server.mjs` | **L3** | 零依赖 Stdio MCP Server，`live`/`trends` 双视图入口（向后兼容旧 `tab` 参数），`app` 私有工具隔离；Stdio JSON-RPC 全链路实测通过 | 无 Mock；采用前端可见态指纹比对轮询与手动刷新模式 |
| `src/ui/` (`dashboard.html`) | **L3** | 零重叠双视图（`实时`/`趋势`）、置顶会话切换、高密度状态条、直出上下文拆解与 `/compact` 命令提醒、分池额度台账、`@container` 容器查询、全宽自动换行无省略截断、单调请求序号防并发乱序及全按钮运行时交互回归校验 | 已通过 `node:vm` 全按钮点击/折叠/乱序响应测试与 CSS 图层隔离/防截断静态门禁；暂缺真实像素截图对比回归 |
| `build.mjs` & 插件部署 | **L3** | `esbuild` 单文件打包与 Windows 原位安全热覆盖部署至 `~/.gemini/config/plugins/token-pulse/`（规避宿主占用目录 CWD 时的 `EPERM`） | 默认部署路径指向当前本机用户目录；跨平台独立分发脚本待按需补充 |

---

## 2. 质量、底座与孵化池状态

- **数据与运行底座**：`Node.js v24.19.0` 原生运行，`dist/ui/dashboard.html`（`700.3 KB`）远低于 10 MiB 限制，单次工具返回远低于 1 MiB。
- **活跃缺陷单**：`S0 = 0`、`S1 = 0`、`S2 = 0`、`S3 = 0`（`BUG-001`、`BUG-002` 已验证闭环归档，详见 [`docs/BUGS.md`](./BUGS.md)）。
- **特性孵化池**：`SPEC-001` 已于 `2026-11-26` 完成落地，当前 `0` 项处于 `PLANNED` 待命态（详见 [`docs/specs/README.md`](./specs/README.md)）。

---

## 3. 下一步高优行动清单 (Next 3 Priorities)

1. **[P1 真机交互验收]**：关闭旧侧边栏标签后重新打开 **Token Pulse**，核验「实时」页轮次明细折叠与「趋势」页 `7/14/30天`、钻取维度切换手感。
2. **[P2 像素级回归（按需）]**：如需进一步加固，可补充真实宿主侧栏窄/宽宽度截图对比，校验文本换行与卡片布局。
3. **[按需特性孵化]**：若后续 Antigravity 将官方配额元数据落盘至本地 SQLite，先在 [`docs/specs/README.md`](./specs/README.md) 登记设计再扩展解析器。
