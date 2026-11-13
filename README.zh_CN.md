
# dsh-web-search

[English](README.md)

通过本机浏览器提供 `browser_web_search`、`browser_web_fetch` 与 `browser_web_open`，以及配套的 `web_browser_*` 页面操作工具，适用于需要指定搜索引擎、渲染网页或复用站点会话的场景。

## 安装

在同一个 DSH profile 先安装兼容的 `dsh-loader`，再安装本插件。例如在 `desktop` profile 上执行：

```sh
dsh plugin --profile desktop add @dsh-plugin/dsh-loader@2.0.0-dev.41617773595
dsh plugin --profile desktop add @dsh-plugin/dsh-web-search
```

本插件是 Bundle，安装时自动应用 `cordis.patch.yml`。安装后重启对应实例。若 pnpm 11 报 `ERR_PNPM_IGNORED_BUILDS` 并提示 `esbuild` 待审批，在该 profile 的 `pnpm-workspace.yaml` 中将 `allowBuilds.esbuild` 设置为布尔值 `true` 后重试。

## 工具

| 工具 | 参数与行为 |
| --- | --- |
| `browser_web_search` | 接受 `query` 和可选的 `engine`（`bing`、`baidu`、`sogou`、`google`）。直接提取自然搜索结果，对明确的单域名 `site:` 限定校验落地域名。设置中可开启模型摘要。 |
| `browser_web_fetch` | 接受 HTTP(S) `url` 和可选的 `mode`。默认 `model` 整理 Markdown，`text` 直接提取可见正文。 |
| `browser_web_open` | 打开一个 HTTP(S) 页面并返回句柄 `id`；`timeout`（秒，默认 600，上限 86400，`0` 表示打开后立即关闭）是空闲保留时长：在该时间内没有任何 `web_browser_*` 操作时浏览器页面自动关闭，每次操作都会重置计时。 |
| `web_browser_read` | 传入页面 `id` 读取页面地址、标题与内容；`format` 为 `text`（默认，纯文本）或 `dom`（原始 HTML）。 |
| `web_browser_click` / `web_browser_type` / `web_browser_press` / `web_browser_scroll` / `web_browser_navigate` / `web_browser_back` | 传入页面 `id` 后分别执行点击、输入、按键、滚动、跳转与后退。 |

`browser_web_search` 与 `browser_web_fetch` 也接受 `timeout`（秒，语义同上）：大于 `0` 时搜索结果页或抓取页在调用结束后保持打开，返回值附带 `pageId`，主会话与子代理都可用 `web_browser_*` 工具继续操作同一页面；`0` 表示调用结束即关闭。页面操作子代理会自动收到所属页面的 `pageId`。

DSH 官方 `web_search` 和 `web_fetch` 默认在对应浏览器工具启用时被遮蔽：每个 Agent 作用域内的同名注册会返回改用提示，官方提示词节也会被移除。设置中的「禁用官方 web_search」「禁用官方 web_fetch」可分别关闭该行为，让官方工具与浏览器版共存。此前调用插件版同名工具的自动化需要改用新的工具名。

搜索状态包括 `ok`、`no_results`、`blocked`、`timeout` 和 `error`，并附实际引擎与尝试记录。抓取以 `no_content` 表示无可读正文。失败时查看 `reason`。明确启用备用引擎后，未指定引擎的搜索可在被拦截、超时或无结果时额外尝试一次。各引擎的单次预算设为 `0` 时使用浏览器导航超时。

## 配置

在插件详情页保存设置后，后续调用使用新值。插件配置保存在 `<profile>/config/dsh-web-search/config.json`，手动编辑后需重新加载插件或重启实例。`cordis.patch.yml` 用于插件装配。

- **浏览器**。默认依次尝试本机 Chrome、Edge、Playwright 托管 Chromium，随后尝试 Firefox 和 WebKit。也可指定浏览器可执行文件的绝对路径。设置页提供浏览器检测。
- **分析模型**。留空时沿用当前会话的模型。默认最多允许三轮普通页面交互，可设为 `0` 关闭，或设为 `-1` 仅受总超时和页面进展约束。
- **专用浏览器目录**。默认每次调用使用独立的临时上下文。要复用站点登录状态，请填写一个空目录或尚不存在的绝对路径，插件会初始化该目录。同一 DSH profile 的会话共享站点 Cookie，各调用使用自己的标签页。
- **人工验证**。默认遇到验证码或挑战页时直接返回 `blocked`。若要在浏览器内手动验证，请同时设置专用目录、关闭无头模式，并设置正数的人工验证等待时间。验证是否通过由站点决定。
- **缓存**。临时浏览器中允许公开缓存且未设置 Cookie 的成功结果，在同一会话内最多复用 60 秒。保存设置会清空缓存。

## 开发

```sh
npm install
npm run typecheck
npm test
npm pack --dry-run
```

真实浏览器回归测试可通过环境变量 `DSH_WEB_SEARCH_TEST_BROWSER` 指定本机 Chromium、Chrome 或 Edge 的可执行文件，再运行 `npm test`。

LGPL-3.0-only
