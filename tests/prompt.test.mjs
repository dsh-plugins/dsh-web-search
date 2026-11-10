
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildFetchAnalysisPrompt, buildSearchSummaryPrompt, buildSubagentPrompt } from '../lib/prompt.js';

test('搜索摘要只使用查询和已提取的候选结果', () => {
  const results = [{ title: '候选', url: 'https://example.com/', snippet: '摘录' }];
  const prompt = buildSearchSummaryPrompt({ engine: 'baidu', query: '测试 兴波', results });
  assert.deepEqual(JSON.parse(prompt.split('\n').at(-1)), { engine: '百度', query: '测试 兴波', results });
});

test('抓取提示词只在允许交互时提供 interact', () => {
  const args = { url: 'https://example.com', html: '<html></html>' };
  const prompt = buildFetchAnalysisPrompt({ ...args, allowInteract: true });
  assert.match(prompt, /https:\/\/example\.com/);
  assert.match(prompt, /markdown/);
  assert.match(prompt, /interact/);
  assert.doesNotMatch(buildFetchAnalysisPrompt({ ...args, allowInteract: false }), /interact/);
});

test('子代理提示词列出浏览器工具', () => {
  const prompt = buildSubagentPrompt('点击同意按钮');
  for (const tool of ['web_browser_read', 'web_browser_click', 'web_browser_type', 'web_browser_press', 'web_browser_scroll', 'web_browser_navigate', 'web_browser_back']) {
    assert.ok(prompt.includes(tool), tool);
  }
  assert.match(prompt, /点击同意按钮/);
});
