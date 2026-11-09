/**
 * dsh-web-search — 浏览器版网页搜索与抓取。
 *
 * 提供 `web_search` 与 `web_fetch` 两个工具：页面在本机真实浏览器
 * （Chromium / Firefox / WebKit，Playwright 驱动）中打开，加载后抓取 HTML，
 * 交由配置的模型分析，分别返回结构化搜索结果与正文 Markdown。分析模型判断
 * 页面需要点击等交互时，可派出一次性子代理使用 `web_browser_*` 工具操作页面。
 * 启用本插件的某个工具时，官方同名工具在各 Agent 作用域内被同名注册遮蔽，
 * 其官方提示词节也从装配结果中移除。
 *
 * @module dsh-web-search
 */
import type { Context } from '@deepseek-ai/cordis';
import type { HostAPI } from '@dsh-plugin/dsh-loader';
import type { SubagentRuntime } from '@deepseek-ai/dsh-subagent';
import { BrowserManager } from './browser.js';
import { registerBrowserTools } from './browser-tools.js';
import { createConfigTemplate } from './config-template.js';
import { PLUGIN_NAME, resolvePluginConfig, type PluginConfig, type ResolvedPluginConfig } from './config.js';
import { clearDshFacade, setDshFacade, type DshFacade } from './dsh.js';
import { setSubagentRuntime } from './subagent.js';
import { registerWebTools, type WebToolsController } from './tools.js';

export { PLUGIN_ID, PLUGIN_NAME, resolvePluginConfig } from './config.js';
export { SEARCH_ENGINE_DEFINITIONS, buildSearchUrl } from './engines.js';
export { BrowserManager, BrowserLaunchError } from './browser.js';

/** Cordis 插件名（与 package.json 的 name 一致）。 */
export const name = PLUGIN_NAME;

/** 依赖的宿主服务。subagents 为可选服务，经 ctx.inject 按需获取。 */
export const inject = ['dshLoader', 'llm', 'tools', 'systemPrompt'];

/** Cordis 插件入口。 */
export async function apply(ctx: Context): Promise<void> {
  const loader = (ctx as Context & { dshLoader: DshFacade & Pick<HostAPI, 'config'> }).dshLoader;
  setDshFacade(loader);
  ctx.effect(() => () => {
    clearDshFacade();
    setSubagentRuntime(undefined);
  });

  // subagents 是可选服务：缺失时不影响基础搜索/抓取，只是无法派出子代理。
  ctx.inject(['subagents'], (scope) => {
    setSubagentRuntime(scope.get('subagents') as SubagentRuntime);
    scope.effect(() => () => setSubagentRuntime(undefined));
  });

  const handle = await loader.config.register<PluginConfig>(
    { effect: (fn) => ctx.effect(() => fn() ?? (() => {})) },
    createConfigTemplate(),
  );
  let snapshot: ResolvedPluginConfig = resolvePluginConfig(handle.get().value);
  const get = (): ResolvedPluginConfig => snapshot;

  const manager = new BrowserManager(ctx.logger);
  ctx.effect(() => () => {
    void manager.close();
  });

  // web_search / web_fetch 的作用域注册控制器常开：是否注册由安装时读取的
  // 配置决定（reconcile 会随配置保存重建各 Agent 的作用域注册）。
  const webTools: WebToolsController = registerWebTools(ctx, manager, get);
  ctx.effect(() => () => webTools.dispose());

  // 浏览器操作工具供页面操作子代理使用：子代理开关或两个主工具全关时不注册。
  let browserToolsDisposer: (() => void) | undefined;
  const reconcileBrowserTools = (): void => {
    const config = get();
    const wanted = config.subagent.enabled && (config.search.enabled || config.fetch.enabled);
    if (wanted && browserToolsDisposer === undefined) {
      browserToolsDisposer = registerBrowserTools(ctx, manager, get);
      return;
    }
    if (!wanted && browserToolsDisposer !== undefined) {
      const dispose = browserToolsDisposer;
      browserToolsDisposer = undefined;
      dispose();
    }
  };
  ctx.effect(() => () => {
    browserToolsDisposer?.();
    browserToolsDisposer = undefined;
  });

  // 诊断操作：按当前配置实际探测一次可用浏览器。
  handle.registerOperation('check-browser', async ({ signal }) => {
    signal.throwIfAborted();
    const report = await manager.probe(get().browser);
    signal.throwIfAborted();
    return { value: { report } };
  });

  handle.watch(({ value }) => {
    snapshot = resolvePluginConfig(value);
    webTools.reconcile();
    reconcileBrowserTools();
  });

  reconcileBrowserTools();
}
