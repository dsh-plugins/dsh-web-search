/**
 * 插件配置：config-api 模板类型、运行时校验与冻结快照。
 *
 * 配置由 `ctx.dshLoader.config.register` 持久化到 `<profile>/config/dsh-web-search/config.json`，
 * 表单由 loader 统一渲染；本模块只负责把不受信任的快照解析成冻结的运行时形态。
 *
 * @module dsh-web-search/config
 */
import type { ConfigModelValue } from '@dsh-plugin/dsh-loader/config';
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
  }
  return value;
}

/** Cordis 插件名 / npm 包名，用于日志定位与消息来源标记。 */
export const PLUGIN_NAME = '@dsh-plugin/dsh-web-search';

/** 配置目录与文件名前缀使用的稳定短 id。 */
export const PLUGIN_ID = 'dsh-web-search';

export const SEARCH_ENGINES = ['baidu', 'sogou', 'bing', 'google'] as const;
export type SearchEngine = (typeof SEARCH_ENGINES)[number];
export const FETCH_MODES = ['model', 'text'] as const;
export type FetchMode = (typeof FETCH_MODES)[number];

export const BROWSER_KINDS = ['auto', 'chromium', 'firefox', 'webkit'] as const;
export type BrowserKind = (typeof BROWSER_KINDS)[number];

export const DEFAULT_SEARCH_TIMEOUT_MS = 120000;
export const DEFAULT_FETCH_TIMEOUT_MS = 120000;
export const DEFAULT_MAX_RESULTS = 10;
export const DEFAULT_MAX_MARKDOWN_CHARS = 100000;
export const DEFAULT_MAX_TOKENS = 38400;
export const DEFAULT_MAX_HTML_CHARS = 200000;
export const DEFAULT_SETTLE_MS = 1500;
export const DEFAULT_LAUNCH_TIMEOUT_MS = 30000;
export const DEFAULT_NAVIGATION_TIMEOUT_MS = 45000;
export const DEFAULT_MAX_SUBAGENT_ROUNDS = 3;
export const MAX_TIMER_DELAY_MS = 2147483647;

/** 已解析的模型路由（provider + model + 可选推理等级）。 */
export interface ResolvedModelRoute {
  readonly provider: string;
  readonly model: string;
  readonly reasoningEffort?: string;
}

/** config-api 表单持久化的原始值。 */
export interface PluginConfig {
  search: {
    enabled: boolean;
    engine: SearchEngine;
    fallbackEngine: SearchEngine | 'none';
    engineTimeoutMs: Partial<Record<SearchEngine, number>>;
    summarize: boolean;
    maxResults: number;
    timeoutMs: number;
  };
  fetch: {
    enabled: boolean;
    mode: FetchMode;
    timeoutMs: number;
    maxMarkdownChars: number;
  };
  browser: {
    kind: BrowserKind;
    executablePath: string;
    headless: boolean;
    persistentProfileDir: string;
    challengeWaitMs: number;
    settleMs: number;
    launchTimeoutMs: number;
    navigationTimeoutMs: number;
  };
  analysis: {
    selection: ConfigModelValue | null;
    maxTokens: number;
    maxHtmlChars: number;
  };
  subagent: {
    enabled: boolean;
    selection: ConfigModelValue | null;
    maxRounds: number;
  };
}

/** 冻结后的运行时配置快照。 */
export interface ResolvedPluginConfig {
  readonly search: {
    readonly enabled: boolean;
    readonly engine: SearchEngine;
    readonly fallbackEngine: SearchEngine | undefined;
    readonly engineTimeoutMs: Readonly<Record<SearchEngine, number>>;
    readonly summarize: boolean;
    readonly maxResults: number;
    readonly timeoutMs: number;
  };
  readonly fetch: {
    readonly enabled: boolean;
    readonly mode: FetchMode;
    readonly timeoutMs: number;
    readonly maxMarkdownChars: number;
  };
  readonly browser: {
    readonly kind: BrowserKind;
    readonly executablePath: string;
    readonly headless: boolean;
    readonly persistentProfileDir: string;
    readonly challengeWaitMs: number;
    readonly settleMs: number;
    readonly launchTimeoutMs: number;
    readonly navigationTimeoutMs: number;
  };
  readonly analysis: {
    readonly route: ResolvedModelRoute | undefined;
    readonly maxTokens: number;
    readonly maxHtmlChars: number;
  };
  readonly subagent: {
    readonly enabled: boolean;
    readonly route: ResolvedModelRoute | undefined;
    readonly maxRounds: number;
  };
}

