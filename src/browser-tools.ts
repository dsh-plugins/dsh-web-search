/**
 * 浏览器操作工具（`browser_web_open` 与 `web_browser_*`）：
 * 按 ID 打开、读取和操作保留的浏览器页面。
 *
 * 页面由 `browser_web_open` 显式打开，或由 `browser_web_search` /
 * `browser_web_fetch` 在 `timeout` 大于 0 时顺带保留；所有工具都通过
 * 返回的页面 ID 寻址，同一页面上的操作串行执行。
 *
 * @module dsh-web-search/browser-tools
 */
import type { Context } from '@deepseek-ai/cordis';
// 类型层侧导入：拉入 `ctx.tools` 的 Context 增强，编译期擦除。
import type {} from '@deepseek-ai/dsh-tools';
import type { Page } from 'playwright-core';
import {
  DEFAULT_PAGE_RETENTION_S,
  MAX_PAGE_RETENTION_S,
  retentionMsOf,
  type ResolvedPluginConfig,
} from './config.js';
import type { DshFacade } from './dsh.js';
import type { BrowserManager, RetainedPage } from './browser.js';
import { captureSnapshot, captureText } from './html.js';
import { readBeforeDeadline, timeLeft } from './navigation.js';

/** 单次页面操作的时间预算（工具 timeoutMs 为 30 秒）。 */
const OPERATION_BUDGET_MS = 28500;
/** web_browser_read 的纯文本输出上限。 */
const READ_TEXT_CHARS = 20000;
/** web_browser_read 的 DOM 输出上限。 */
const READ_DOM_CHARS = 200000;

/** 所有页面操作工具共用的 ID 参数。 */
const ID_PARAMETER = {
  type: 'string',
  required: true,
  description: 'browser_web_open 返回的页面 ID；browser_web_search / browser_web_fetch 在 timeout 大于 0 时也会返回 pageId。',
} as const;

/** 校验 http(s) 无凭据绝对地址；返回规范化后的 URL 字符串。 */
function checkedHttpUrl(tool: string, raw: string): string {
  const url = URL.parse(raw);
  if (url === null || !['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error(`${tool}: url 必须是无凭据的 HTTP(S) 绝对地址`);
  }
  return url.href;
}

async function perform(
  record: RetainedPage,
  signal: AbortSignal,
  action: (page: Page, timeout: number) => Promise<unknown>,
): Promise<PageState> {
  const combined = AbortSignal.any([record.signal, signal]);
  combined.throwIfAborted();
  const operationEnd = performance.now() + OPERATION_BUDGET_MS;
  await record.navigation.afterAction(combined, record.config.settleMs, operationEnd, async () => {
    const timeout = Math.min(10000, timeLeft(operationEnd));
    if (timeout === 0) {
      throw new Error('浏览器操作超时');
    }
    await action(record.page, timeout);
  });
  return stateOf(record.page, combined, operationEnd);
}

/** 页面状态返回值的结构（各操作工具共用）。 */
interface PageState {
  url: string;
  title: string;
}

async function stateOf(page: Page, signal: AbortSignal, endsAt: number): Promise<PageState> {
  const title = await readBeforeDeadline(() => page.title(), endsAt, signal);
  return { url: page.url(), title: title ?? '' };
}

const STATE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    url: { type: 'string' },
    title: { type: 'string' },
  },
} as const;

/**
 * 注册 `browser_web_open` 与全部 `web_browser_*` 工具；返回统一清理函数。
 */
