import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolvePluginConfig } from '../lib/config.js';

test('空配置回退到默认值', () => {
  const config = resolvePluginConfig(undefined);
  assert.equal(config.search.enabled, true);
  assert.equal(config.search.engine, 'bing');
  assert.equal(config.fetch.enabled, true);
  assert.equal(config.fetch.mode, 'model');
  assert.equal(config.search.fallbackEngine, undefined);
  assert.equal(config.search.summarize, false);
  assert.equal(config.browser.persistentProfileDir, '');
  assert.equal(config.browser.kind, 'auto');
  assert.equal(config.browser.headless, true);
  assert.equal(config.analysis.route, undefined);
  assert.equal(config.subagent.enabled, true);
  assert.equal(config.subagent.maxRounds, 3);
  assert.equal(config.analysis.maxTokens, 38400);
});

test('非法取值回退默认值，数值裁剪到范围内', () => {
  const config = resolvePluginConfig({
    search: { enabled: false, engine: 'yahoo', maxResults: 999, timeoutMs: -5 },
    browser: { kind: 'netscape', executablePath: '  C:\\chrome.exe  ', headless: false },
  });
  assert.equal(config.search.enabled, false);
  assert.equal(config.search.engine, 'bing');
  assert.equal(config.search.maxResults, 50);
  assert.equal(config.search.timeoutMs, 1000);
  assert.equal(config.browser.kind, 'auto');
  assert.equal(config.browser.executablePath, 'C:\\chrome.exe');
  assert.equal(config.browser.headless, false);
});

test('模型选择解析为路由；半配置视为未选择', () => {
  const config = resolvePluginConfig({
    analysis: { selection: { provider: 'p', model: 'm', reasoningEffort: 'high' } },
    subagent: { selection: { provider: 'p2', model: '' } },
  });
  assert.deepEqual(config.analysis.route, { provider: 'p', model: 'm', reasoningEffort: 'high' });
  assert.equal(config.subagent.route, undefined);
});

test('解析结果是冻结的', () => {
  const config = resolvePluginConfig(undefined);
  assert.ok(Object.isFrozen(config));
  assert.ok(Object.isFrozen(config.search));
});

test('子代理轮数：-1 保留表示无限制，0 表示禁用，越界裁剪', () => {
  assert.equal(resolvePluginConfig({ subagent: { maxRounds: -1 } }).subagent.maxRounds, -1);
  assert.equal(resolvePluginConfig({ subagent: { maxRounds: 0 } }).subagent.maxRounds, 0);
  assert.equal(resolvePluginConfig({ subagent: { maxRounds: 999 } }).subagent.maxRounds, 100);
  assert.equal(resolvePluginConfig({ subagent: { maxRounds: -5 } }).subagent.maxRounds, 0);
});

test('独立解析备用引擎、单次预算及人工验证设置', () => {
  const config = resolvePluginConfig({
    search: { fallbackEngine: 'sogou', engineTimeoutMs: { baidu: 3500, bing: -1 } },
    fetch: { mode: 'text' },
    browser: { persistentProfileDir: ' /tmp/example ', challengeWaitMs: 5000 },
  });
  assert.equal(config.search.fallbackEngine, 'sogou');
  assert.equal(config.search.engineTimeoutMs.baidu, 3500);
  assert.equal(config.search.engineTimeoutMs.bing, 0);
  assert.equal(config.fetch.mode, 'text');
  assert.equal(config.browser.persistentProfileDir, '/tmp/example');
  assert.equal(config.browser.challengeWaitMs, 5000);
});

test('脚本执行默认开启，执行上限裁剪到范围内', () => {
  const config = resolvePluginConfig(undefined);
  assert.equal(config.exec.enabled, true);
  assert.equal(config.exec.maxDurationMs, 120000);
  assert.equal(resolvePluginConfig({ exec: { enabled: false } }).exec.enabled, false);
  assert.equal(resolvePluginConfig({ exec: { maxDurationMs: 10 } }).exec.maxDurationMs, 1000);
  assert.equal(resolvePluginConfig({ exec: { maxDurationMs: 99999999 } }).exec.maxDurationMs, 600000);
});
