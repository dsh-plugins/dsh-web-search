/**
 * 浏览器管理：自动探测本机浏览器、按需启动、页面生命周期与按会话查找。
 *
 * 使用 playwright-core（不随包下载浏览器）。启动候选顺序：
 * - 配置了 `executablePath` 时优先使用自定义路径；
 * - Chromium：本机 Chrome（channel: chrome）→ 本机 Edge（channel: msedge）→
 *   Playwright 缓存的 Chromium → 常见安装路径；
 * - Firefox / WebKit：Playwright 缓存版本 → 常见安装路径（Firefox 官方版本未包含
 *   Playwright 所需的 juggler 协议，通常不可用，仅作最后的尝试）。
 *
 * @module dsh-web-search/browser
 */
import { existsSync } from 'node:fs';
import { platform } from 'node:os';
import { chromium, firefox, webkit, type Browser, type BrowserContext, type BrowserType, type Page } from 'playwright-core';
import type { BrowserKind, ResolvedPluginConfig } from './config.js';

type BrowserConfig = ResolvedPluginConfig['browser'];

/** 实际启动成功的浏览器内核（`auto` 已解析为具体值）。 */
export type ActualBrowserKind = Exclude<BrowserKind, 'auto'>;

/** 一次启动尝试。 */
interface LaunchCandidate {
  readonly kind: ActualBrowserKind;
  /** 面向用户的候选描述（诊断与报错用）。 */
  readonly description: string;
  readonly options: Record<string, unknown>;
}

/** 浏览器启动失败时汇总各候选的错误。 */
export class BrowserLaunchError extends Error {
  readonly attempts: readonly string[];
  constructor(kind: BrowserKind, attempts: readonly string[]) {
    super(
      `dsh-web-search: 未能启动${kind === 'auto' ? '任何可用的' : kind}浏览器。已尝试：\n${attempts.map((a) => `- ${a}`).join('\n')}\n` +
      '可在插件设置中填写「自定义浏览器路径」，或执行 `npx playwright install chromium firefox webkit` 安装 Playwright 托管浏览器。',
    );
    this.name = 'BrowserLaunchError';
    this.attempts = attempts;
  }
}

/** 已打开页面的登记记录。 */
interface PageRecord {
  readonly sessionId: string;
  readonly context: BrowserContext;
  readonly page: Page;
  lastUsed: number;
}

/** 常见系统浏览器安装路径（仅作兜底尝试；存在性先行检查）。 */
function systemBrowserPaths(kind: ActualBrowserKind): string[] {
  const os = platform();
  if (kind === 'chromium') {
    if (os === 'win32') {
      return [
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
      ];
    }
    if (os === 'darwin') {
      return [
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
        '/Applications/Chromium.app/Contents/MacOS/Chromium',
      ];
    }
    return ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium'];
  }
  if (kind === 'firefox') {
    if (os === 'win32') return ['C:\\Program Files\\Mozilla Firefox\\firefox.exe', 'C:\\Program Files (x86)\\Mozilla Firefox\\firefox.exe'];
    if (os === 'darwin') return ['/Applications/Firefox.app/Contents/MacOS/firefox'];
    return ['/usr/bin/firefox', '/snap/bin/firefox'];
  }
  // WebKit：Playwright 只支持其自带构建；Safari 本体不提供自动化协议，无系统路径候选。
  return [];
}

function launcherOf(kind: ActualBrowserKind): BrowserType {
  return kind === 'chromium' ? chromium : kind === 'firefox' ? firefox : webkit;
}

