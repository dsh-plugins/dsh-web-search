/**
 * `browser_web_exec` 的脚本执行引擎。
 *
 * 把助手编写的 Playwright 脚本当作 async 函数体，在 `node:vm` 的独立上下文中
 * 执行，只暴露明确的绑定（页面、控制台、断言与少量标准内建）。这层上下文负责
 * 隔离变量作用域并能够中断脚本的**同步**段落，但 `page` 本身是宿主对象，
 * 脚本仍可经构造器链触达进程能力：它不是安全沙箱，只用于可信输入的测试场景。
 *
 * @module dsh-web-search/script
 */
import { createContext, Script } from 'node:vm';
import { setTimeout as delay } from 'node:timers/promises';
import type { Page } from 'playwright-core';
import { readBeforeDeadline, timeLeft } from './navigation.js';

/** 脚本长度上限（字符）。 */
export const MAX_SCRIPT_CHARS = 20000;
/** 返回值序列化后的默认上限（字符）。 */
export const DEFAULT_MAX_RESULT_CHARS = 20000;
/** 控制台输出的默认字符上限。 */
export const MAX_LOG_CHARS = 8000;
/** 控制台输出的默认行数上限。 */
export const MAX_LOG_ENTRIES = 200;
/** 脚本**同步**段落的默认上限（毫秒）：用于中断首段死循环。 */
export const DEFAULT_SYNC_TIMEOUT_MS = 5000;
/** 编译产物在错误信息中显示的文件名。 */
const SCRIPT_FILENAME = 'browser_web_exec.js';
/** 脚本被包进 async 函数体，前置部分与脚本首行同行以保持行号一致。 */
const PRELUDE = '(async () => {';
const EPILOGUE = '\n})()';

/** 一次脚本执行的结果；`ok` 为 false 时 `error` 说明原因。 */
export interface ScriptRunResult {
  readonly ok: boolean;
  /** 序列化后的返回值；脚本没有返回值时为 undefined。 */
  readonly result?: string;
  /** 脚本控制台输出（已按行数与字符数截断）。 */
  readonly logs?: string;
  readonly error?: string;
  readonly durationMs: number;
}

/** `runPlaywrightScript` 的入参。 */
export interface ScriptRunOptions {
  readonly script: string;
  readonly page: Page;
  readonly signal: AbortSignal;
  /** 整体执行截止时间（`performance.now()` 基准）。 */
  readonly endsAt: number;
  readonly maxResultChars?: number;
  readonly maxLogChars?: number;
  readonly maxLogEntries?: number;
  readonly syncTimeoutMs?: number;
}

function truncate(text: string, limit: number): string {
  if (text.length <= limit) {
    return text;
  }
  return text.slice(0, limit) + `…（已截断，原长 ${text.length} 字符）`;
}

/** 把任意值转成面向模型的文本：字符串原样，其余优先 JSON，失败时回退 String。 */
export function describeValue(value: unknown, limit: number): string {
  if (typeof value === 'string') {
    return truncate(value, limit);
  }
  if (value === undefined) {
    return 'undefined';
  }
  try {
    const json = JSON.stringify(value);
    if (typeof json === 'string') {
      return truncate(json, limit);
    }
  } catch {
    // 循环引用、BigInt 等无法 JSON 化的值走下面的回退。
  }
  try {
    return truncate(String(value), limit);
  } catch {
    return '[不可序列化的值]';
  }
}

/** 跨 realm 安全地提取错误消息（vm 内抛出的错误不是宿主 Error 的实例）。 */
export function messageOf(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message.length > 0) {
      return message.split('\n', 1)[0]!.trim();
    }
  }
  if (typeof error === 'string') {
    return error;
  }
  try {
    return String(error);
  } catch {
    return '脚本执行失败';
  }
}

/** 跨 realm 的结构比较：先严格相等，再比较 JSON 表示。 */
function sameValue(actual: unknown, expected: unknown): boolean {
  if (actual === expected || (Number.isNaN(actual) && Number.isNaN(expected))) {
    return true;
  }
  if (actual === null || expected === null || typeof actual !== 'object' || typeof expected !== 'object') {
    return false;
  }
  try {
    return JSON.stringify(actual) === JSON.stringify(expected);
  } catch {
    return false;
  }
}

/** 收集脚本的控制台输出，按行数与字符数双重截断。 */
class ScriptConsole {
  private readonly lines: string[] = [];
  private length = 0;
  private truncated = false;

  constructor(private readonly maxLines: number, private readonly maxChars: number) {}

  add(level: string, values: readonly unknown[]): void {
    if (this.lines.length >= this.maxLines || this.length >= this.maxChars) {
      this.truncated = true;
      return;
    }
    const line = `[${level}] ` + values.map((value) => describeValue(value, 2000)).join(' ');
    this.lines.push(line);
    this.length += line.length + 1;
  }

  text(): string | undefined {
    if (this.lines.length === 0) {
      return undefined;
    }
    const body = truncate(this.lines.join('\n'), this.maxChars);
    return this.truncated ? body + '\n…（输出已截断）' : body;
  }
}

