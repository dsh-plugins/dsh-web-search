import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildFetchAnalysisPrompt, buildSearchAnalysisPrompt, buildSubagentPrompt } from '../lib/prompt.js';

test('搜索分析提示词包含查询词、引擎与上限', () => {
  const prompt = buildSearchAnalysisPrompt({ engine: 'baidu', query: '测试', html: '<html></html>', maxResults: 5, allowInteract: true });
  assert.match(prompt, /测试/);
  assert.match(prompt, /百度/);
  assert.match(prompt, /最多 5 条/);
  assert.match(prompt, /interact/);
});

test('不允许交互时不提供 interact 分支', () => {
  const prompt = buildSearchAnalysisPrompt({ engine: 'bing', query: 'q', html: '<html></html>', maxResults: 10, allowInteract: false });
  assert.doesNotMatch(prompt, /interact/);
});

test('抓取提示词包含 URL 与 Markdown 要求', () => {
  const prompt = buildFetchAnalysisPrompt({ url: 'https://example.com', html: '<html></html>', allowInteract: true });
  assert.match(prompt, /https:\/\/example\.com/);
  assert.match(prompt, /markdown/);
});

test('子代理提示词列出浏览器工具', () => {
  const prompt = buildSubagentPrompt('点击验证按钮');
  for (const tool of ['web_browser_read', 'web_browser_click', 'web_browser_type', 'web_browser_press', 'web_browser_scroll', 'web_browser_navigate', 'web_browser_back']) {
    assert.ok(prompt.includes(tool), tool);
  }
  assert.match(prompt, /点击验证按钮/);
});
