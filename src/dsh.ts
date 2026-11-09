/**
 * dsh-web-search 的 dsh 符号接入点。
 *
 * 本插件需要 dsh 的**模块级**导出（`defineTool`、`deadline`、`createUserMessage`、
 * `deepFreeze`、`BlockAssembler`），它们不是 cordis 服务方法，`ctx.get(...)` 拿不到；
 * 直接 `import` `@deepseek-ai/*` 会把插件绑死在 dsh 内部面上。因此统一经
 * `ctx.dshLoader` 的 `dsh` / `llm` 门面在启动期解析，由 {@link setDshFacade} 注入。
 *
 * @module dsh-web-search/dsh
 */
import type * as DshTools from '@deepseek-ai/dsh-tools';
import type * as DshTimeout from '@deepseek-ai/dsh-timeout';
import type * as DshLlm from '@deepseek-ai/dsh-llm';

/** dshloader 的 `dsh` 门面里本插件用到的部分，签名与 dsh 本体一致。 */
export interface DshSymbols {
  tools: {
    defineTool: typeof DshTools.defineTool;
    readonly ToolArgsError: typeof DshTools.ToolArgsError;
  };
  timeout: {
    deadline: typeof DshTimeout.deadline;
  };
  llm: {
    readonly BlockAssembler: typeof DshLlm.BlockAssembler;
  };
}

/** dshloader 的 `llm` 门面里本插件用到的部分。 */
export interface LlmHelpers {
  createUserMessage: typeof DshLlm.createUserMessage;
  deepFreeze: typeof DshLlm.deepFreeze;
}

/** `ctx.dshLoader` 中本插件依赖的两个门面。 */
export interface DshFacade {
  dsh: DshSymbols;
  llm: LlmHelpers;
}

let facade: DshFacade | undefined;

/** 在 `apply` 最开始注入 `ctx.dshLoader`。 */
export function setDshFacade(value: DshFacade): void {
  facade = value;
}

/** 清除注入（插件卸载 / 测试隔离用）。 */
export function clearDshFacade(): void {
  facade = undefined;
}

/** dsh 的模块级符号；只能在 `apply` 注入门面之后调用。 */
export function dsh(): DshSymbols {
  if (facade === undefined) {
    throw new Error('dsh-web-search: ctx.dshLoader 尚未注入；dsh() 只能在 apply 之后调用');
  }
  return facade.dsh;
}

/** dsh 的 LLM 消息构造 helper。 */
export function llm(): LlmHelpers {
  if (facade === undefined) {
    throw new Error('dsh-web-search: ctx.dshLoader 尚未注入；llm() 只能在 apply 之后调用');
  }
  return facade.llm;
}

/** 递归冻结：门面可用时复用 dsh 的 `deepFreeze`，否则本地实现（供纯函数测试使用）。 */
export function deepFreeze<T>(value: T): T {
  if (facade !== undefined) return facade.llm.deepFreeze(value);
  if (value === null || typeof value !== 'object') return value;
  if (Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const key of Object.keys(value as Record<string, unknown>)) {
    deepFreeze((value as Record<string, unknown>)[key]);
  }
  return value;
}
