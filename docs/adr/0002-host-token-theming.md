# ADR-0002：继承宿主 CSS 变量与无白底透明层级主题体系

- **状态**：已采纳（Accepted）
- **日期**：2026-11-23
- **关联代码**：[`src/ui/template.html`](../../src/ui/template.html), [`src/ui/styles.css`](../../src/ui/styles.css), [`src/ui/app.js`](../../src/ui/app.js)

## 1. 背景与问题（Context）

在 Antigravity 护眼暖色、浅色或深色主题下，传统外置卡片若硬编码 `#fff` / `#f5f5f5` 白色背景，会在侧边栏中产生刺眼的“白块割裂感”，且无法响应宿主设置中的强调色与实时明/暗模式切换。

## 2. 核心决策（Decision）

1. **完全继承宿主画布与语义变量**：使用 `@modelcontextprotocol/ext-apps` SDK 监听 `onhostcontextchanged`，同步执行 `applyDocumentTheme`、`applyHostStyleVariables`、`applyHostFonts` 及 `document.documentElement.style.colorScheme = ctx.theme`。
2. **同色系半透明层替代硬编码白底**：页面底色固定取 `var(--color-background-primary, transparent)`；卡片、分段标签轨道与激活标签 pill 统一用 `color-mix(in oklab, var(--color-text-primary, CanvasText) X%, transparent)` 搭配 `var(--color-border-secondary)` 细边框生成自适应层深。
3. **严格规避浏览器已知坑**：
   - 混合中性色时禁用 `in oklch`（避免 Chromium 565837690 低彩度偏洋红 bug），统一用 `in oklab`；
   - 主强调色绑定 `var(--color-ring-primary, var(--color-text-info, AccentColor))`；
   - 激活标签同时使用底栏 `border-block-end` 形状提示与 `@media (forced-colors: active)` 高对比度边框，不单靠颜色区分状态。

## 3. 后果与权衡（Consequences）

- **收益**：在浅色、深色、护眼米黄与 Windows 高对比度模式下自动融入侧边栏，零主题维护包袱。
- **代价与约束**：构建产物内所有自定义表面色均依赖宿主注入或前景色混合推导，代码审查与 `test/verify.mjs` 会强制拦截任何新增的白色硬编码背景与 `in oklch` 表达式。