/** 构造注入 vm 上下文的绑定；每个绑定都必须显式列出，不泄漏宿主全局。 */
function bindingsFor(page: Page, logs: ScriptConsole, options: ScriptRunOptions): Record<string, unknown> {
  const { endsAt, signal } = options;
  const show = (value: unknown): string => describeValue(value, 500);
  const sleep = async (ms: unknown): Promise<void> => {
    const requested = typeof ms === 'number' && Number.isFinite(ms) ? Math.max(0, ms) : 0;
    const remaining = timeLeft(endsAt);
    if (remaining === 0) {
      throw new Error('脚本执行已超时');
    }
    signal.throwIfAborted();
    await delay(Math.min(requested, remaining), undefined, { signal });
  };
  const assert = (condition: unknown, message?: unknown): void => {
    if (!condition) {
      throw new Error(typeof message === 'string' && message.length > 0 ? message : '断言失败');
    }
  };
  const assertEqual = (actual: unknown, expected: unknown, message?: unknown): void => {
    if (sameValue(actual, expected)) {
      return;
    }
    const head = typeof message === 'string' && message.length > 0 ? `${message}：` : '断言失败：';
    throw new Error(`${head}期望 ${show(expected)}，实际 ${show(actual)}`);
  };
  const console = {
    log: (...values: unknown[]) => logs.add('log', values),
    info: (...values: unknown[]) => logs.add('info', values),
    warn: (...values: unknown[]) => logs.add('warn', values),
    error: (...values: unknown[]) => logs.add('error', values),
    debug: (...values: unknown[]) => logs.add('debug', values),
  };
  return {
    page,
    context: page.context(),
    console,
    sleep,
    assert,
    assertEqual,
    URL,
    URLSearchParams,
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
  };
}

/**
 * 在受限上下文里执行一段 Playwright 脚本。
 *
 * 脚本必须用 `return` 交出结果。整体耗时受 `endsAt` 约束，同步段落另受
 * `syncTimeoutMs` 约束；两者都不会向调用方抛错，失败以 `{ ok: false }` 返回。
 */
export async function runPlaywrightScript(options: ScriptRunOptions): Promise<ScriptRunResult> {
  const started = performance.now();
  const logs = new ScriptConsole(options.maxLogEntries ?? MAX_LOG_ENTRIES, options.maxLogChars ?? MAX_LOG_CHARS);
  const resultLimit = options.maxResultChars ?? DEFAULT_MAX_RESULT_CHARS;
  const finish = (patch: Partial<ScriptRunResult>): ScriptRunResult => {
    const text = logs.text();
    return {
      ok: patch.ok ?? false,
      ...(patch.result !== undefined ? { result: patch.result } : {}),
      ...(text !== undefined ? { logs: text } : {}),
      ...(patch.error !== undefined ? { error: patch.error } : {}),
      durationMs: Math.round(performance.now() - started),
    };
  };

  let produced: unknown;
  if (options.signal.aborted) {
    return finish({ error: '脚本执行已取消' });
  }
  try {
    const compiled = new Script(PRELUDE + options.script + EPILOGUE, {
      filename: SCRIPT_FILENAME,
    });
    const context = createContext(bindingsFor(options.page, logs, options));
    // 同步段落在这里执行；表达式的结果是 async 函数体产生的 Promise。
    produced = compiled.runInContext(context, { timeout: options.syncTimeoutMs ?? DEFAULT_SYNC_TIMEOUT_MS });
  } catch (error) {
    const message = messageOf(error);
    return finish({
      error: /Script execution timed out/i.test(message)
        ? `脚本同步执行超过 ${options.syncTimeoutMs ?? DEFAULT_SYNC_TIMEOUT_MS} 毫秒（可能存在死循环）`
        : `脚本无法执行：${message}`,
    });
  }

  if (typeof (produced as { then?: unknown } | null)?.then !== 'function') {
    const text = describeValue(produced, resultLimit);
    return finish({ ok: true, ...(text === 'undefined' ? {} : { result: text }) });
  }

  const pending = produced as Promise<unknown>;
  // 超时或取消后脚本仍可能在后台推进，先挂上拒绝处理避免未处理拒绝告警。
  pending.catch(() => {});
  let settled: { readonly value: unknown } | undefined;
  try {
    settled = await readBeforeDeadline(async () => ({ value: await pending }), options.endsAt, options.signal);
  } catch (error) {
    const message = messageOf(error);
    return finish({
      error: options.signal.aborted || /abort/i.test(message) ? '脚本执行已取消' : `脚本执行失败：${message}`,
    });
  }
  if (settled === undefined) {
    return finish({ error: '脚本执行超过单次上限，已中止等待（脚本可能仍在页面中继续运行）' });
  }
  const text = describeValue(settled.value, resultLimit);
  return finish({ ok: true, ...(text === 'undefined' ? {} : { result: text }) });
}
