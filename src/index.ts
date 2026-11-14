
import type { Context } from '@deepseek-ai/cordis';
import type { HostAPI } from '@dsh-plugin/dsh-loader';
import type { SubagentRuntime } from '@deepseek-ai/dsh-subagent';
import { BrowserManager } from './browser.js';
import { registerBrowserTools, registerExecTool } from './browser-tools.js';
import { createConfigTemplate } from './config-template.js';
import { PLUGIN_NAME, resolvePluginConfig, type PluginConfig } from './config.js';
import type { DshFacade } from './dsh.js';
import { registerWebTools } from './tools.js';

export { PLUGIN_ID, PLUGIN_NAME, resolvePluginConfig } from './config.js';
export { SEARCH_ENGINE_DEFINITIONS, buildSearchUrl } from './engines.js';
export { BrowserManager, BrowserLaunchError } from './browser.js';

export const name = PLUGIN_NAME;
export const inject = ['dshLoader', 'llm', 'tools', 'systemPrompt'];

/** 注册独立的浏览器搜索、抓取和页面操作工具。 */
export async function apply(ctx: Context): Promise<void> {
  const loader = (ctx as Context & { dshLoader: DshFacade & Pick<HostAPI, 'config'> }).dshLoader;
  const manager = new BrowserManager(ctx.logger);
  ctx.effect(() => () => manager.dispose());

  let runtime: SubagentRuntime | undefined;
  ctx.inject(['subagents'], (scope) => {
    runtime = scope.get('subagents') as SubagentRuntime;
    scope.effect(() => () => { runtime = undefined; });
  });

  const handle = await loader.config.register<PluginConfig>(
    { effect: (fn) => ctx.effect(() => fn() ?? (() => {})) },
    createConfigTemplate(),
  );
  let snapshot = resolvePluginConfig(handle.get().value);
  const get = () => snapshot;
  const configureBrowser = (): void => {
    manager.configure(snapshot.search.enabled || snapshot.fetch.enabled || snapshot.exec.enabled ? snapshot.browser : undefined);
  };
  configureBrowser();
  const webTools = registerWebTools({ ctx, facade: loader, manager, get, subagents: () => runtime });
  ctx.effect(() => webTools.dispose);

  let disposeBrowserTools: (() => void) | undefined;
  const reconcileBrowserTools = (): void => {
    const wanted = get().exec.enabled || (get().subagent.enabled && get().subagent.maxRounds !== 0 && get().fetch.enabled);
    if (wanted && disposeBrowserTools === undefined) {
      disposeBrowserTools = registerBrowserTools(ctx, manager, loader, get);
    } else if (!wanted && disposeBrowserTools !== undefined) {
      disposeBrowserTools();
      disposeBrowserTools = undefined;
    }
  };
  ctx.effect(() => () => { disposeBrowserTools?.(); });

  let execTool: { maxDurationMs: number; dispose: () => void } | undefined;
  const reconcileExec = (): void => {
    const wanted = get().exec.enabled ? get().exec.maxDurationMs : undefined;
    if (execTool?.maxDurationMs === wanted) {
      return;
    }
    execTool?.dispose();
    execTool = wanted === undefined
      ? undefined
      : { maxDurationMs: wanted, dispose: registerExecTool(ctx, manager, loader, get) };
  };
  ctx.effect(() => () => { execTool?.dispose(); });

  handle.registerOperation('check-browser', async ({ signal }) => ({
    value: { report: await manager.probe(get().browser, signal) },
  }));
  handle.watch(({ value }) => {
    snapshot = resolvePluginConfig(value);
    configureBrowser();
    webTools.reconcile();
    reconcileBrowserTools();
    reconcileExec();
  });

  reconcileBrowserTools();
  reconcileExec();
}
