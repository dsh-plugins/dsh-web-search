import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeValue, messageOf, runPlaywrightScript } from '../lib/script.js';

/** 脚本引擎只通过 page.context() 取上下文，其余页面 API 由脚本自行调用。 */
const page = {
  context: () => ({ pages: () => [] }),
  url: () => 'https://example.com/',
  title: async () => '示例页面',
};
const signal = new AbortController().signal;

function run(script, overrides = {}) {
  return runPlaywrightScript({ script, page, signal, endsAt: performance.now() + 5000, ...overrides });
}

test('返回值序列化：字符串原样，其余用 JSON', async () => {
  assert.equal((await run('return "文本"')).result, '文本');
  assert.equal((await run('return { a: 1, b: [2] }')).result, '{"a":1,"b":[2]}');
  assert.equal((await run('return 7')).result, '7');
  assert.equal((await run('const x = 1;')).result, undefined);
  assert.equal((await run('return "文本"')).ok, true);
});

test('控制台输出被捕获并按行数截断', async () => {
  const captured = await run('console.log("a", 1); console.warn("b"); return 1');
  assert.equal(captured.logs, '[log] a 1\n[warn] b');
  const limited = await run('for (let i = 0; i < 10; i += 1) console.log(i); return 1', { maxLogEntries: 3 });
  assert.equal(limited.logs, '[log] 0\n[log] 1\n[log] 2\n…（输出已截断）');
});

test('返回结果按字符上限截断', async () => {
  const truncated = await run('return "x".repeat(50)', { maxResultChars: 10 });
  assert.match(truncated.result, /^x{10}…（已截断，原长 50 字符）$/);
});

test('只暴露声明的绑定，宿主全局不可见', async () => {
  const kinds = await run('return [typeof page, typeof context, typeof sleep, typeof assert, typeof assertEqual, typeof process, typeof require]');
  assert.equal(kinds.result, '["object","object","function","function","function","undefined","undefined"]');
});

test('sleep 受剩余预算约束并正常等待', async () => {
  const result = await run('const started = Date.now(); await sleep(30); return Date.now() - started >= 20');
  assert.equal(result.ok, true);
  assert.equal(result.result, 'true');
});

test('assert 与 assertEqual 抛出可读错误', async () => {
  const failed = await run('assert(false, "自定义失败")');
  assert.equal(failed.ok, false);
  assert.match(failed.error, /自定义失败/);
  const unequal = await run('assertEqual({ a: 1 }, { a: 2 }, "结构不同")');
  assert.equal(unequal.ok, false);
  assert.match(unequal.error, /结构不同/);
  assert.match(unequal.error, /期望 \{"a":2\}/);
  assert.equal((await run('assertEqual({ a: 1 }, { a: 1 }); return "ok"')).result, 'ok');
});

test('脚本抛错返回 ok:false 与错误消息', async () => {
  const result = await run('throw new Error("页面元素不存在")');
  assert.equal(result.ok, false);
  assert.match(result.error, /页面元素不存在/);
});

test('语法错误在执行前报出', async () => {
  const result = await run('return (');
  assert.equal(result.ok, false);
  assert.match(result.error, /脚本无法执行/);
});

test('同步死循环被 vm 超时中断', async () => {
  const result = await run('while (true) {}', { syncTimeoutMs: 100 });
  assert.equal(result.ok, false);
  assert.match(result.error, /同步执行超过 100 毫秒/);
});

test('整体超时中止等待', async () => {
  const result = await runPlaywrightScript({
    script: 'await new Promise(() => {}); return 1',
    page, signal, endsAt: performance.now() + 60,
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /超过单次上限/);
});

test('取消信号返回已取消', async () => {
  const controller = new AbortController();
  const pending = runPlaywrightScript({
    script: 'await new Promise(() => {}); return 1',
    page, signal: controller.signal, endsAt: performance.now() + 5000,
  });
  controller.abort();
  const result = await pending;
  assert.equal(result.ok, false);
  assert.match(result.error, /已取消/);
});

test('辅助函数处理无法 JSON 化的值与跨 realm 错误', () => {
  const circular = {};
  circular.self = circular;
  assert.match(describeValue(circular, 100), /\[object Object\]/);
  assert.equal(describeValue(undefined, 10), 'undefined');
  assert.equal(describeValue('abcdef', 3), 'abc…（已截断，原长 6 字符）');
  assert.equal(messageOf({ message: '外域错误\n第二行' }), '外域错误');
  assert.equal(messageOf('字符串错误'), '字符串错误');
});
