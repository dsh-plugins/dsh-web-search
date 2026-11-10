
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { SubagentRuntime } from '@deepseek-ai/dsh-subagent';
import type {} from '@deepseek-ai/dsh-tools';
import type {} from '@deepseek-ai/dsh-llm';
import type {} from '@deepseek-ai/dsh-system-prompt';
import type { Page } from 'playwright-core';
import { BrowserProfileError, type BrowserManager } from './browser.js';
import { FETCH_MODES, SEARCH_ENGINES, type FetchMode, type ResolvedPluginConfig, type SearchEngine } from './config.js';
import type { DshFacade } from './dsh.js';
import { buildSearchUrl } from './engines.js';
import { captureSnapshot, captureText } from './html.js';
import { timeLeft, type PageNavigation, type PageObservation } from './navigation.js';
import { callerRouteOf, outcomeOf, parseJsonObject, resolveAnalysisRoute, runAnalysis } from './analyze.js';
import { buildFetchAnalysisPrompt, buildSearchSummaryPrompt } from './prompt.js';
import { searchResults, type SearchResult } from './search-results.js';
import { runPageSubagent } from './subagent.js';

const SEARCH_NAME = 'browser_web_search';
const FETCH_NAME = 'browser_web_fetch';
const SEARCH_STATUSES = ['ok', 'no_results', 'blocked', 'timeout', 'error'] as const;
const FETCH_STATUSES = ['ok', 'no_content', 'blocked', 'timeout', 'error'] as const;
const CACHE_TTL_MS = 60000;
const CACHE_CAPACITY = 64;
const CLEANUP_MS = 50;

type SearchStatus = (typeof SEARCH_STATUSES)[number];
type FetchStatus = (typeof FETCH_STATUSES)[number];
type Trace = (phase: string, status: string, started: number) => void;

interface Attempt {
  readonly engine: SearchEngine;
  readonly status: SearchStatus;
  readonly reason?: string;
}

interface SearchAttempt extends Attempt {
  readonly results: SearchResult[];
}

interface SearchValue extends SearchAttempt {
  readonly query: string;
  readonly attempts: Attempt[];
  readonly summary?: string;
}

interface FetchValue {
  readonly status: FetchStatus;
  readonly url: string;
  readonly title: string;
  readonly format: 'markdown' | 'text';
  readonly markdown?: string;
  readonly text?: string;
  readonly truncated?: boolean;
  readonly reason?: string;
}

interface ToolEnvironment {
  readonly ctx: Context;
  readonly facade: DshFacade;
  readonly manager: BrowserManager;
  readonly get: () => ResolvedPluginConfig;
  readonly subagents: () => SubagentRuntime | undefined;
}

type CachedValue = { kind: 'search'; value: SearchAttempt } | { kind: 'fetch'; value: FetchValue };

class ResultCache {
  private readonly entries = new Map<string, { expiresAt: number; value: CachedValue }>();

  get(key: string): CachedValue | undefined {
    const entry = this.entries.get(key);
    if (entry === undefined) {
      return undefined;
    }
    this.entries.delete(key);
    if (entry.expiresAt <= performance.now()) {
      return undefined;
    }
    this.entries.set(key, entry);
    return structuredClone(entry.value);
  }

  set(key: string, value: CachedValue, ttl: number): void {
    this.entries.delete(key);
    this.entries.set(key, { expiresAt: performance.now() + ttl, value: structuredClone(value) });
    if (this.entries.size > CACHE_CAPACITY) {
      const oldest = this.entries.keys().next();
      if (!oldest.done) {
        this.entries.delete(oldest.value);
      }
    }
  }

  clear(): void {
    this.entries.clear();
  }
}

function sessionIdOf(agent: Agent | undefined): string | undefined {
  return agent?.session?.id === undefined ? undefined : String(agent.session.id);
}

function tracing(ctx: Context, engine?: SearchEngine): Trace {
  return (phase, status, started) => {
    ctx.logger?.info?.('dsh-web-search phase=' + phase + ' engine=' + (engine ?? 'none')
      + ' status=' + status + ' elapsedMs=' + Math.round(performance.now() - started));
  };
}

