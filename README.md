
# dsh-web-search

[简体中文](README.zh_CN.md)

`browser_web_search`, `browser_web_fetch` and `browser_web_open` use a local browser for engine-specific search, rendered pages, and optional site session reuse, with companion `web_browser_*` tools for continued page interaction.

## Installation

Install a compatible `dsh-loader` and this bundle in the same DSH profile. For example:

```sh
dsh plugin --profile desktop add @dsh-plugin/dsh-loader@2.0.0-dev.41617773595
dsh plugin --profile desktop add @dsh-plugin/dsh-web-search
```

Restart the instance after installation. If pnpm 11 reports `ERR_PNPM_IGNORED_BUILDS` for `esbuild`, set `allowBuilds.esbuild` to the boolean `true` in that profile's `pnpm-workspace.yaml` and retry.

## Tools

| Tool | Parameters and behavior |
| --- | --- |
| `browser_web_search` | Accepts `query` and optional `engine` (`bing`, `baidu`, `sogou`, `google`). Extracts organic results directly and verifies destination hosts for a simple single-domain `site:` restriction. Model summaries are opt-in. |
| `browser_web_fetch` | Accepts an HTTP(S) `url` and optional `mode`. The default `model` mode returns Markdown. The `text` mode extracts visible body text directly. |
| `browser_web_open` | Opens an HTTP(S) page and returns a handle `id`; `timeout` (seconds, default 600, max 86400, `0` closes the page immediately) is the idle retention: the page closes automatically once no `web_browser_*` operation touches it for that long, and every operation resets the timer. |
| `web_browser_read` | Reads a retained page by `id`; `format` is `text` (default, plain text) or `dom` (raw HTML). |
| `web_browser_click` / `web_browser_type` / `web_browser_press` / `web_browser_scroll` / `web_browser_navigate` / `web_browser_back` | Click, type, press keys, scroll, navigate, and go back on the retained page given by `id`. |

`browser_web_search` and `browser_web_fetch` accept the same `timeout` (seconds): above `0` the results page or fetched page stays open after the call and the result carries a `pageId`, so both the main conversation and subagents can keep operating that page with the `web_browser_*` tools; `0` closes the page when the call ends. Delegated page-operation subagents receive their page's `pageId` automatically.

DSH's official `web_search` and `web_fetch` are shadowed by default while the corresponding browser tool is enabled: a per-agent same-name registration answers with a redirect hint and the official prompt sections are removed. The "Disable official web_search" / "Disable official web_fetch" settings turn this off per tool so both variants coexist. Update automation that previously called the plugin under the official names to use the browser tool names.

Search returns the actual engine, attempt history, and a status of `ok`, `no_results`, `blocked`, `timeout`, or `error`. Fetch uses `no_content` for an empty page. See `reason` for failure details. An optional fallback engine runs once after a blocked, timed-out, or empty search if the call omitted `engine`. A per-engine budget of `0` uses the browser navigation timeout.

## Settings

Saving settings on the plugin detail page applies them to later calls. Settings are stored in `<profile>/config/dsh-web-search/config.json`. Reload the plugin or restart the instance after editing that file by hand. Use `cordis.patch.yml` for plugin composition.

- **Browser.** Automatic selection tries local Chrome, Edge, managed Chromium, Firefox, and WebKit. An absolute browser executable path overrides auto detection. The settings page includes a browser probe.
- **Model.** The caller's model is used when no analysis model is selected. Ordinary page interaction allows three delegated rounds by default. Set the limit to `0` to disable delegation or `-1` to rely on the tool timeout and page progress.
- **Dedicated browser directory.** Each call normally uses a temporary context. To reuse site logins, set an absolute path to an empty or new directory for the plugin to initialize. Conversations in the same DSH profile share the directory's cookies. Each call owns its own tab.
- **Manual verification.** Challenge pages return `blocked` by default. To verify in the browser, set a dedicated directory, turn off headless mode, and set a positive verification wait. The site determines whether the challenge passes.
- **Cache.** Successful, publicly cacheable responses that set no cookies may be reused for up to 60 seconds in the same session when using temporary contexts. Saving settings clears the cache.

## Development

```sh
npm install
npm run typecheck
npm test
npm pack --dry-run
```

To include real-browser regression tests, set `DSH_WEB_SEARCH_TEST_BROWSER` to a local Chromium, Chrome, or Edge executable before running `npm test`.

LGPL-3.0-only
