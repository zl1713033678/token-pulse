# Token Pulse 当前工程状态快照 (Single Source of Truth)

> **最后更新**：`2026-11-23` ｜ **当前基线**：`v1.0.0` ｜ **版本库**：`main (已同步至 GitHub 公开仓库 zl1713033678/token-pulse)` ｜ **自动化测试**：`npm run verify (3/3 PASS) + GetAllPlugins 实时发现通过`
> **维护规则**：本文件采用**覆写式更新**（上限 80 行），始终真实反映当下代码库的成熟度边界与下一步焦点。

---

## 1. 模块成熟度真伪矩阵 (Truth Matrix)

> **成熟度定义**：`L1 [Demo模拟]` ｜ `L1.5 [混合原型]` ｜ `L2 [真实逻辑闭环]` ｜ `L3 [自动化测试与并发锁加固]` ｜ `L4 [生产就绪]`

| 模块 | 等级 | 已真实落地并验证的能力 (Real & Verified) | 仍属演示模拟或待补齐缺口 (Mock / Gap) |
| :--- | :---: | :--- | :--- |
| `scripts/sqlite-reader.mjs` | **L3** | 只读 `node:sqlite` + 64位安全 Protobuf 解析器 + stat 缓存；实测解析本机 84 个会话库（0 错误），动态读取模型上下文上限及 TTFT/流耗时 | 无 Mock；Protobuf 字段编号强绑定当前 Antigravity 存储格式，若上游升级字段需补样本回归用例 |
| `scripts/server.mjs` | **L3** | 零依赖 Stdio MCP Server，`aux_pane` + `global` 双入口，`app` 私有工具权限隔离；已通过实时 Stdio JSON-RPC 客户端全流程校验 | 无 Mock；采用 UI 轮询/手动刷新模式，尚未加入基于文件监听的增量推送 |
| `src/ui/` (`dashboard.html`) | **L2** | 基于 `@modelcontextprotocol/ext-apps` 打包为 694.1 KB 单文件 HTML；4 无障碍标签页、宿主主题/强调色联动及 `/compact` 原生发消息闭环；静态合规检查全过 | 静态规则与消息协议已校验，暂缺无头浏览器渲染截图回归测试 |
| `build.mjs` & 插件部署 | **L3** | `esbuild` 打包与零 `node_modules` 部署至 `~/.gemini/config/plugins/token-pulse/`，经本机 `GetAllPlugins` RPC 实测热发现生效 | 默认部署路径按当前本机用户目录写入；跨平台打包分发说明待按需补充 |

---

## 2. 质量、底座与孵化池状态

- **数据与运行底座**：`Node.js v24.19.0` 原生运行，`dist/ui/dashboard.html` 体积 `694.1 KB`（远低于 10 MiB 限制），单次工具返回远低于 1 MiB。
- **活跃缺陷单**：`S0 = 0`、`S1 = 0`、`S2 = 0`、`S3 = 0`（详见 [`docs/BUGS.md`](./BUGS.md)）。
- **待孵化特性池**：共 `0` 项处于 `📝 PLANNED` 待命态（详见 [`docs/specs/README.md`](./specs/README.md)）。

---

## 3. 下一步高优行动清单 (Next 3 Priorities)

1. **[P1 真机体验验收]**：在 Antigravity 客户端侧边栏实际打开 **Token Pulse**，核验深/浅/护眼主题与设置强调色切换下的视觉对比度及 `/compact` 触发手感。
2. **[P2 实时推送评估]**：评估是否按需增加本地会话文件监听通知以降低轮询延迟。
3. **[按需特性孵化]**：若后续上游 Protobuf 字段新增（如官方配额字段落盘），先在 [`docs/specs/README.md`](./specs/README.md) 登记设计再扩展解析器。