async function timed<T>(trace: Trace, phase: string, operation: () => Promise<T>, status: (value: T) => string = () => 'ok'): Promise<T> {
  const started = performance.now();
  try {
    const result = await operation();
    trace(phase, status(result), started);
    return result;
  } catch (error) {
    trace(phase, 'error', started);
    throw error;
  }
}

async function analyze(
  env: ToolEnvironment,
  prompt: string,
  config: ResolvedPluginConfig,
  signal: AbortSignal,
  agent: Agent | undefined,
  trace: Trace,
) {
  const started = performance.now();
  return timed(trace, 'model', () => runAnalysis(
    env.ctx, env.facade, prompt, resolveAnalysisRoute(config, agent), config, signal, sessionIdOf(agent),
    () => trace('model_first_text', 'ok', started),
  ));
}

const ATTEMPT_FIELDS = {
  engine: { type: 'string', required: true },
  status: { type: 'string', enum: SEARCH_STATUSES, required: true },
  reason: { type: 'string' },
} as const;

const SEARCH_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ...ATTEMPT_FIELDS,
    query: { type: 'string', required: true },
    summary: { type: 'string' },
    attempts: {
      type: 'array', required: true,
      items: { type: 'object', additionalProperties: false, properties: ATTEMPT_FIELDS },
    },
    results: {
      type: 'array', required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: { title: { type: 'string', required: true }, url: { type: 'string', required: true }, snippet: { type: 'string', required: true } },
      },
    },
  },
} as const;

const FETCH_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    status: { type: 'string', enum: FETCH_STATUSES, required: true },
    url: { type: 'string', required: true },
    title: { type: 'string', required: true },
    format: { type: 'string', enum: ['markdown', 'text'], required: true },
    markdown: { type: 'string' },
    text: { type: 'string' },
    truncated: { type: 'boolean' },
    reason: { type: 'string' },
  },
} as const;

function renderSearch(value: SearchValue): string {
  const lines = [value.status + ' · ' + value.engine + (value.reason ? ' · ' + value.reason : '')];
  if (value.summary) {
    lines.push(value.summary);
  }
  for (const [index, item] of value.results.entries()) {
    lines.push((index + 1) + '. ' + item.title + ' <' + item.url + '>', item.snippet);
  }
  if (value.attempts.length > 1) {
    lines.push('尝试 ' + value.attempts.map(({ engine, status }) => engine + ' ' + status).join(' → '));
  }
  return lines.join('\n');
}

function renderFetch(value: FetchValue): string {
  const header = [value.status, value.title, value.url, value.reason].filter(Boolean).join('\n');
  return [header, value.markdown ?? value.text, value.truncated ? '正文已截断。' : undefined].filter(Boolean).join('\n\n');
}

async function searchAttempt(
  env: ToolEnvironment,
  cache: ResultCache,
  options: {
    config: ResolvedPluginConfig; agent?: Agent; engine: SearchEngine; query: string;
    timeout: number; signal: AbortSignal;
  },
): Promise<SearchAttempt> {
  const { config, agent, engine, query, timeout, signal } = options;
  signal.throwIfAborted();
  const trace = tracing(env.ctx, engine);
  const session = sessionIdOf(agent);
  const key = session !== undefined && !config.browser.persistentProfileDir
    ? JSON.stringify(['search', session, engine, query, config])
    : undefined;
  const cached = key === undefined ? undefined : cache.get(key);
  if (cached?.kind === 'search') {
    trace('cache', 'hit', performance.now());
    return cached.value;
  }
  if (timeout <= CLEANUP_MS) {
    return { engine, status: 'timeout', reason: '搜索时间预算已用完', results: [] };
  }

  const endsAt = performance.now() + timeout - CLEANUP_MS;
  using attempt = env.facade.dsh.timeout.deadline(signal, timeout, 'DSH_BROWSER_SEARCH_ATTEMPT');
  const started = performance.now();
  try {
    const result = await env.manager.withPage(config.browser, session, attempt.signal, async (_page, navigation, pageSignal) => {
      trace('page_open', 'ok', started);
      const observation = await timed(trace, 'navigation', () => navigation.open(
        buildSearchUrl(engine, query), config.browser, pageSignal, endsAt, engine,
      ), (value) => value.status);
      if (observation.status !== 'ready') {
        const status = observation.status === 'empty' ? 'no_results' : observation.status;
        return { engine, status, reason: observation.reason, results: [] } satisfies SearchAttempt;
      }
      const extractionStarted = performance.now();
      const results = searchResults(engine, query, observation.state.url, observation.state.candidates, config.search.maxResults);
      const status = results.length > 0 ? 'ok' : 'no_results';
      trace('extract', status, extractionStarted);
      const value: SearchAttempt = results.length > 0
        ? { engine, status, results }
        : { engine, status, reason: '没有符合查询约束的结果', results };
      if (key !== undefined && status === 'ok') {
        const ttl = await navigation.publicCacheTtl(observation.state, CACHE_TTL_MS);
        if (ttl > 0 && !pageSignal.aborted && env.get() === config) {
          cache.set(key, { kind: 'search', value }, ttl);
        }
      }
      pageSignal.throwIfAborted();
      return value;
    }, endsAt);
    trace('search_attempt', result.status, started);
    return result;
  } catch (error) {
    signal.throwIfAborted();
    const status = attempt.signal.aborted || timeLeft(endsAt) === 0 ? 'timeout' : 'error';
    trace('search_attempt', status, started);
    const reason = status === 'timeout' ? '搜索引擎尝试超时'
      : error instanceof BrowserProfileError ? error.message : '浏览器启动、导航或结果提取失败，可使用设置中的浏览器检测';
    return { engine, status, reason, results: [] };
  }
}

