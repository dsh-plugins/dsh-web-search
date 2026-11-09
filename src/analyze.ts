/**
 * 分析模型调用：把页面 HTML 交给配置的模型，解析其严格 JSON 输出。
 *
 * @module dsh-web-search/analyze
 */
import type { Context } from '@deepseek-ai/cordis';
import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import { dsh, llm } from './dsh.js';
import { PLUGIN_NAME, type ResolvedModelRoute, type ResolvedPluginConfig } from './config.js';

/** 一次分析调用的结果：模型原文。 */
export interface AnalysisReply {
  readonly text: string;
  /** 模型触达 maxTokens 被截断。 */
  readonly truncated: boolean;
}

/** 拼装器输出的文本块拼接。 */
function blocksText(assembler: { blocks(): readonly ContentBlock[] }): string {
  return assembler.blocks()
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map((block) => block.text)
    .join('');
}

/**
 * 解析调用方会话的模型路由，作为未配置分析模型时的回退。
 * `exec.agent.options` 持有会话当前的 provider/model 选择。
 */
export function callerRouteOf(agent: { options?: { provider?: string; model?: string; reasoningEffort?: string } } | undefined): ResolvedModelRoute | undefined {
  const options = agent?.options;
  if (options === undefined || typeof options.provider !== 'string' || typeof options.model !== 'string'
    || options.provider.length === 0 || options.model.length === 0) {
    return undefined;
  }
  const route: { provider: string; model: string; reasoningEffort?: string } = { provider: options.provider, model: options.model };
  if (typeof options.reasoningEffort === 'string' && options.reasoningEffort.length > 0) {
    route.reasoningEffort = options.reasoningEffort;
  }
  return route;
}

/** 解析当前生效的分析模型路由：插件配置优先，其次调用方会话路由。 */
export function resolveAnalysisRoute(config: ResolvedPluginConfig, agent: Parameters<typeof callerRouteOf>[0]): ResolvedModelRoute {
  const route = config.analysis.route ?? callerRouteOf(agent);
  if (route === undefined) {
    throw new Error('dsh-web-search: 未配置分析模型，且无法从当前会话取得模型路由；请在插件设置中选择「分析模型」');
  }
  return route;
}

/** 调用分析模型并返回其文本输出。 */
export async function runAnalysis(
  ctx: Context,
  prompt: string,
  route: ResolvedModelRoute,
  config: ResolvedPluginConfig,
  signal: AbortSignal,
  sessionId: string | undefined,
): Promise<AnalysisReply> {
  const messages = [
    llm().createUserMessage({
      content: [{ type: 'text', text: prompt }],
      source: { kind: 'plugin', plugin: PLUGIN_NAME },
    }),
  ];
  const assembler = new (dsh().llm.BlockAssembler)();
  const stream = ctx.llm.stream({
    provider: route.provider,
    model: route.model,
    ...(route.reasoningEffort !== undefined ? { reasoningEffort: route.reasoningEffort } : {}),
    messages,
    maxTokens: config.analysis.maxTokens,
    ...(sessionId !== undefined ? { sessionId } : {}),
    signal,
  } as Parameters<Context['llm']['stream']>[0]);
  for await (const chunk of stream) {
    assembler.push(chunk);
  }
  const finish = assembler.finish;
  if (finish.kind === 'error' || finish.kind === 'aborted') {
    throw new Error(`dsh-web-search: 分析模型调用失败（${finish.failure.code}）：${finish.failure.message}`);
  }
  const text = blocksText(assembler);
  if (text.trim().length === 0) {
    throw new Error(`dsh-web-search: 分析模型没有产生文本${finish.kind === 'max-tokens' ? '（已达输出上限）' : ''}`);
  }
  return { text, truncated: finish.kind === 'max-tokens' };
}

/**
 * 从模型输出中解析严格 JSON 对象：容忍首尾说明文字与 ```json 围栏，
 * 截取首个 `{` 到末个 `}` 之间的内容解析。
 */
export function parseJsonObject(text: string): Record<string, unknown> {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const candidate = fenced?.[1] ?? text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) {
    throw new Error('dsh-web-search: 分析模型输出中找不到 JSON 对象');
  }
  let value: unknown;
  try {
    value = JSON.parse(candidate.slice(start, end + 1));
  } catch (error) {
    throw new Error(`dsh-web-search: 分析模型输出的 JSON 无法解析：${error instanceof Error ? error.message : String(error)}`);
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('dsh-web-search: 分析模型输出不是 JSON 对象');
  }
  return value as Record<string, unknown>;
}

/** 分析结果：成功负载或交互请求。 */
export type AnalysisOutcome =
  | { readonly status: 'ok'; readonly value: Record<string, unknown> }
  | { readonly status: 'interact'; readonly task: string };

/** 把解析后的 JSON 归一化为分析结果；`interact` 需要非空 task。 */
export function outcomeOf(value: Record<string, unknown>): AnalysisOutcome {
  if (value.status === 'interact' && typeof value.task === 'string' && value.task.trim().length > 0) {
    return { status: 'interact', task: value.task.trim() };
  }
  if (value.status === 'ok') {
    return { status: 'ok', value };
  }
  throw new Error('dsh-web-search: 分析模型输出的 status 既不是 ok 也不是带 task 的 interact');
}
