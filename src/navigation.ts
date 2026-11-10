
import { setTimeout as delay } from 'node:timers/promises';
import { errors, type Page, type Response } from 'playwright-core';
import type { ResolvedPluginConfig, SearchEngine } from './config.js';
import { RESULT_SELECTORS, type ResultCandidate } from './search-results.js';

type BrowserConfig = ResolvedPluginConfig['browser'];

interface PageState {
  readonly url: string;
  readonly title: string;
  readonly text: string;
  readonly loaded: boolean;
  readonly challenge: string;
  readonly empty: boolean;
  readonly candidates: ResultCandidate[];
}

export type PageObservation =
  | { readonly status: 'ready'; readonly state: PageState }
  | { readonly status: 'empty' | 'error' | 'blocked' | 'timeout'; readonly state: PageState; readonly reason: string };

function readPage(selectors: (typeof RESULT_SELECTORS)[SearchEngine] | undefined): PageState {
  const visible = (node: Element | null): node is HTMLElement =>
    node instanceof HTMLElement && node.getClientRects().length > 0 && !node.closest('[hidden], [aria-hidden="true"]')
    && getComputedStyle(node).visibility !== 'hidden';
  const host = location.hostname;
  const path = location.pathname;
  const body = document.body;
  const bodyText = (body?.innerText ?? '').trim();
  const main = document.querySelector('main article, article, main, [role="main"]');
  const dialog = document.querySelector('dialog[open], [role="dialog"]');
  const text = visible(main) ? main.innerText.trim() || (visible(dialog) ? dialog.innerText.trim() : '') : bodyText;
  let challenge = '';
  if ((host === 'wappass.baidu.com' && /captcha|verify/i.test(path))
    || (/(^|\.)baidu\.com$/i.test(host) && /百度安全验证/.test(document.title))) {
    challenge = '百度安全验证';
  } else if (/(^|\.)sogou\.com$/i.test(host) && path.startsWith('/antispider')) {
    challenge = '搜狗验证码';
  } else if ((/^www\.google\./i.test(host) && /^\/sorry(?:\/|$)/.test(path))
    || (/(^|\.)bing\.com$/i.test(host) && visible(document.querySelector('#b_captcha, #b_captcha_container, #b_captcha_form')))) {
    challenge = '搜索引擎要求验证';
  } else if (visible(document.querySelector('#challenge-form, #cf-challenge-running'))
    && /cloudflare|just a moment|请稍候/i.test(document.title + ' ' + bodyText.slice(0, 1500))) {
    challenge = 'Cloudflare 挑战';
  }

  const candidates: ResultCandidate[] = [];
  let empty = false;
  if (selectors !== undefined && !challenge) {
    const container = document.querySelector(selectors.results);
    if (container !== null) {
      const seen = new Set<Element>();
      for (const card of Array.from(container.querySelectorAll(selectors.cards)).slice(0, 200)) {
        if (card.closest('.b_ad, .b_adTop, [data-text-ad], [data-ad], #tads, #bottomads, .ec_tuiguang')) {
          continue;
        }
        const anchor = card.querySelector(selectors.title);
        if (!visible(anchor) || seen.has(anchor)) {
          continue;
        }
        seen.add(anchor);
        const snippet = card.querySelector(selectors.snippet);
        candidates.push({
          title: (anchor.querySelector('h3')?.textContent ?? anchor.innerText).trim().slice(0, 300),
          url: anchor.getAttribute('href') ?? '',
          snippet: visible(snippet) ? snippet.innerText.trim().slice(0, 1000) : '',
          destination: selectors.destinationAttribute === undefined ? undefined : card.getAttribute(selectors.destinationAttribute) ?? undefined,
        });
      }
    }
    empty = visible(document.querySelector(selectors.empty)) && candidates.length === 0
      && /no (?:related |search )?results|did not match any|找不到|未找到|没有|无相关/i.test(bodyText.slice(0, 4000));
    empty ||= candidates.length === 0 && /没有与此相关的结果|未找到相关结果|未找到与.{0,150}相关的|did not match any documents/i.test(bodyText.slice(0, 4000));
  }

  return {
    url: location.href,
    title: document.title,
    text: text.slice(0, 8000),
    loaded: document.readyState !== 'loading',
    challenge,
    empty,
    candidates,
  };
}

function documentUrl(url: string): string {
  return url.split('#', 1)[0];
}