function buildSearchTool(env: ToolEnvironment, cache: ResultCache, timeoutMs: number) {
  return env.facade.dsh.tools.defineTool({
    name: SEARCH_NAME,
    description: 'Search with a local browser. Returns validated organic results and attempt status. Specify an engine to use it exclusively.',
    parameters: {
      query: { type: 'string', required: true, description: 'Complete search query, including any search operators.' },
      engine: { type: 'string', enum: SEARCH_ENGINES, description: 'Search engine to use.' },
    },
    output: {
      schema: SEARCH_OUTPUT,
      render: (_args, value) => [{ type: 'text', text: renderSearch(value as SearchValue) }],
      presentationMeta: (_args, value) => value,
    },
    timeoutMs,
    async execute(args, exec): Promise<SearchValue> {
      const config = env.get();
      const query = args.query.trim();
      if (!query) {
        throw new env.facade.dsh.tools.ToolArgsError([SEARCH_NAME + ': query 不能为空']);
      }
      const engine: SearchEngine = args.engine ?? config.search.engine;
      const fallback = args.engine === undefined && config.search.fallbackEngine !== engine ? config.search.fallbackEngine : undefined;
      const totalMs = Math.min(timeoutMs, config.search.timeoutMs);
      const endsAt = performance.now() + totalMs - CLEANUP_MS * 2;
      const run = (selected: SearchEngine, limit: number) => searchAttempt(env, cache, {
        config, agent: exec.agent, engine: selected, query, signal: exec.signal,
        timeout: Math.min(config.search.engineTimeoutMs[selected] || config.browser.navigationTimeoutMs, limit),
      });
      let result = await run(engine, fallback === undefined ? timeLeft(endsAt) : Math.floor(timeLeft(endsAt) / 2));
      const attempts = [result];
      if (fallback !== undefined && ['blocked', 'timeout', 'no_results'].includes(result.status) && timeLeft(endsAt) > CLEANUP_MS) {
        result = await timed(tracing(env.ctx, fallback), 'retry', () => run(fallback, timeLeft(endsAt)), (value) => value.status);
        attempts.push(result);
      }
      const value: SearchValue = {
        ...result, query, attempts: attempts.map(({ engine, status, reason }) => ({ engine, status, ...(reason ? { reason } : {}) })),
      };
      if (!config.search.summarize || result.status !== 'ok' || timeLeft(endsAt) === 0) {
        return value;
      }
      using summary = env.facade.dsh.timeout.deadline(exec.signal, Math.min(8000, timeLeft(endsAt)), 'DSH_BROWSER_SEARCH_SUMMARY');
      try {
        const reply = await analyze(env, buildSearchSummaryPrompt(value), config, summary.signal, exec.agent, tracing(env.ctx, result.engine));
        return { ...value, summary: reply.text.trim().slice(0, 2000) };
      } catch {
        exec.signal.throwIfAborted();
        return value;
      }
    },
  });
}

