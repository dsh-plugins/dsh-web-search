
# dsh-web-search

[简体中文](README.zh_CN.md)

`browser_web_search` and `browser_web_fetch` use a local browser for engine-specific search, rendered pages, and optional site session reuse.

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

DSH's official `web_search` and `web_fetch` are available alongside these tools. Update automation that previously called the plugin under the official names to use the browser tool names.

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
