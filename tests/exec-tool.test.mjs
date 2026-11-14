import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defineTool, ToolArgsError } from '@deepseek-ai/dsh-tools';
import { deadline } from '@deepseek-ai/dsh-timeout';
import { registerExecTool } from '../lib/browser-tools.js';
import { resolvePluginConfig } from '../lib/config.js';

/** 构造一个可被脚本引擎调用的假页面。 */
function fakePage() {
  return {
    context: () => ({ pages: () => [] }),
    url: () => 'https://example.com/exec',
    title: async () => '执行页',
  };
}

/** 注册一套只记录工具定义与页面操作的桩环境。 */
function harness(config = resolvePluginConfig(undefined)) {
  const tools = new Map();
  const opened = [];
  const closed = [];
  const used = [];
  const ctx = {
    tools: { register(tool) { tools.set(tool.name, tool); return () => tools.delete(tool.name); } },
    on() { return () => {}; },
    systemPrompt: { section() { return () => {}; } },
  };
  const facade = { dsh: { tools: { defineTool, ToolArgsError }, timeout: { deadline } } };
  const manager = {
    async openRetainedPage(_config, options) {
      opened.push(options);
      return {
        id: 'page-1', page: fakePage(), signal: new AbortController().signal,
        navigation: { async publicCacheTtl() { return 0; } },
        observation: options.url === undefined
          ? undefined
          : { status: 'ready', state: { url: options.url, title: '执行页', candidates: [] } },
      };
    },
    async useRetained(id, fn) {
      used.push(id);
      return fn({ id, page: fakePage(), signal: new AbortController().signal, config: {}, navigation: {} });
    },
    async closeRetained(id) { closed.push(id); return true; },
  };
  const dispose = registerExecTool(ctx, manager, facade, () => config);
  return { tools, tool: tools.get('browser_web_exec'), opened, closed, used, dispose };
}

test('url 模式打开页面、执行脚本并保留页面', async () => {
  const env = harness();
  try {
    assert.ok(env.tool, '工具应已注册');
    const value = await env.tool.execute({ url: 'https://example.com/exec', script: 'return await page.title()' }, { signal: new AbortController().signal });
    assert.equal(value.ok, true);
    assert.equal(value.result, '执行页');
    assert.equal(value.pageId, 'page-1');
    assert.equal(value.url, 'https://example.com/exec');
    assert.equal(value.title, '执行页');
    assert.equal(typeof value.durationMs, 'number');
    assert.equal(env.opened[0].url, 'https://example.com/exec');
    assert.deepEqual(env.used, ['page-1']);
    assert.deepEqual(env.closed, []);
  } finally {
    env.dispose();
  }
});

test('timeout 为 0 时执行完立即关闭页面', async () => {
  const env = harness();
  try {
    const value = await env.tool.execute({ url: 'https://example.com/exec', timeout: 0, script: 'return 1' }, { signal: new AbortController().signal });
    assert.equal(value.ok, true);
    assert.deepEqual(env.closed, ['page-1']);
    assert.equal(env.opened[0].timeoutMs, 0);
  } finally {
    env.dispose();
  }
});

test('pageId 模式复用页面且忽略 timeout', async () => {
  const env = harness();
  try {
    const value = await env.tool.execute({ pageId: 'page-9', timeout: 0, script: 'return "复用"' }, { signal: new AbortController().signal });
    assert.equal(value.ok, true);
    assert.equal(value.result, '复用');
    assert.equal(value.pageId, 'page-9');
    assert.deepEqual(env.opened, []);
    assert.deepEqual(env.used, ['page-9']);
    assert.deepEqual(env.closed, []);
  } finally {
    env.dispose();
  }
});

test('脚本失败时仍返回页面 ID 与错误', async () => {
  const env = harness();
  try {
    const value = await env.tool.execute({ url: 'https://example.com/exec', script: 'throw new Error("选择器不存在")' }, { signal: new AbortController().signal });
    assert.equal(value.ok, false);
    assert.match(value.error, /选择器不存在/);
    assert.equal(value.pageId, 'page-1');
  } finally {
    env.dispose();
  }
});

test('参数错误抛出 ToolArgsError', async () => {
  const env = harness();
  try {
    const exec = { signal: new AbortController().signal };
    await assert.rejects(env.tool.execute({ script: '   ' }, exec), ToolArgsError);
    await assert.rejects(env.tool.execute({ url: 'https://example.com', pageId: 'p', script: 'return 1' }, exec), ToolArgsError);
    await assert.rejects(env.tool.execute({ script: 'x'.repeat(20001) }, exec), ToolArgsError);
    await assert.rejects(env.tool.execute({ url: 'file:///etc/passwd', script: 'return 1' }, exec), /HTTP\(S\)/);
  } finally {
    env.dispose();
  }
});

test('工具 budget 跟随配置的执行上限', async () => {
  const config = resolvePluginConfig({ exec: { maxDurationMs: 5000 } });
  assert.equal(config.exec.maxDurationMs, 5000);
  const env = harness(config);
  try {
    assert.equal(env.tool.timeoutMs, 5000 + 60000);
  } finally {
    env.dispose();
  }
});