/** 为某个内核构造启动候选列表。 */
function candidatesFor(kind: ActualBrowserKind, config: BrowserConfig): LaunchCandidate[] {
  const base: Record<string, unknown> = { headless: config.headless, timeout: config.launchTimeoutMs };
  // 用户显式配置了可执行文件路径时，只使用该路径（auto 模式下由调用方对每个内核各试一次）。
  if (config.executablePath.length > 0) {
    return [{ kind, description: `自定义路径 ${config.executablePath}`, options: { ...base, executablePath: config.executablePath } }];
  }
  const candidates: LaunchCandidate[] = [];
  if (kind === 'chromium') {
    candidates.push(
      { kind, description: '本机 Chrome（channel: chrome）', options: { ...base, channel: 'chrome' } },
      { kind, description: '本机 Edge（channel: msedge）', options: { ...base, channel: 'msedge' } },
      { kind, description: 'Playwright 托管 Chromium', options: { ...base } },
    );
    for (const path of systemBrowserPaths('chromium')) {
      if (existsSync(path)) candidates.push({ kind, description: `系统路径 ${path}`, options: { ...base, executablePath: path } });
    }
    return candidates;
  }
  candidates.push({ kind, description: `Playwright 托管 ${kind === 'firefox' ? 'Firefox' : 'WebKit'}`, options: { ...base } });
  for (const path of systemBrowserPaths(kind)) {
    if (existsSync(path)) candidates.push({ kind, description: `系统路径 ${path}`, options: { ...base, executablePath: path } });
  }
  return candidates;
}

/** 解析 `auto` 与自定义路径为有序的候选列表。 */
export function resolveCandidates(config: BrowserConfig): LaunchCandidate[] {
  if (config.kind !== 'auto') return candidatesFor(config.kind, config);
  if (config.executablePath.length > 0) {
    // 自定义路径 + auto：依次按 Chromium / Firefox / WebKit 启动器尝试该路径。
    return (['chromium', 'firefox', 'webkit'] as const).flatMap((kind) => candidatesFor(kind, config));
  }
  return (['chromium', 'firefox', 'webkit'] as const).flatMap((kind) => candidatesFor(kind, config));
}

/** 配置指纹：变化时需要重启浏览器实例。 */
function fingerprintOf(config: BrowserConfig): string {
  return JSON.stringify([config.kind, config.executablePath, config.headless, config.launchTimeoutMs]);
}

/** 浏览器与页面的集中管理者。 */
export class BrowserManager {
  private browser: Browser | undefined;
  private browserKind: ActualBrowserKind | undefined;
  private browserDescription = '';
  private fingerprint = '';
  /** 串行化启动：并发的首个调用共享同一次启动尝试。 */
  private launchQueue: Promise<unknown> = Promise.resolve();
  private readonly pages = new Map<string, PageRecord[]>();
  private lastRecord: PageRecord | undefined;
  private readonly log: (message: string) => void;

  constructor(logger?: { info?(message: string): void; warn?(message: string): void }) {
    this.log = (message) => {
      if (logger?.info) logger.info(message);
    };
  }

  /** 当前持有的浏览器描述（诊断面板用）。 */
  get activeBrowserDescription(): string | undefined {
    return this.browser?.isConnected() ? `${this.browserKind}（${this.browserDescription}）` : undefined;
  }

  /** 按配置确保浏览器可用；配置变化或实例断开时重新启动。 */
  async ensureBrowser(config: BrowserConfig, signal?: AbortSignal): Promise<Browser> {
    const fingerprint = fingerprintOf(config);
    if (this.browser !== undefined && this.browser.isConnected() && this.fingerprint === fingerprint) {
      return this.browser;
    }
    // 串行化：配置变化重开与并发首次启动共用同一条队列。
    const task = this.launchQueue.then(async () => {
      if (this.browser !== undefined && this.browser.isConnected() && this.fingerprint === fingerprint) {
        return this.browser;
      }
      await this.close();
      signal?.throwIfAborted();
      const attempts: string[] = [];
      for (const candidate of resolveCandidates(config)) {
        signal?.throwIfAborted();
        try {
          const browser = await launcherOf(candidate.kind).launch(candidate.options);
          browser.on('disconnected', () => {
            if (this.browser === browser) {
              this.browser = undefined;
              this.browserKind = undefined;
            }
          });
          this.browser = browser;
          this.browserKind = candidate.kind;
          this.browserDescription = candidate.description;
          this.fingerprint = fingerprint;
          this.log(`dsh-web-search: 已启动浏览器：${candidate.description}`);
          return browser;
        } catch (error) {
          attempts.push(`${candidate.description}：${error instanceof Error ? error.message.split('\n')[0] : String(error)}`);
        }
      }
      throw new BrowserLaunchError(config.kind, attempts);
    });
    // 失败也留在队列上并立即消化，避免后续调用拿到已拒绝的 Promise。
    this.launchQueue = task.catch(() => {});
    return task;
  }