function sameContent(a: PageState, b: PageState): boolean {
  return a.url === b.url && a.title === b.title && a.text === b.text;
}

function interruptedDocument(error: unknown): boolean {
  return error instanceof Error && /Execution context was destroyed|Cannot find context|Inspected target navigated/i.test(error.message);
}

function initialState(url: string): PageState {
  return { url, title: '', text: '', loaded: false, challenge: '', empty: false, candidates: [] };
}

export function timeLeft(endsAt: number): number {
  return Math.max(0, Math.ceil(endsAt - performance.now()));
}

/** 限制只读页面检查的等待时间，避免网页脚本阻塞 Playwright 求值。 */
export async function readBeforeDeadline<T>(
  read: () => Promise<T>,
  endsAt: number,
  signal: AbortSignal,
): Promise<T | undefined> {
  signal.throwIfAborted();
  const remaining = timeLeft(endsAt);
  if (remaining === 0) {
    return undefined;
  }
  const timer = new AbortController();
  try {
    return await Promise.race([
      read(),
      delay(remaining, undefined, { signal: AbortSignal.any([signal, timer.signal]) }),
    ]);
  } catch (error) {
    signal.throwIfAborted();
    throw error;
  } finally {
    timer.abort();
  }
}

/** 跟踪当前页面主文档，并用同一预算等待导航和内容。 */
export class PageNavigation {
  private response: Response | undefined;
  private documentCount = 0;

  constructor(private readonly page: Page) {
    page.on('response', (response) => {
      const request = response.request();
      if (!request.isNavigationRequest()) {
        return;
      }
      try {
        if (request.frame() !== page.mainFrame()) {
          return;
        }
      } catch {
        // 导航请求可能早于 frame 创建。
        return;
      }
      this.documentCount += 1;
      if (response.status() < 300 || response.status() >= 400) {
        this.response = response;
      }
    });
  }

  private responseFor(state: PageState): Response | undefined {
    return this.response !== undefined && documentUrl(this.response.url()) === documentUrl(state.url)
      ? this.response
      : undefined;
  }

  private classify(state: PageState, engine: SearchEngine | undefined): PageObservation | undefined {
    const response = this.responseFor(state);
    const blocked = response?.headers()['cf-mitigated']?.toLowerCase() === 'challenge' ? 'Cloudflare 挑战' : state.challenge;
    if (blocked) {
      return { status: 'blocked', state, reason: blocked };
    }
    if (response !== undefined && response.status() >= 400) {
      return { status: 'error', state, reason: 'HTTP ' + response.status() };
    }
    if (engine !== undefined) {
      if (state.candidates.length > 0) {
        return { status: 'ready', state };
      }
      if (state.empty) {
        return { status: 'empty', state, reason: '搜索引擎没有返回相关结果' };
      }
    } else if (state.loaded && state.text) {
      return { status: 'ready', state };
    }
    return undefined;
  }

  private async inspect(endsAt: number, signal: AbortSignal, engine?: SearchEngine): Promise<PageState | undefined> {
    try {
      return await readBeforeDeadline(() => this.page.evaluate(readPage, engine === undefined ? undefined : RESULT_SELECTORS[engine]), endsAt, signal);
    } catch (error) {
      if (!interruptedDocument(error)) {
        throw error;
      }
      return undefined;
    }
  }

  private async wait(endsAt: number, settleMs: number, signal: AbortSignal, engine?: SearchEngine): Promise<PageObservation> {
    let state = initialState(this.page.url());
    let stableSince = performance.now();
    while (true) {
      signal.throwIfAborted();
      const observed = await this.inspect(endsAt, signal, engine);
      if (observed !== undefined) {
        if (!sameContent(observed, state) || observed.loaded !== state.loaded) {
          stableSince = performance.now();
        }
        state = observed;
        const result = this.classify(state, engine);
        if (result !== undefined) {
          return result;
        }
        if (state.loaded && performance.now() - stableSince >= settleMs) {
          return engine === undefined
            ? { status: 'empty', state, reason: '页面没有可读正文' }
            : { status: 'error', state, reason: '未识别到搜索引擎结果区' };
        }
      }
      const remaining = timeLeft(endsAt);
      if (remaining === 0) {
        return { status: 'timeout', state, reason: '等待页面就绪超时' };
      }
      await delay(Math.min(100, remaining), undefined, { signal });
    }
  }

