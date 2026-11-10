/**
 * dsh-web-search 的 dsh 符号接入点。
 *
 * 本插件需要 dsh 的**模块级**导出（`defineTool`、`deadline`、`createUserMessage`、
 * `BlockAssembler`），它们不是 cordis 服务方法，`ctx.get(...)` 拿不到；
 * 直接 `import` `@deepseek-ai/*` 会把插件绑死在 dsh 内部面上。因此统一经
 * `ctx.dshLoader` 的 `dsh` / `llm` 门面在启动期解析。
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
}

/** `ctx.dshLoader` 中本插件依赖的两个门面。 */
export interface DshFacade {
  dsh: DshSymbols;
  llm: LlmHelpers;
}
