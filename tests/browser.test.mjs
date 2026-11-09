import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveCandidates } from '../lib/browser.js';
import { resolvePluginConfig } from '../lib/config.js';

const base = resolvePluginConfig(undefined).browser;

test('auto 模式依次覆盖三种内核', () => {
  const kinds = new Set(resolveCandidates(base).map((c) => c.kind));
  assert.deepEqual([...kinds].sort(), ['chromium', 'firefox', 'webkit']);
});

test('指定内核时只产生该内核候选', () => {
  const candidates = resolveCandidates({ ...base, kind: 'firefox' });
  assert.ok(candidates.length > 0);
  assert.ok(candidates.every((c) => c.kind === 'firefox'));
});

test('自定义路径优先且带 executablePath', () => {
  const candidates = resolveCandidates({ ...base, kind: 'chromium', executablePath: 'C:\\my\\chrome.exe' });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].options.executablePath, 'C:\\my\\chrome.exe');
});

test('auto + 自定义路径对三种内核都尝试该路径', () => {
  const candidates = resolveCandidates({ ...base, kind: 'auto', executablePath: '/opt/browser' });
  assert.equal(candidates.length, 3);
  assert.ok(candidates.every((c) => c.options.executablePath === '/opt/browser'));
});

test('chromium 自动候选包含本机 Chrome/Edge 渠道与 Playwright 托管浏览器', () => {
  const descriptions = resolveCandidates({ ...base, kind: 'chromium' }).map((c) => c.description).join('\n');
  assert.match(descriptions, /Chrome/);
  assert.match(descriptions, /Edge/);
  assert.match(descriptions, /Playwright 托管 Chromium/);
});