export function registerBrowserTools(
  ctx: Context,
  manager: BrowserManager,
  facade: DshFacade,
  get: () => ResolvedPluginConfig,
): () => void {
  const defineTool = facade.dsh.tools.defineTool;

  const disposers = [
    ctx.tools.register(defineTool({
      name: 'browser_web_open',
      description: 'Open an HTTP(S) page in a managed browser and keep it alive. Returns a page ID for web_browser_read/navigate/click/type/press/scroll/back. The page closes automatically after `timeout` seconds without any operation.',
      parameters: {
        url: { type: 'string', required: true, description: 'Absolute http(s) URL to open.' },
        timeout: {
          type: 'integer',
          description: `Idle lifetime of the page in seconds, 1–${MAX_PAGE_RETENTION_S}. The page closes when no operation touches it for this long; any web_browser_* operation resets the timer. Defaults to ${DEFAULT_PAGE_RETENTION_S}. 0 closes the page right after opening (the returned ID becomes unusable).`,
        },
      },
      output: {
        schema: {
          type: 'object', additionalProperties: false,
          properties: {
            id: { type: 'string', required: true },
            url: { type: 'string' },
            title: { type: 'string' },
            status: { type: 'string', enum: ['empty', 'blocked', 'timeout', 'error'] },
            reason: { type: 'string' },
          },
        },
        render: (_args, value) => [{
          type: 'text',
          text: `已打开页面（ID: ${value.id ?? ''}）：${value.title ?? ''}（${value.url ?? ''}）`
            + (value.status !== undefined ? `\n导航状态：${value.status}${value.reason ? ' · ' + value.reason : ''}` : ''),
        }],
        presentationMeta: (_args, value) => ({ title: value.title === undefined || value.title === '' ? '打开页面' : `打开页面：${value.title}`, link: value.url ?? '' }),
      },
      timeoutMs: 90000,
      async execute(args, exec) {
        const url = checkedHttpUrl('browser_web_open', args.url);
        const timeoutMs = retentionMsOf(args.timeout);
        const opened = await manager.openRetainedPage(get().browser, { url, timeoutMs }, exec.signal);
        const observation = opened.observation;
        const value = {
          id: opened.id,
          url: observation?.state.url ?? 'about:blank',
          title: observation?.state.title ?? '',
          ...(observation !== undefined && observation.status !== 'ready'
            ? { status: observation.status, ...(observation.reason ? { reason: observation.reason } : {}) }
            : {}),
        };
        // timeout 为 0 表示不保留：返回初始状态后立即关闭，ID 随之失效。
        if (timeoutMs === 0) {
          await manager.closeRetained(opened.id);
        }
        return value;
      },
    })),
    ctx.tools.register(defineTool({
      name: 'web_browser_read',
      description: 'Read an open browser page by ID: URL, title, and page content. format "text" returns visible text; format "dom" returns the cleaned DOM.',
      parameters: {
        id: ID_PARAMETER,
        format: { type: 'string', enum: ['text', 'dom'], description: '"text" (default) returns visible text content; "dom" returns the cleaned page DOM.' },
      },
      output: {
        schema: {
          type: 'object', additionalProperties: false,
          properties: {
            url: { type: 'string' },
            title: { type: 'string' },
            text: { type: 'string' },
            dom: { type: 'string' },
          },
        },
        render: (_args, value) => [{
          type: 'text',
          text: `# ${value.title ?? ''}\n${value.url ?? ''}\n\n${value.dom ?? value.text ?? ''}`,
        }],
      },
      timeoutMs: 30000,
      async execute(args, exec) {
        return await manager.useRetained(args.id, async (record) => {
          const combined = AbortSignal.any([record.signal, exec.signal]);
          const deadline = performance.now() + OPERATION_BUDGET_MS;
          if (args.format === 'dom') {
            const snapshot = await readBeforeDeadline(() => captureSnapshot(record.page, READ_DOM_CHARS), deadline, combined);
            if (snapshot === undefined) {
              throw new Error('浏览器读取超时');
            }
            return { url: snapshot.url, title: snapshot.title, dom: snapshot.html };
          }
          const content = await readBeforeDeadline(() => captureText(record.page, READ_TEXT_CHARS), deadline, combined);
          if (content === undefined) {
            throw new Error('浏览器读取超时');
          }
          return { ...await stateOf(record.page, combined, deadline), text: content.text };
        });
      },
    })),
    ctx.tools.register(defineTool({
      name: 'web_browser_click',
      description: 'Click an element on an open browser page by CSS selector. Returns the resulting page state.',
      parameters: {
        id: ID_PARAMETER,
        selector: { type: 'string', required: true, description: 'CSS selector of the element to click (e.g. button:has-text("同意")).' },
      },
      output: {
        schema: STATE_SCHEMA,
        render: (_args, value) => [{ type: 'text', text: `已点击。当前页面：${value.title ?? ''}（${value.url ?? ''}）` }],
      },
      timeoutMs: 30000,
      async execute(args, exec) {
        return await manager.useRetained(args.id, (record) =>
          perform(record, exec.signal, (page, timeout) => page.click(args.selector, { timeout })));
      },
    })),
    ctx.tools.register(defineTool({
      name: 'web_browser_type',
      description: 'Clear and type text into an input on an open browser page, optionally pressing Enter afterwards.',
      parameters: {
        id: ID_PARAMETER,
        selector: { type: 'string', required: true, description: 'CSS selector of the input/textarea (e.g. input[name="q"]).' },
        text: { type: 'string', required: true, description: 'Text to type.' },
        submit: { type: 'boolean', description: 'Press Enter after typing. Defaults to false.' },
      },
      output: {
        schema: STATE_SCHEMA,
        render: (_args, value) => [{ type: 'text', text: `已输入。当前页面：${value.title ?? ''}（${value.url ?? ''}）` }],
      },
      timeoutMs: 30000,
      async execute(args, exec) {
        return await manager.useRetained(args.id, (record) =>
          perform(record, exec.signal, async (page, timeout) => {
            const endsAt = performance.now() + timeout;
            await page.fill(args.selector, args.text, { timeout });
            if (args.submit === true) {
              const remaining = timeLeft(endsAt);
              if (remaining === 0) {
                throw new Error('浏览器输入超时');
              }
              exec.signal.throwIfAborted();
              await page.press(args.selector, 'Enter', { timeout: remaining });
            }
          }));
      },
    })),
    ctx.tools.register(defineTool({
      name: 'web_browser_press',
      description: 'Press a keyboard key on an open browser page (e.g. Enter, Escape, Tab).',
      parameters: {
        id: ID_PARAMETER,
        key: { type: 'string', required: true, description: 'Key name, e.g. "Enter", "Escape", "Tab", "ArrowDown".' },
      },
      output: {
        schema: STATE_SCHEMA,
        render: (_args, value) => [{ type: 'text', text: `已按键。当前页面：${value.title ?? ''}（${value.url ?? ''}）` }],
      },
      timeoutMs: 30000,
      async execute(args, exec) {
        return await manager.useRetained(args.id, (record) =>
          perform(record, exec.signal, (page) => page.keyboard.press(args.key)));
      },
    })),
    ctx.tools.register(defineTool({
      name: 'web_browser_scroll',
      description: 'Scroll an open browser page up or down.',
      parameters: {
        id: ID_PARAMETER,
        direction: { type: 'string', required: true, enum: ['up', 'down'], description: 'Scroll direction.' },
        amount: { type: 'integer', description: 'Scroll distance in pixels. Defaults to 700.' },
      },
      output: {
        schema: STATE_SCHEMA,
        render: (_args, value) => [{ type: 'text', text: `已滚动。当前页面：${value.title ?? ''}（${value.url ?? ''}）` }],
      },
      timeoutMs: 30000,
      async execute(args, exec) {
        const amount = args.amount === undefined ? 700 : Math.abs(args.amount);
        return await manager.useRetained(args.id, (record) =>
          perform(record, exec.signal, (page) => page.mouse.wheel(0, args.direction === 'up' ? -amount : amount)));
      },
    })),
    ctx.tools.register(defineTool({
      name: 'web_browser_navigate',
      description: 'Navigate an open browser page to a new URL and wait for it to load.',
      parameters: {
        id: ID_PARAMETER,
        url: { type: 'string', required: true, description: 'Absolute http(s) URL to open.' },
      },
      output: {
        schema: STATE_SCHEMA,
        render: (_args, value) => [{ type: 'text', text: `已打开：${value.title ?? ''}（${value.url ?? ''}）` }],
      },
      timeoutMs: 60000,
      async execute(args, exec) {
        const url = checkedHttpUrl('web_browser_navigate', args.url);
        return await manager.useRetained(args.id, async (record) => {
          const combined = AbortSignal.any([record.signal, exec.signal]);
          const endsAt = performance.now() + 59000;
          const result = await record.navigation.open(url, { ...record.config, challengeWaitMs: 0 }, combined, endsAt);
          if (result.status === 'error' || result.status === 'timeout') {
            throw new Error(result.reason);
          }
          return stateOf(record.page, combined, endsAt);
        });
      },
    })),
    ctx.tools.register(defineTool({
      name: 'web_browser_back',
      description: 'Go back to the previous page in the open browser page history.',
      parameters: {
        id: ID_PARAMETER,
      },
      output: {
        schema: STATE_SCHEMA,
        render: (_args, value) => [{ type: 'text', text: `已后退。当前页面：${value.title ?? ''}（${value.url ?? ''}）` }],
      },
      timeoutMs: 30000,
      async execute(args, exec) {
        return await manager.useRetained(args.id, (record) =>
          perform(record, exec.signal, (page, timeout) => page.goBack({ timeout, waitUntil: 'commit' })));
      },
    })),
  ];

  return () => {
    for (const dispose of disposers) {
      dispose();
    }
  };
}