  /**
   * 在一个全新上下文中打开页面并执行回调；回调期间页面按会话登记，
   * 供子代理的浏览器工具定位；返回后关闭上下文。
   */
  async withPage<T>(config: BrowserConfig, sessionId: string, signal: AbortSignal, fn: (page: Page) => Promise<T>): Promise<T> {
    const browser = await this.ensureBrowser(config, signal);
    signal.throwIfAborted();
    const context = await browser.newContext({ locale: 'zh-CN' });
    const page = await context.newPage();
    const record: PageRecord = { sessionId, context, page, lastUsed: Date.now() };
    const stack = this.pages.get(sessionId) ?? [];
    stack.push(record);
    this.pages.set(sessionId, stack);
    this.lastRecord = record;
    const onAbort = (): void => {
      void context.close().catch(() => {});
    };
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      return await fn(page);
    } finally {
      signal.removeEventListener('abort', onAbort);
      const current = this.pages.get(sessionId);
      if (current !== undefined) {
        const index = current.indexOf(record);
        if (index >= 0) current.splice(index, 1);
        if (current.length === 0) this.pages.delete(sessionId);
      }
      if (this.lastRecord === record) this.lastRecord = undefined;
      await context.close().catch(() => {});
    }
  }

  /**
   * 供浏览器工具定位页面：先找调用者自己会话的页面，再找父会话的页面
   * （子代理场景），最后退回最近活动的页面。
   */
  pageFor(sessionId: string | undefined, parentSessionId: string | undefined): Page | undefined {
    const pick = (id: string | undefined): PageRecord | undefined => {
      if (id === undefined) return undefined;
      const stack = this.pages.get(id);
      return stack === undefined || stack.length === 0 ? undefined : stack[stack.length - 1];
    };
    const record = pick(sessionId) ?? pick(parentSessionId) ?? this.lastRecord;
    if (record === undefined || record.page.isClosed()) return undefined;
    record.lastUsed = Date.now();
    return record.page;
  }

  /** 打开 URL 并等待页面稳定：domcontentloaded → load → 静置 → 短暂 networkidle。 */
  async navigate(page: Page, url: string, config: BrowserConfig): Promise<void> {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: config.navigationTimeoutMs });
    await page.waitForLoadState('load', { timeout: config.navigationTimeoutMs }).catch(() => {});
    if (config.settleMs > 0) {
      await page.waitForTimeout(config.settleMs);
    }
    await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => {});
  }

  /** 诊断：按配置实际执行一次启动探测，启动成功即刻关闭并返回报告文本。 */
  async probe(config: BrowserConfig): Promise<string> {
    const lines: string[] = [];
    let ok = false;
    for (const candidate of resolveCandidates(config)) {
      try {
        const browser = await launcherOf(candidate.kind).launch(candidate.options);
        const version = browser.version();
        await browser.close();
        lines.push(`✔ ${candidate.description}（版本 ${version}）`);
        ok = true;
        break;
      } catch (error) {
        lines.push(`✘ ${candidate.description}：${error instanceof Error ? error.message.split('\n')[0] : String(error)}`);
      }
    }
    if (!ok) {
      lines.push('未找到可用浏览器。可填写自定义浏览器路径，或执行 npx playwright install chromium firefox webkit。');
    }
    return lines.join('\n');
  }

  /** 关闭浏览器并清空页面登记（幂等）。 */
  async close(): Promise<void> {
    const browser = this.browser;
    this.browser = undefined;
    this.browserKind = undefined;
    this.fingerprint = '';
    this.pages.clear();
    this.lastRecord = undefined;
    if (browser !== undefined) {
      await browser.close().catch(() => {});
    }
  }
}