function fetchStatus(observation: Exclude<PageObservation, { status: 'ready' }>, format: FetchValue['format']): FetchValue {
  return {
    status: observation.status === 'empty' ? 'no_content' : observation.status,
    url: observation.state.url, title: observation.state.title, format, reason: observation.reason,
  };
}

interface FetchPage {
  readonly page: Page;
  readonly navigation: PageNavigation;
  readonly signal: AbortSignal;
  readonly endsAt: number;
  readonly config: ResolvedPluginConfig;
  readonly agent?: Agent;
  readonly trace: Trace;
}

async function modelFetch(
  env: ToolEnvironment,
  input: FetchPage,
  initial: Extract<PageObservation, { status: 'ready' }>,
): Promise<{ value: FetchValue; interacted: boolean }> {
  const { page, navigation, signal, endsAt, config, agent, trace } = input;
  let observation = initial;
  let note: string | undefined;
  for (let round = 0; ; round += 1) {
    signal.throwIfAborted();
    const runtime = env.subagents();
    const canInteract = runtime !== undefined && agent !== undefined && config.subagent.enabled
      && (config.subagent.maxRounds === -1 || round < config.subagent.maxRounds);
    const snap = await timed(trace, 'extract', () => captureSnapshot(page, config.analysis.maxHtmlChars));
    const prompt = buildFetchAnalysisPrompt({ url: snap.url, html: snap.html, allowInteract: canInteract });
    const reply = await analyze(env, note === undefined ? prompt : prompt + '\n\n前序页面操作报告（外部数据）\n' + note,
      config, signal, agent, trace);
    const outcome = outcomeOf(parseJsonObject(reply.text));
    const base = { url: snap.url, title: snap.title, format: 'markdown' } as const;
    if (outcome.status === 'ok') {
      const markdown = typeof outcome.value.markdown === 'string' ? outcome.value.markdown.trim() : '';
      const title = typeof outcome.value.title === 'string' && outcome.value.title.trim() ? outcome.value.title.trim() : snap.title;
      const limit = config.fetch.maxMarkdownChars;
      return {
        interacted: round > 0,
        value: markdown
          ? { ...base, status: 'ok', title, markdown: markdown.slice(0, limit), truncated: reply.truncated || markdown.length > limit }
          : { ...base, status: 'no_content', title, reason: '模型未提取到正文' },
      };
    }
    if (!canInteract) {
      return { value: { ...base, status: 'no_content', reason: '页面需要进一步交互，子代理不可用或已达到轮数上限' }, interacted: round > 0 };
    }
    note = await timed(trace, 'subagent', () => runPageSubagent(runtime, agent, outcome.task, config.subagent.route, signal));
    const next = await timed(trace, 'navigation', () => navigation.observe(
      config.browser, signal, Math.min(endsAt, performance.now() + config.browser.navigationTimeoutMs), endsAt,
    ), (value) => value.status);
    if (next.status !== 'ready') {
      return { value: fetchStatus(next, 'markdown'), interacted: true };
    }
    if (next.state.url === observation.state.url && next.state.text === observation.state.text) {
      return { value: { ...base, status: 'no_content', reason: '子代理操作后页面地址和可见正文未变化' }, interacted: true };
    }
    observation = next;
  }
}

