/**
 * 浏览器操作工具（`web_browser_*`）：主要由页面操作子代理使用，
 * 操作 `web_search` / `web_fetch` 在共享浏览器中打开的当前页面。
 *
 * @module dsh-web-search/browser-tools
 */
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
// 类型层侧导入：拉入 `ctx.tools` 的 Context 增强，编译期擦除。
import type {} from '@deepseek-ai/dsh-tools';
import type { Page } from 'playwright-core';
import { dsh } from './dsh.js';
import type { BrowserManager } from './browser.js';
import type { ResolvedPluginConfig } from './config.js';
import { captureSnapshot } from './html.js';

/** 读取调用方 Agent 的父会话 id（子代理场景）。 */
function parentSessionOf(agent: Agent | undefined): string | undefined {
  const header = agent?.session?.header as { parentSession?: unknown } | undefined;
  return typeof header?.parentSession === 'string' ? header.parentSession : undefined;
}

/** 定位当前可操作的页面；没有页面时给出可操作的错误提示。 */
function requirePage(manager: BrowserManager, agent: Agent | undefined): Page {
  const page = manager.pageFor(agent?.session?.id === undefined ? undefined : String(agent.session.id), parentSessionOf(agent));
  if (page === undefined) {
    throw new Error('没有已打开的浏览器页面：请先由 web_search / web_fetch 打开页面（页面操作通常由子代理在父工具调用期间执行）');
  }
  return page;
}

/** 操作后的短暂稳定等待。 */
async function settle(page: Page, config: ResolvedPluginConfig): Promise<void> {
  await page.waitForLoadState('load', { timeout: 5000 }).catch(() => {});
  if (config.browser.settleMs > 0) {
    await page.waitForTimeout(Math.min(config.browser.settleMs, 3000));
  }
}

/** 页面状态返回值的结构（各操作工具共用）。 */
interface PageState {
  url: string;
  title: string;
}

async function stateOf(page: Page): Promise<PageState> {
  return { url: page.url(), title: await page.title().catch(() => '') };
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
export function registerBrowserTools(ctx: Context, manager: BrowserManager, get: () => ResolvedPluginConfig): () => void {
  const defineTool = dsh().tools.defineTool;

  const disposers = [
    ctx.tools.register(defineTool({
      name: 'web_browser_read',
      description: 'Read the currently open browser page: URL, title, and visible text content. The page is the one opened by web_search / web_fetch; normally used by a delegated page-operation subagent.',
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
        const page = requirePage(manager, exec.agent);
        const snapshot = await captureSnapshot(page, 20000);
        return { url: snapshot.url, title: snapshot.title, text: snapshot.text };
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
        const page = requirePage(manager, exec.agent);
        await page.click(args.selector, { timeout: 10000 });
        await settle(page, get());
        return stateOf(page);
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
        const page = requirePage(manager, exec.agent);
        await page.fill(args.selector, args.text, { timeout: 10000 });
        if (args.submit === true) {
          await page.press(args.selector, 'Enter');
          await settle(page, get());
        }
        return stateOf(page);
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
        const page = requirePage(manager, exec.agent);
        await page.keyboard.press(args.key);
        await settle(page, get());
        return stateOf(page);
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
        const page = requirePage(manager, exec.agent);
        const amount = typeof args.amount === 'number' && Number.isFinite(args.amount) ? Math.abs(args.amount) : 600;
        await page.mouse.wheel(0, args.direction === 'up' ? -amount : amount);
        await settle(page, get());
        return stateOf(page);
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
        if (!/^https?:\/\//.test(args.url)) {
          throw new Error('web_browser_navigate: url 必须是 http(s) 绝对地址');
        }
        const page = requirePage(manager, exec.agent);
        await manager.navigate(page, args.url, get().browser);
        return stateOf(page);
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
        const page = requirePage(manager, exec.agent);
        await page.goBack({ timeout: 10000 }).catch(() => {});
        await settle(page, get());
        return stateOf(page);
      },
    })),
  ];

  return () => {
    for (const dispose of disposers) dispose();
  };
}
