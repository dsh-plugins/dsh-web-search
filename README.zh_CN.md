# dsh-web-search

[English](README.md)

为 DeepSeek Harness 提供基于真实浏览器的 `web_search` 与 `web_fetch` 工具：页面在本机浏览器（Chromium / Firefox / WebKit，由 Playwright 驱动）中打开，加载完成后抓取清理过的 HTML，交由配置的模型分析，分别返回结构化搜索结果与正文 Markdown。当页面需要点击等交互（验证码按钮、Cookie 弹窗、分页）时，可派出一次性子代理使用 `web_browser_*` 工具操作页面。

## 安装

```sh
dsh plugin --profile web add @dsh-plugin/dsh-web-search
```

本插件是 Bundle 包：安装时自动应用 `cordis.patch.yml`。安装后重启实例生效。

## 功能

| 功能 | 说明 |
| --- | --- |
| `web_search` | 在真实浏览器中打开 百度 / 搜狗 / Bing / Google 的结果页，返回结构化结果（标题 / 链接 / 摘要）与可选的整体概括。 |
| `web_fetch` | 在真实浏览器中打开指定 URL，把正文转换为 Markdown 返回。 |
| 浏览器自动搜索 | 依次尝试本机 Chrome → Edge → Playwright 托管 Chromium，以及 Playwright 托管的 Firefox 与 WebKit；也可直接配置浏览器可执行文件路径。 |
| 分工具启用 | 两个工具可独立启用；启用期间官方同名工具在每个 Agent 作用域内被同名注册遮蔽，其官方提示词节同时被隐藏。 |
| 子代理页面交互 | 分析模型判断页面需要交互时，子代理通过 `web_browser_click` / `web_browser_type` / `web_browser_press` / `web_browser_scroll` / `web_browser_navigate` / `web_browser_back` / `web_browser_read` 操作同一页面，随后重新分析（轮数有上限）。 |
| 诊断 | 设置卡片内置「检测浏览器」操作，真实尝试启动并报告各候选的结果。 |

## 配置

打开插件详情页的配置卡片。所有配置保存后对后续调用生效，无需重启。

- **网页搜索**：启用 `web_search`、默认搜索引擎、结果数量上限、整体超时。
- **网页抓取**：启用 `web_fetch`、整体超时、Markdown 输出上限。
- **浏览器**：内核类型（自动 / Chromium / Firefox / WebKit）、自定义可执行文件路径、无头模式、加载静置 / 导航 / 启动超时。
- **分析模型**：分析页面 HTML 的模型；留空时使用发起调用的会话自身的模型。
- **子代理页面操作**：是否允许分析模型请求页面交互、可选的子代理专用模型、交互轮数上限（0 表示不派出子代理）。

### 浏览器解析顺序

1. **自定义路径**（`browser.executablePath`）：原样使用；`kind: auto` 时依次按 Chromium、Firefox、WebKit 启动器尝试该路径。
2. **Chromium**：本机 Chrome（channel: chrome）→ 本机 Edge（channel: msedge）→ Playwright 托管 Chromium → 常见安装路径。
3. **Firefox / WebKit**：Playwright 托管版本（可用 `npx playwright install firefox webkit` 安装）→ 常见安装路径。注意：官方版 Firefox 缺少 Playwright 的自动化协议，通常无法驱动；Safari 本体不可自动化，请使用 Playwright 的 WebKit。

## 工作原理

```
web_search(query, engine?)
  → 启动/复用本机浏览器 → 打开搜索结果页 → 等待 load + 静置
  → 抓取清理后的 HTML（移除脚本/样式/冗余属性）
  → 分析模型 → {"status":"ok", results:[...]} 或 {"status":"interact", task:"..."}
  → interact 时：派出一次性子代理（spawn 提供方）→ 子代理用 web_browser_* 工具
    操作页面 → 重新抓取 → 重新分析（最多 maxRounds 轮）
```

官方 `web_search` / `web_fetch` 由 `dsh-base` 先于本插件全局注册，同名全局注册会被拒绝；因此本插件在 `agent/created` 时把同名工具注册进每个 Agent 的作用域——这是 dsh 官方支持的遮蔽通道——模型只会看到并调用本插件的实现，官方提示词节也在提示词装配时被过滤。

## 开发

```sh
npm install
npm run typecheck
npm test
```

运行时代码不对 `@deepseek-ai/*` 做值导入；宿主符号（`defineTool`、`deadline`、`createUserMessage`、`BlockAssembler`）一律经 `ctx.dshLoader` 门面解析，`import type` 仅用于编译期类型保真。

## 许可证

LGPL-3.0-only
