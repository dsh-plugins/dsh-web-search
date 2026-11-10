
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PageNavigation } from '../lib/navigation.js';
import { resolvePluginConfig } from '../lib/config.js';

const url = 'https://example.com/';
const pending = () => new Promise(() => {});
const signal = () => new AbortController().signal;

test('页面脚本阻塞求值时按导航截止时间返回', async () => {
  const page = { on() {}, url: () => url, async goto() {}, evaluate: pending };
  const browser = resolvePluginConfig(undefined).browser;
  const navigation = new PageNavigation(page);
  const result = await navigation.open(url, browser, signal(), performance.now() + 50);
  assert.equal(result.status, 'timeout');
  assert.match(result.reason, /页面就绪/);
});

test('人工验证期间求值阻塞时按人工等待预算返回 blocked', async () => {
  let reads = 0;
  let focused = false;
  const page = {
    on() {}, url: () => url, async goto() {},
    async bringToFront() { focused = true; },
    evaluate() {
      reads += 1;
      if (reads === 1) {
        return Promise.resolve({
          url, loaded: true, title: '挑战', text: '请验证', challenge: 'Cloudflare 挑战', empty: false, candidates: [],
        });
      }
      return pending();
    },
  };
  const browser = resolvePluginConfig({ browser: { headless: false, persistentProfileDir: '/fixture', challengeWaitMs: 60 } }).browser;
  const result = await new PageNavigation(page).open(url, browser, signal(), performance.now() + 1000);
  assert.equal(focused, true);
  assert.equal(result.status, 'blocked');
  assert.match(result.reason, /人工验证等待已结束/);
});
