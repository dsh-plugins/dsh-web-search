# dsh-web-search

[中文文档](README.zh_CN.md)

Browser-backed `web_search` and `web_fetch` tools for DeepSeek Harness. Pages are opened in a real local browser (Chromium / Firefox / WebKit via Playwright); after the page loads, its cleaned HTML is analyzed by a configured model which returns structured search results or Markdown. When the page needs interaction (captcha buttons, cookie dialogs, pagination), a one-shot subagent can operate the page with the `web_browser_*` tools.

## Install

```sh
dsh plugin --profile web add @dsh-plugin/dsh-web-search
```

The plugin is a Bundle package: installation applies `cordis.patch.yml` automatically. Restart the instance after installing.

## Features

| Feature | Description |
| --- | --- |
| `web_search` | Opens the results page of 百度 / 搜狗 / Bing / Google in a real browser and returns structured results (`title` / `url` / `snippet`) plus an optional summary. |
| `web_fetch` | Opens a URL in a real browser and converts the main content to Markdown. |
| Browser auto-detection | Tries local Chrome → Edge → Playwright-managed Chromium, Playwright-managed Firefox and WebKit; a custom executable path can be configured. |
| Selective enablement | Each tool can be enabled independently; while enabled, the official same-named tool is shadowed per agent scope and its prompt section is hidden. |
| Subagent interaction | When the analysis model reports that the page needs interaction, a subagent operates the shared page via `web_browser_click` / `web_browser_type` / `web_browser_press` / `web_browser_scroll` / `web_browser_navigate` / `web_browser_back` / `web_browser_read`, then the page is re-analyzed (bounded by the round cap). |
| Diagnostics | The settings card includes a "检测浏览器" operation that actually launches the browser and reports what worked. |

## Configuration

Open the plugin's settings card (plugin detail page). All values apply to subsequent calls without a restart.

- **网页搜索**: enable `web_search`, default engine, max results, overall timeout.
- **网页抓取**: enable `web_fetch`, overall timeout, Markdown output cap.
- **浏览器**: engine kind (`auto` / `chromium` / `firefox` / `webkit`), custom executable path, headless mode, settle/navigation/launch timeouts.
- **分析模型**: the model that analyzes page HTML. When unset, the calling session's own model route is used.
- **子代理页面操作**: allow the analysis model to request page interaction; an optional dedicated subagent model; max interaction rounds.

### Browser resolution order

1. **Custom path** (`browser.executablePath`): used as-is; with `kind: auto` it is tried against the Chromium, Firefox, and WebKit launchers in turn.
2. **Chromium**: local Chrome (`channel: chrome`) → local Edge (`channel: msedge`) → Playwright-managed Chromium → common install paths.
3. **Firefox / WebKit**: Playwright-managed builds (install with `npx playwright install firefox webkit`) → common install paths. Note: a stock system Firefox lacks Playwright's automation protocol and usually cannot be driven; Safari itself is not automatable — use Playwright's WebKit.

## How it works

```
web_search(query, engine?)
  → launch/reuse local browser → open results page → wait for load + settle
  → capture cleaned HTML (scripts/styles/attributes stripped)
  → analysis model → {"status":"ok", results:[...]} or {"status":"interact", task:"..."}
  → on interact: spawn one-shot subagent (provider `spawn`) → it operates the page
    with web_browser_* tools → re-capture → re-analyze (up to maxRounds)
```

The official `web_search` / `web_fetch` are registered globally by `dsh-base` before this plugin loads, so duplicate global registration is impossible. This plugin instead registers its same-named tools in each agent's scope on `agent/created` — the officially supported shadowing channel — so models see and invoke only this implementation while the corresponding official prompt sections are filtered out of prompt assembly.

## Development

```sh
npm install
npm run typecheck
npm test
```

Runtime code never value-imports `@deepseek-ai/*`; host symbols (`defineTool`, `deadline`, `createUserMessage`, `BlockAssembler`) are resolved through the `ctx.dshLoader` facade. Type-only imports keep compile-time fidelity.

## License

LGPL-3.0-only