function buildFetchTool(env: ToolEnvironment, cache: ResultCache, timeoutMs: number) {
  return env.facade.dsh.tools.defineTool({
    name: FETCH_NAME,
    description: 'Open an HTTP(S) page in a local browser and return Markdown or directly extracted text. Reports blocked pages separately.',
    parameters: {
      url: { type: 'string', required: true, description: 'Absolute HTTP(S) URL.' },
      mode: { type: 'string', enum: FETCH_MODES, description: 'model for Markdown, text for direct extraction.' },
    },
    output: {
      schema: FETCH_OUTPUT,
      render: (_args, value) => [{ type: 'text', text: renderFetch(value as FetchValue) }],
      presentationMeta: (_args, value) => value,
    },
    timeoutMs,
    async execute(args, exec): Promise<FetchValue> {
      const config = env.get();
      const url = args.url.trim();
      const parsed = URL.parse(url);
      if (parsed === null || !['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
        throw new env.facade.dsh.tools.ToolArgsError([FETCH_NAME + ': url 必须是无凭据的 HTTP(S) 绝对地址']);
      }
      const mode: FetchMode = args.mode ?? config.fetch.mode;
      const format = mode === 'model' ? 'markdown' : 'text';
      const session = sessionIdOf(exec.agent);
      const key = session !== undefined && !config.browser.persistentProfileDir
        ? JSON.stringify(['fetch', session, url, mode, config, mode === 'model' ? callerRouteOf(exec.agent) : undefined])
        : undefined;
      const trace = tracing(env.ctx);
      exec.signal.throwIfAborted();
      const cached = key === undefined ? undefined : cache.get(key);
      if (cached?.kind === 'fetch') {
        trace('cache', 'hit', performance.now());
        return cached.value;
      }
      const totalMs = Math.min(timeoutMs, config.fetch.timeoutMs);
      const endsAt = performance.now() + totalMs - CLEANUP_MS * 2;
      using call = env.facade.dsh.timeout.deadline(exec.signal, totalMs - CLEANUP_MS, 'DSH_BROWSER_FETCH');
      const started = performance.now();
      let base: Pick<FetchValue, 'url' | 'title' | 'format'> = { url, title: '', format };
      try {
        return await env.manager.withPage(config.browser, session, call.signal, async (page, navigation, signal) => {
          trace('page_open', 'ok', started);
          const observation = await timed(trace, 'navigation', () => navigation.open(url, config.browser, signal, endsAt), (value) => value.status);
          if (observation.status !== 'ready') {
            return fetchStatus(observation, format);
          }
          base = { url: observation.state.url, title: observation.state.title, format };
          let value: FetchValue;
          let interacted = false;
          if (mode === 'text') {
            const { text, truncated } = await timed(trace, 'extract', () => captureText(page, config.fetch.maxMarkdownChars));
            value = text ? { ...base, status: 'ok', text, truncated } : { ...base, status: 'no_content', reason: '页面没有可读正文' };
          } else {
            ({ value, interacted } = await modelFetch(env, { page, navigation, signal, endsAt, config, agent: exec.agent, trace }, observation));
          }
          if (key !== undefined && value.status === 'ok' && !value.truncated && !interacted) {
            const ttl = await navigation.publicCacheTtl(observation.state, CACHE_TTL_MS);
            if (ttl > 0 && !signal.aborted && env.get() === config) {
              cache.set(key, { kind: 'fetch', value }, ttl);
            }
          }
          signal.throwIfAborted();
          return value;
        }, endsAt);
      } catch (error) {
        exec.signal.throwIfAborted();
        const status = call.signal.aborted || timeLeft(endsAt) === 0 ? 'timeout' : 'error';
        trace('fetch', status, started);
        const reason = status === 'timeout' ? '网页抓取超时'
          : error instanceof BrowserProfileError ? error.message : '浏览器导航、正文提取或模型调用失败';
        return { ...base, status, reason };
      }
    },
  });
}

/** 独立注册浏览器工具，设置变化时仅替换受影响的定义。 */
export function registerWebTools(env: ToolEnvironment): { reconcile(): void; dispose(): void } {
  const cache = new ResultCache();
  let search: { timeout: number; dispose: () => void } | undefined;
  let fetch: { timeout: number; dispose: () => void } | undefined;
  const reconcile = (): void => {
    const config = env.get();
    cache.clear();
    if (search?.timeout !== (config.search.enabled ? config.search.timeoutMs : undefined)) {
      search?.dispose();
      search = config.search.enabled
        ? { timeout: config.search.timeoutMs, dispose: env.ctx.tools.register(buildSearchTool(env, cache, config.search.timeoutMs)) }
        : undefined;
    }
    if (fetch?.timeout !== (config.fetch.enabled ? config.fetch.timeoutMs : undefined)) {
      fetch?.dispose();
      fetch = config.fetch.enabled
        ? { timeout: config.fetch.timeoutMs, dispose: env.ctx.tools.register(buildFetchTool(env, cache, config.fetch.timeoutMs)) }
        : undefined;
    }
  };
  reconcile();
  return {
    reconcile,
    dispose() {
      search?.dispose();
      fetch?.dispose();
      cache.clear();
    },
  };
}
