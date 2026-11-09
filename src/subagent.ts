/**
 * 页面操作子代理：把需要点击、输入等交互的任务委托给一次性子代理执行。
 *
 * 子代理通过 `ctx.subagents` 的 `spawn` 提供方在进程内运行；本插件注册的
 * `web_browser_*` 工具操作父代理打开的同一个浏览器页面。
 *
 * @module dsh-web-search/subagent
 */
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import type { SubagentRuntime, SubagentStartRequest } from '@deepseek-ai/dsh-subagent';
import type { ResolvedModelRoute } from './config.js';
import { buildSubagentPrompt } from './prompt.js';

let runtime: SubagentRuntime | undefined;

/** 由入口在 `subagents` 服务可用时注入。 */
export function setSubagentRuntime(value: SubagentRuntime | undefined): void {
  runtime = value;
}

/** 子代理能力是否可用。 */
export function subagentAvailable(): boolean {
  return runtime !== undefined;
}

/** 提取子代理最终输出中的文本。 */
function outputText(output: readonly ContentBlock[]): string {
  return output
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim();
}

/**
 * 派出一次性子代理执行页面操作任务，返回其汇报文本。
 *
 * @param parent - 发起调用的 Agent（`exec.agent`）；子代理从它继承工作区与谱系。
 * @param route - 配置的子代理模型路由；undefined 时沿用父代理路由。
 */
export async function runPageSubagent(
  parent: Agent | undefined,
  task: string,
  route: ResolvedModelRoute | undefined,
  signal: AbortSignal,
): Promise<string> {
  if (runtime === undefined) {
    throw new Error('dsh-web-search: 当前部署没有 subagents 服务，无法派出子代理');
  }
  if (parent === undefined) {
    throw new Error('dsh-web-search: 当前调用不隶属于任何 Agent，无法派出子代理');
  }
  const prompt = buildSubagentPrompt(task);
  const base: SubagentStartRequest = {
    label: 'dsh-web-search 页面操作',
    prompt: [{ type: 'text', text: prompt } as ContentBlock],
    parent,
    signal,
  };
  // 旧版提供方可能不支持 agentOptions 能力：携带路由启动被拒绝时不带路由重试。
  let run;
  try {
    run = await runtime.start('spawn', route === undefined ? base : {
      ...base,
      agentOptions: {
        provider: route.provider,
        model: route.model,
        ...(route.reasoningEffort !== undefined ? { reasoningEffort: route.reasoningEffort } : {}),
      },
    });
  } catch (error) {
    if (route === undefined) throw error;
    run = await runtime.start('spawn', base);
  }
  try {
    const result = await run.result;
    const text = outputText(result.output);
    if (result.stopReason !== 'completed') {
      throw new Error(`dsh-web-search: 页面操作子代理未正常完成（${result.stopReason}）${text.length > 0 ? `：${text}` : ''}`);
    }
    return text.length > 0 ? text : '子代理已完成页面操作（无文字汇报）。';
  } finally {
    await run.dispose();
  }
}
