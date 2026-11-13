import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { lstat, mkdir, readdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { platform } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { chromium, firefox, webkit, type Browser, type BrowserContext, type BrowserType, type Page } from 'playwright-core';
import { MAX_TIMER_DELAY_MS, type BrowserKind, type ResolvedPluginConfig, type SearchEngine } from './config.js';
import { PageNavigation, timeLeft, type PageObservation } from './navigation.js';

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


interface BrowserInstance {
  readonly fingerprint: string;
  readonly description: string;
  readonly browser?: Browser;
  readonly context?: BrowserContext;
  readonly leases: Set<Promise<void>>;
  available: boolean;
}

/** 由 `browser_web_open` / `browser_web_search` / `browser_web_fetch` 打开并保留的页面句柄。 */
export interface RetainedPage {
  /** 页面句柄 ID，供 `web_browser_*` 工具的 `id` 参数使用。 */
  readonly id: string;
  readonly page: Page;
  readonly navigation: PageNavigation;
  readonly config: BrowserConfig;
  /** 页面生命周期信号：页面被关闭（空闲超时、手动回收、配置变更、插件卸载）时 abort。 */
  readonly signal: AbortSignal;
}

/** 保留页面注册表条目（在 RetainedPage 基础上附带回收所需的内部状态）。 */
interface RetainedEntry extends RetainedPage {
  readonly controller: AbortController;
  readonly disposePage: () => Promise<void>;
  readonly releaseLease: () => void;
  /** 空闲保留时长（毫秒）；0 表示不保留，由调用方用完立即关闭。 */
  timeoutMs: number;
  timer?: NodeJS.Timeout;
  /** 同一页面上的操作串行化链。 */
  chain: Promise<void>;
  /** 进行中的操作数；大于 0 时暂停空闲计时。 */
  operations: number;
  closed: boolean;
}

/** `openRetainedPage` 的返回句柄：保留页面加上首次导航的观察结果。 */
export interface OpenedPage extends RetainedPage {
  /** 传入 `url` 时的首次导航观察结果（含被拦截、挑战等非 ready 状态）；打开空白页时为 undefined。 */
  readonly observation?: PageObservation;
}

function fingerprintOf(config: BrowserConfig): string {
  return JSON.stringify([config.kind, config.executablePath, config.headless, config.launchTimeoutMs, config.persistentProfileDir]);
}

async function untilAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let abort: () => void = () => {};
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
  });
  try {
    return await Promise.race([promise, cancelled]);
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

const PROFILE_MARKER = '.dsh-web-search-profile';

export class BrowserProfileError extends Error {}

function candidateId(candidate: LaunchCandidate): string {
  return JSON.stringify([candidate.kind, candidate.options.channel ?? '', candidate.options.executablePath ?? '']);
}

async function readBinding(marker: string): Promise<string> {
  if (!(await lstat(marker)).isFile()) {
    throw new BrowserProfileError('专用浏览器目录标记无效');
  }
  const value = (await readFile(marker, 'utf8')).trim();
  if (!value) {
    throw new BrowserProfileError('专用浏览器目录正在初始化，请稍后重试');
  }
  return value;
}

async function dedicatedDirectory(path: string): Promise<{ directory: string; binding?: string }> {
  if (!isAbsolute(path)) {
    throw new BrowserProfileError('专用浏览器目录必须是绝对路径');
  }
  await mkdir(path, { recursive: true, mode: 0o700 });
  const entry = await lstat(path);
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    throw new BrowserProfileError('专用浏览器目录必须是普通目录');
  }
  const directory = await realpath(path);
  const files = await readdir(directory);
  if (files.includes(PROFILE_MARKER)) {
    return { directory, binding: await readBinding(join(directory, PROFILE_MARKER)) };
  }
  if (files.length !== 0) {
    throw new BrowserProfileError('专用浏览器目录首次使用时必须为空');
  }
  return { directory };
}