  async open(url: string, config: BrowserConfig, signal: AbortSignal, endsAt: number, engine?: SearchEngine): Promise<PageObservation> {
    const navigationEnd = Math.min(endsAt, performance.now() + config.navigationTimeoutMs);
    const timeout = timeLeft(navigationEnd);
    signal.throwIfAborted();
    if (timeout === 0) {
      return { status: 'timeout', state: initialState(url), reason: '页面导航超时' };
    }
    try {
      await this.page.goto(url, { waitUntil: 'commit', timeout });
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof errors.TimeoutError) {
        return { status: 'timeout', state: initialState(url), reason: '页面导航超时' };
      }
      throw error;
    }
    return this.observe(config, signal, navigationEnd, endsAt, engine);
  }

  async observe(
    config: BrowserConfig,
    signal: AbortSignal,
    navigationEnd: number,
    callEnd: number,
    engine?: SearchEngine,
  ): Promise<PageObservation> {
    const result = await this.wait(navigationEnd, config.settleMs, signal, engine);
    if (result.status !== 'blocked' || !config.persistentProfileDir || config.headless || config.challengeWaitMs === 0) {
      return result;
    }

    const manualEnd = Math.min(callEnd, performance.now() + config.challengeWaitMs);
    if (timeLeft(manualEnd) === 0) {
      return result;
    }
    await readBeforeDeadline(() => this.page.bringToFront(), manualEnd, signal);
    while (timeLeft(manualEnd) > 0) {
      signal.throwIfAborted();
      const state = await this.inspect(manualEnd, signal, engine);
      if (state !== undefined && state.url !== 'about:blank') {
        const next = this.classify(state, engine);
        if (next !== undefined && next.status !== 'blocked') {
          return next;
        }
      }
      await delay(Math.min(100, timeLeft(manualEnd)), undefined, { signal });
    }
    return { ...result, reason: result.reason + '，人工验证等待已结束' };
  }

  async afterAction(signal: AbortSignal, settleMs: number, deadline: number, action: () => Promise<unknown>): Promise<void> {
    signal.throwIfAborted();
    const previous = settleMs > 0 ? await this.inspect(deadline, signal) : undefined;
    await action();
    const endsAt = Math.min(deadline, performance.now() + settleMs);
    let changed: PageState | undefined;
    while (timeLeft(endsAt) > 0) {
      signal.throwIfAborted();
      const state = await this.inspect(endsAt, signal);
      if (state !== undefined && (this.classify(state, undefined)?.status === 'blocked'
        || (state.loaded && changed !== undefined && sameContent(state, changed)))) {
        return;
      }
      if (state !== undefined && (previous === undefined || !sameContent(state, previous))) {
        changed = state;
      } else {
        changed = undefined;
      }
      await delay(Math.min(100, timeLeft(endsAt)), undefined, { signal });
    }
    signal.throwIfAborted();
  }

  async publicCacheTtl(state: PageState, limit: number): Promise<number> {
    const response = this.responseFor(state);
    if (response === undefined || !response.ok() || this.documentCount !== 1) {
      return 0;
    }
    try {
      const headers = await response.allHeaders();
      const control = (headers['cache-control'] ?? '').toLowerCase().split(',').map((part) => part.trim());
      const vary = (headers.vary ?? '').toLowerCase().split(',').map((part) => part.trim());
      if (!control.includes('public') || control.some((part) => /^(?:private|no-store|no-cache)(?:$|=)/.test(part))
        || vary.some((part) => part === '*' || part === 'cookie' || part === 'authorization')
        || headers['set-cookie'] !== undefined || (await this.page.context().cookies()).length !== 0) {
        return 0;
      }
      const lifetimes = control.flatMap((part) => {
        const value = /^(?:s-maxage|max-age)\s*=\s*"?(\d+)"?$/.exec(part)?.[1];
        return value === undefined ? [] : [Number(value) * 1000];
      });
      const age = (Number(headers.age) || 0) * 1000;
      const expires = Date.parse(headers.expires ?? '');
      if (lifetimes.length > 0) {
        return Math.max(0, Math.min(limit, Math.min(...lifetimes) - age));
      }
      return Number.isNaN(expires) ? limit : Math.max(0, Math.min(limit, expires - Date.now()));
    } catch {
      // 无法验证缓存条件时只返回当次结果。
      return 0;
    }
  }
}