function isEngine(value: unknown): value is SearchEngine {
  return typeof value === 'string' && (SEARCH_ENGINES as readonly string[]).includes(value);
}

function isBrowserKind(value: unknown): value is BrowserKind {
  return typeof value === 'string' && (BROWSER_KINDS as readonly string[]).includes(value);
}

function intInRange(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

/** 把模型选择器值解析为路由；未选择时返回 undefined。 */
export function routeOf(selection: ConfigModelValue | null | undefined): ResolvedModelRoute | undefined {
  if (selection === null || selection === undefined) return undefined;
  if (typeof selection.provider !== 'string' || selection.provider.length === 0) return undefined;
  if (typeof selection.model !== 'string' || selection.model.length === 0) return undefined;
  const route: { provider: string; model: string; reasoningEffort?: string } = {
    provider: selection.provider,
    model: selection.model,
  };
  if (typeof selection.reasoningEffort === 'string' && selection.reasoningEffort.length > 0) {
    route.reasoningEffort = selection.reasoningEffort;
  }
  return route;
}

/** 解析并冻结一份不受信任的配置快照；非法取值回退到默认值而不是拒绝加载。 */
export function resolvePluginConfig(config: { [K in keyof PluginConfig]?: Partial<PluginConfig[K]> } | undefined): ResolvedPluginConfig {
  const search = config?.search ?? {};
  const fetchCfg = config?.fetch ?? {};
  const browser = config?.browser ?? {};
  const analysis = config?.analysis ?? {};
  const subagent = config?.subagent ?? {};

  const engineTimeout = (engine: SearchEngine): number =>
    intInRange(search.engineTimeoutMs?.[engine], 0, 0, MAX_TIMER_DELAY_MS);

  return deepFreeze<ResolvedPluginConfig>({
    search: {
      enabled: search.enabled ?? true,
      engine: isEngine(search.engine) ? search.engine : 'bing',
      fallbackEngine: isEngine(search.fallbackEngine) ? search.fallbackEngine : undefined,
      engineTimeoutMs: {
        baidu: engineTimeout('baidu'),
        sogou: engineTimeout('sogou'),
        bing: engineTimeout('bing'),
        google: engineTimeout('google'),
      },
      summarize: search.summarize === true,
      maxResults: intInRange(search.maxResults, DEFAULT_MAX_RESULTS, 1, 50),
      timeoutMs: intInRange(search.timeoutMs, DEFAULT_SEARCH_TIMEOUT_MS, 1000, MAX_TIMER_DELAY_MS),
    },
    fetch: {
      enabled: fetchCfg.enabled ?? true,
      mode: fetchCfg.mode === 'text' ? 'text' : 'model',
      timeoutMs: intInRange(fetchCfg.timeoutMs, DEFAULT_FETCH_TIMEOUT_MS, 1000, MAX_TIMER_DELAY_MS),
      maxMarkdownChars: intInRange(fetchCfg.maxMarkdownChars, DEFAULT_MAX_MARKDOWN_CHARS, 1000, 2000000),
    },
    browser: {
      kind: isBrowserKind(browser.kind) ? browser.kind : 'auto',
      executablePath: typeof browser.executablePath === 'string' ? browser.executablePath.trim() : '',
      headless: browser.headless ?? true,
      persistentProfileDir: typeof browser.persistentProfileDir === 'string' ? browser.persistentProfileDir.trim() : '',
      challengeWaitMs: intInRange(browser.challengeWaitMs, 0, 0, 120000),
      settleMs: intInRange(browser.settleMs, DEFAULT_SETTLE_MS, 0, 30000),
      launchTimeoutMs: intInRange(browser.launchTimeoutMs, DEFAULT_LAUNCH_TIMEOUT_MS, 1000, 300000),
      navigationTimeoutMs: intInRange(browser.navigationTimeoutMs, DEFAULT_NAVIGATION_TIMEOUT_MS, 1000, 300000),
    },
    analysis: {
      route: routeOf(analysis.selection),
      maxTokens: intInRange(analysis.maxTokens, DEFAULT_MAX_TOKENS, 256, 200000),
      maxHtmlChars: intInRange(analysis.maxHtmlChars, DEFAULT_MAX_HTML_CHARS, 2000, 2000000),
    },
    subagent: {
      enabled: subagent.enabled ?? true,
      route: routeOf(subagent.selection),
      // -1 表示不限制轮数；其余取值裁剪到 [0, 100]。
      maxRounds: subagent.maxRounds === -1 ? -1 : intInRange(subagent.maxRounds, DEFAULT_MAX_SUBAGENT_ROUNDS, 0, 100),
    },
  });
}
