
# dsh-web-search

[English](README.md)

通过本机浏览器提供 `browser_web_search` 和 `browser_web_fetch`，适用于需要指定搜索引擎、渲染网页或复用站点会话的场景。

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

DSH 官方 `web_search` 和 `web_fetch` 与浏览器版同时可用。此前调用插件版同名工具的自动化需要改用新的工具名。

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