async function bindDirectory(directory: string, binding: string): Promise<void> {
  const marker = join(directory, PROFILE_MARKER);
  try {
    await writeFile(marker, binding, { flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw error;
    }
    if (await readBinding(marker) !== binding) {
      throw new BrowserProfileError('专用浏览器目录已绑定到另一浏览器');
    }
  }
}

/** 管理浏览器实例、专用目录与按 ID 寻址的保留页面。 */
export class BrowserManager {
  private instance: BrowserInstance | undefined;
  private queue: Promise<void> = Promise.resolve();
  private readonly lifetime = new AbortController();
  private desiredFingerprint: string | null | undefined;
  private readonly probes = new Set<Promise<string>>();
  private readonly retained = new Map<string, RetainedEntry>();

  constructor(private readonly logger?: { info?(message: string): void; warn?(message: string): void }) {}

  get activeBrowserDescription(): string | undefined {
    return this.instance?.available ? this.instance.description : undefined;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation);
    this.queue = result.then(() => {}, () => {});
    return result;
  }

  private async closeResource(resource: Browser | BrowserContext | Page | undefined): Promise<void> {
    if (resource === undefined) {
      return;
    }
    try {
      await resource.close();
    } catch {
      this.logger?.warn?.('dsh-web-search phase=browser_close status=error');
    }
  }

  private async closeInstance(): Promise<void> {
    const previous = this.instance;
    this.instance = undefined;
    await this.closeResource(previous?.context ?? previous?.browser);
  }

  private async launch(config: BrowserConfig, signal: AbortSignal, endsAt: number): Promise<BrowserInstance> {
    const profile = config.persistentProfileDir ? await dedicatedDirectory(config.persistentProfileDir) : undefined;
    const attempts: string[] = [];
    const candidates = resolveCandidates(config);
    const matching = profile?.binding === undefined ? candidates : candidates.filter((candidate) => candidateId(candidate) === profile.binding);
    if (matching.length === 0) {
      throw new BrowserProfileError('专用浏览器目录已绑定到另一浏览器，请还原原浏览器设置或填写新的空目录');
    }
    for (const candidate of matching) {
      signal.throwIfAborted();
      const timeout = Math.min(timeLeft(endsAt), config.launchTimeoutMs);
      if (timeout === 0) {
        break;
      }
      const options = { ...candidate.options, timeout };
      const instance: BrowserInstance = {
        fingerprint: fingerprintOf(config), description: candidate.description, leases: new Set(), available: true,
      };
      let bound = profile?.binding !== undefined;
      try {
        const launcher = launcherOf(candidate.kind);
        if (profile !== undefined) {
          if (!bound) {
            // 先确认候选可启动，再把专用目录绑定到该分发和可执行文件。
            const probe = await launcher.launch({ ...options, headless: true });
            await this.closeResource(probe);
            signal.throwIfAborted();
            await bindDirectory(profile.directory, candidateId(candidate));
            bound = true;
          }
          const remaining = Math.min(timeLeft(endsAt), config.launchTimeoutMs);
          if (remaining === 0) {
            break;
          }
          const context = await launcher.launchPersistentContext(profile.directory, {
            ...options, timeout: remaining, locale: 'zh-CN', acceptDownloads: false,
          });
          context.on('close', () => { instance.available = false; });
          return Object.assign(instance, { context });
        }
        const browser = await launcher.launch(options);
        browser.on('disconnected', () => { instance.available = false; });
        return Object.assign(instance, { browser });
      } catch (error) {
        if (error instanceof BrowserProfileError) {
          throw error;
        }
        attempts.push(candidate.description + '：' + (error instanceof Error ? error.message.split('\n')[0] : String(error)));
        if (bound) {
          break;
        }
      }
    }
    signal.throwIfAborted();
    throw new BrowserLaunchError(config.kind, attempts);
  }

  /** 发布启动配置；配置变化时先回收保留页面，再排空并释放旧浏览器。 */
  configure(config: BrowserConfig | undefined): void {
    const wanted = config === undefined ? null : fingerprintOf(config);
    if (this.desiredFingerprint === wanted) {
      return;
    }
    this.desiredFingerprint = wanted;
    void this.enqueue(async () => {
      // 保留页面持有长租约：先全部回收，旧浏览器才能及时退出。
      await this.closeAllRetained();
      const current = this.instance;
      if (current !== undefined && current.fingerprint !== this.desiredFingerprint) {
        await Promise.all(current.leases);
        if (current.fingerprint !== this.desiredFingerprint) {
          await this.closeInstance();
        }
      }
    }).catch(() => this.logger?.warn?.('dsh-web-search phase=browser_configure status=error'));
  }

  private checkConfiguration(config: BrowserConfig, signal: AbortSignal): void {
    signal.throwIfAborted();
    if (this.desiredFingerprint !== undefined && fingerprintOf(config) !== this.desiredFingerprint) {
      throw new BrowserProfileError('浏览器启动配置已更改，请重试');
    }
  }

  private async matchingInstance(config: BrowserConfig, signal: AbortSignal, endsAt: number): Promise<BrowserInstance> {
    this.checkConfiguration(config, signal);
    if (this.instance?.available && this.instance.fingerprint === fingerprintOf(config)) {
      return this.instance;
    }
    if (this.instance !== undefined) {
      await untilAbort(Promise.all(this.instance.leases), signal);
      await this.closeInstance();
    }
    this.checkConfiguration(config, signal);
    this.instance = await this.launch(config, signal, endsAt);
    this.checkConfiguration(config, signal);
    return this.instance;
  }

  /** 供只需要临时浏览器进程的调用方使用。 */
  async ensureBrowser(config: BrowserConfig, signal: AbortSignal = this.lifetime.signal): Promise<Browser> {
    const combined = AbortSignal.any([this.lifetime.signal, signal]);
    const instance = await this.enqueue(() => this.matchingInstance(
      { ...config, persistentProfileDir: '' }, combined, performance.now() + config.launchTimeoutMs,
    ));
    return instance.browser!;
  }

  private async reserve(config: BrowserConfig, signal: AbortSignal, endsAt: number) {
    const queued = this.enqueue(async () => {
      const instance = await this.matchingInstance(config, signal, endsAt);
      const lease = Promise.withResolvers<void>();
      instance.leases.add(lease.promise);
      const release = (): void => {
        instance.leases.delete(lease.promise);
        lease.resolve();
      };
      return { instance, release };
    });
    try {
      return await untilAbort(queued, signal);
    } catch (error) {
      void queued.then((reservation) => reservation.release(), () => {});
      throw error;
    }
  }

  /** 临时模式独立上下文，持久化模式独立标签页。 */
  private async acquirePage(
    config: BrowserConfig,
    signal: AbortSignal,
    endsAt: number,
  ): Promise<{ page: Page; navigation: PageNavigation; disposePage: () => Promise<void>; release: () => void }> {
    const { instance, release } = await this.reserve(config, signal, endsAt);
    let ownedContext: BrowserContext | undefined;
    let page: Page | undefined;
    let close: Promise<void> | undefined;
    const popups = new Set<Page>();
    const disposePage = (): Promise<void> => {
      close ??= (async () => {
        if (ownedContext === undefined) {
          await this.closeResource(page);
          await Promise.all([...popups].map((popup) => this.closeResource(popup)));
        } else {
          await this.closeResource(ownedContext);
        }
      })();
      return close;
    };
    try {
      signal.throwIfAborted();
      if (instance.context === undefined) {
        ownedContext = await instance.browser!.newContext({ locale: 'zh-CN', acceptDownloads: false });
      }
      signal.throwIfAborted();
      page = await (instance.context ?? ownedContext!).newPage();
      if (instance.context !== undefined) {
        const ownPopup = (popup: Page): void => {
          popups.add(popup);
          popup.on('popup', ownPopup);
        };
        page.on('popup', ownPopup);
      }
      const navigation = new PageNavigation(page);
      signal.throwIfAborted();
      return { page, navigation, disposePage, release };
    } catch (error) {
      await disposePage();
      release();
      throw error;
    }
  }

  private armRetained(entry: RetainedEntry): void {
    if (entry.timer !== undefined) {
      clearTimeout(entry.timer);
      entry.timer = undefined;
    }
    if (entry.closed || entry.operations > 0 || entry.timeoutMs <= 0) {
      return;
    }
    entry.timer = setTimeout(() => {
      void this.closeRetained(entry.id).catch(() => this.logger?.warn?.('dsh-web-search phase=retained_close status=error'));
    }, Math.min(entry.timeoutMs, MAX_TIMER_DELAY_MS));
    entry.timer.unref?.();
  }

  /**
   * 打开并保留一个页面，返回句柄与首次导航观察结果。
   *
   * 页面在 `timeoutMs` 毫秒内没有任何操作时自动关闭；`timeoutMs` 为 0 时不启动
   * 空闲计时，由调用方用完后自行 `closeRetained`。`url` 省略时打开空白页；
   * 导航被拦截、超时等结果通过 `observation` 返回而不抛错，仅启动/获取页面
   * 失败才抛错（此时页面已回收）。
   */
  async openRetainedPage(
    config: BrowserConfig,
    options: {
      readonly url?: string;
      readonly timeoutMs: number;
      /** 首次导航的截止时间（performance.now() 基准）；缺省按导航超时计算。 */
      readonly endsAt?: number;
      /** 搜索引擎标识，用于导航诊断日志。 */
      readonly engine?: SearchEngine;
    },
    signal: AbortSignal,
  ): Promise<OpenedPage> {
    const combined = AbortSignal.any([this.lifetime.signal, signal]);
    const acquireEndsAt = options.endsAt ?? performance.now() + config.launchTimeoutMs + config.navigationTimeoutMs;
    const acquired = await this.acquirePage(config, combined, acquireEndsAt);
    const controller = new AbortController();
    const id = randomBytes(6).toString('base64url');
    const entry: RetainedEntry = {
      id,
      page: acquired.page,
      navigation: acquired.navigation,
      config,
      controller,
      signal: AbortSignal.any([this.lifetime.signal, controller.signal]),
      disposePage: acquired.disposePage,
      releaseLease: acquired.release,
      timeoutMs: Math.max(0, options.timeoutMs),
      chain: Promise.resolve(),
      operations: 0,
      closed: false,
    };
    // 有头模式下用户可能直接关闭标签页：监听后回收条目与租约。
    acquired.page.on('close', () => {
      void this.closeRetained(id).catch(() => {});
    });
    this.retained.set(id, entry);
    try {
      let observation: PageObservation | undefined;
      if (options.url !== undefined) {
        observation = await this.useRetained(id, (current) => current.navigation.open(
          options.url!, config, current.signal,
          options.endsAt ?? performance.now() + config.navigationTimeoutMs,
          options.engine,
        ));
      }
      this.armRetained(entry);
      return { id, page: entry.page, navigation: entry.navigation, config, signal: entry.signal, observation };
    } catch (error) {
      await this.closeRetained(id);
      throw error;
    }
  }

  /** 查询保留页面；不存在或已关闭时返回 undefined。 */
  retainedPage(id: string): RetainedPage | undefined {
    const entry = this.retained.get(id);
    if (entry === undefined || entry.closed || entry.page.isClosed()) {
      return undefined;
    }
    return entry;
  }

  /**
   * 借用保留页面执行操作。
   *
   * 同一页面上的操作按调用顺序串行执行；操作期间暂停空闲计时，全部结束后
   * 重新计时。页面不存在或已关闭时抛错。
   */
  async useRetained<T>(id: string, fn: (page: RetainedPage) => Promise<T>): Promise<T> {
    const entry = this.retained.get(id);
    if (entry === undefined || entry.closed) {
      throw new Error(`没有找到 ID 为 "${id}" 的浏览器页面：页面可能已因空闲超时关闭，请用 browser_web_open 重新打开`);
    }
    const previous = entry.chain;
    const slot = Promise.withResolvers<void>();
    entry.chain = previous.then(() => slot.promise);
    await previous;
    if (entry.closed || entry.page.isClosed()) {
      slot.resolve();
      throw new Error(`ID 为 "${id}" 的浏览器页面已关闭，请用 browser_web_open 重新打开`);
    }
    entry.operations += 1;
    if (entry.timer !== undefined) {
      clearTimeout(entry.timer);
      entry.timer = undefined;
    }
    try {
      return await fn(entry);
    } finally {
      entry.operations -= 1;
      this.armRetained(entry);
      slot.resolve();
    }
  }

  /** 关闭并回收一个保留页面；返回是否真的执行了回收。 */
  async closeRetained(id: string): Promise<boolean> {
    const entry = this.retained.get(id);
    if (entry === undefined || entry.closed) {
      return false;
    }
    entry.closed = true;
    if (entry.timer !== undefined) {
      clearTimeout(entry.timer);
      entry.timer = undefined;
    }
    // 等待进行中的操作收尾，避免页面在操作中途被关闭。
    await entry.chain.catch(() => {});
    this.retained.delete(id);
    entry.controller.abort();
    await entry.disposePage();
    entry.releaseLease();
    return true;
  }

  private async closeAllRetained(): Promise<void> {
    await Promise.allSettled([...this.retained.keys()].map((id) => this.closeRetained(id)));
  }

  /** 探测可执行文件，诊断不占用持久化目录。 */
  async probe(config: BrowserConfig, signal: AbortSignal = this.lifetime.signal): Promise<string> {
    const probe = this.probeOnce(config, signal);
    this.probes.add(probe);
    try {
      return await probe;
    } finally {
      this.probes.delete(probe);
    }
  }

  private async probeOnce(config: BrowserConfig, signal: AbortSignal): Promise<string> {
    const combined = AbortSignal.any([this.lifetime.signal, signal]);
    try {
      const instance = await this.launch({ ...config, persistentProfileDir: '' }, combined, performance.now() + config.launchTimeoutMs);
      try {
        combined.throwIfAborted();
        return '✔ ' + instance.description + '（版本 ' + instance.browser!.version() + '）';
      } finally {
        await this.closeResource(instance.browser);
      }
    } catch (error) {
      combined.throwIfAborted();
      return error instanceof Error ? error.message : String(error);
    }
  }

  async close(): Promise<void> {
    await this.enqueue(async () => {
      await this.closeAllRetained();
      if (this.instance !== undefined) {
        await Promise.all(this.instance.leases);
        await this.closeInstance();
      }
    });
  }

  async dispose(): Promise<void> {
    this.lifetime.abort();
    await Promise.all([this.close(), Promise.allSettled(this.probes)]);
  }
}
