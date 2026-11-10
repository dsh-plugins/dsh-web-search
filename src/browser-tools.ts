/**
 * 浏览器操作工具（`web_browser_*`）：主要由页面操作子代理使用，
 * 操作 `browser_web_fetch` 在父会话中打开的页面。
 *
 * @module dsh-web-search/browser-tools
 */
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
// 类型层侧导入：拉入 `ctx.tools` 的 Context 增强，编译期擦除。
import type {} from '@deepseek-ai/dsh-tools';
import type { Page } from 'playwright-core';
import type { DshFacade } from './dsh.js';
import type { BrowserManager, OpenPage } from './browser.js';
import { captureText } from './html.js';
import { readBeforeDeadline, timeLeft } from './navigation.js';

/** 读取调用方 Agent 的父会话 id（子代理场景）。 */
function parentSessionOf(agent: Agent | undefined): string | undefined {
  const header = agent?.session?.header as { parentSession?: unknown } | undefined;
  return typeof header?.parentSession === 'string' ? header.parentSession : undefined;
}

/** 定位当前可操作的页面；没有页面时给出可操作的错误提示。 */
function requirePage(manager: BrowserManager, agent: Agent | undefined): OpenPage {
  const page = manager.sessionPage(agent?.session?.id === undefined ? undefined : String(agent.session.id), parentSessionOf(agent));
  if (page === undefined) {
    throw new Error('没有已打开的浏览器页面：请先由 browser_web_fetch 打开页面（页面操作通常由子代理在父工具调用期间执行）');
  }
  return page;
}

async function perform(
  record: OpenPage,
  signal: AbortSignal,
  action: (page: Page, timeout: number) => Promise<unknown>,
): Promise<PageState> {
  const combined = AbortSignal.any([record.signal, signal]);
  const remaining = timeLeft(record.endsAt);
  combined.throwIfAborted();
  if (remaining === 0) {
    throw new Error('浏览器操作超时');
  }
  const operationEnd = performance.now() + Math.min(remaining, 28500);
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
 * 注册全部 `web_browser_*` 工具；返回统一清理函数。
 */
export function registerBrowserTools(ctx: Context, manager: BrowserManager, facade: DshFacade): () => void {
  const defineTool = facade.dsh.tools.defineTool;

  const disposers = [
    ctx.tools.register(defineTool({
      name: 'web_browser_read',
      description: 'Read the currently open browser page: URL, title, and visible text content. The page is the one opened by browser_web_fetch; normally used by a delegated page-operation subagent.',
      parameters: {},
      output: {
        schema: {
          type: 'object', additionalProperties: false,
          properties: {
            url: { type: 'string' },
            title: { type: 'string' },
            text: { type: 'string' },
          },
        },
        render: (_args, value) => [{ type: 'text', text: `# ${value.title ?? ''}\n${value.url ?? ''}\n\n${value.text ?? ''}` }],
      },
      timeoutMs: 30000,
      async execute(_args, exec) {
        const { page, signal, endsAt } = requirePage(manager, exec.agent);
        const combined = AbortSignal.any([signal, exec.signal]);
        const deadline = Math.min(endsAt, performance.now() + 28500);
        const content = await readBeforeDeadline(() => captureText(page, 20000), deadline, combined);
        if (content === undefined) {
          throw new Error('浏览器读取超时');
        }
        return { ...await stateOf(page, combined, deadline), text: content.text };
      },
    })),
    ctx.tools.register(defineTool({
      name: 'web_browser_click',
      description: 'Click an element on the currently open browser page by CSS selector. Returns the resulting page state.',
      parameters: {
        selector: { type: 'string', required: true, description: 'CSS selector of the element to click (e.g. button:has-text("同意")).' },
      },
      output: {
        schema: STATE_SCHEMA,
        render: (_args, value) => [{ type: 'text', text: `已点击。当前页面：${value.title ?? ''}（${value.url ?? ''}）` }],
      },
      timeoutMs: 30000,
      async execute(args, exec) {
        return perform(requirePage(manager, exec.agent), exec.signal,
          (page, timeout) => page.click(args.selector, { timeout }));
      },
    })),
    ctx.tools.register(defineTool({
      name: 'web_browser_type',
      description: 'Clear and type text into an input on the currently open browser page, optionally pressing Enter afterwards.',
      parameters: {
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
        return perform(requirePage(manager, exec.agent), exec.signal, async (page, timeout) => {
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
        });
      },
    })),
    ctx.tools.register(defineTool({
      name: 'web_browser_press',
      description: 'Press a keyboard key on the currently open browser page (e.g. Enter, Escape, Tab).',
      parameters: {
        key: { type: 'string', required: true, description: 'Key name, e.g. "Enter", "Escape", "Tab", "ArrowDown".' },
      },
      output: {
        schema: STATE_SCHEMA,
        render: (_args, value) => [{ type: 'text', text: `已按键。当前页面：${value.title ?? ''}（${value.url ?? ''}）` }],
      },
      timeoutMs: 30000,
      async execute(args, exec) {
        return perform(requirePage(manager, exec.agent), exec.signal, (page) => page.keyboard.press(args.key));
      },
    })),
    ctx.tools.register(defineTool({
      name: 'web_browser_scroll',
      description: 'Scroll the currently open browser page up or down.',
      parameters: {
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
        return perform(requirePage(manager, exec.agent), exec.signal,
          (page) => page.mouse.wheel(0, args.direction === 'up' ? -amount : amount));
      },
    })),
    ctx.tools.register(defineTool({
      name: 'web_browser_navigate',
      description: 'Navigate the currently open browser page to a new URL and wait for it to load.',
      parameters: {
        url: { type: 'string', required: true, description: 'Absolute http(s) URL to open.' },
      },
      output: {
        schema: STATE_SCHEMA,
        render: (_args, value) => [{ type: 'text', text: `已打开：${value.title ?? ''}（${value.url ?? ''}）` }],
      },
      timeoutMs: 60000,
      async execute(args, exec) {
        const record = requirePage(manager, exec.agent);
        const url = URL.parse(args.url);
        if (url === null || !['http:', 'https:'].includes(url.protocol) || url.username || url.password
          || url.hostname !== URL.parse(record.page.url())?.hostname) {
          throw new Error('web_browser_navigate: url 必须是当前站点内无凭据的 HTTP(S) 绝对地址');
        }
        const combined = AbortSignal.any([record.signal, exec.signal]);
        const endsAt = Math.min(record.endsAt, performance.now() + 59000);
        const result = await record.navigation.open(url.href, { ...record.config, challengeWaitMs: 0 }, combined, endsAt);
        if (result.status === 'error' || result.status === 'timeout') {
          throw new Error(result.reason);
        }
        return stateOf(record.page, combined, endsAt);
      },
    })),
    ctx.tools.register(defineTool({
      name: 'web_browser_back',
      description: 'Go back to the previous page in the currently open browser page history.',
      parameters: {},
      output: {
        schema: STATE_SCHEMA,
        render: (_args, value) => [{ type: 'text', text: `已后退。当前页面：${value.title ?? ''}（${value.url ?? ''}）` }],
      },
      timeoutMs: 30000,
      async execute(args, exec) {
        void args;
        return perform(requirePage(manager, exec.agent), exec.signal,
          (page, timeout) => page.goBack({ timeout, waitUntil: 'commit' }));
      },
    })),
  ];

  return () => {
    for (const dispose of disposers) {
      dispose();
    }
  };
}
