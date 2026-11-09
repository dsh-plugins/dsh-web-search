import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSearchUrl, engineLabel, SEARCH_ENGINE_DEFINITIONS } from '../lib/engines.js';

test('四个搜索引擎均有定义', () => {
  for (const engine of ['baidu', 'sogou', 'bing', 'google']) {
    assert.ok(SEARCH_ENGINE_DEFINITIONS[engine], engine);
    assert.ok(engineLabel(engine).length > 0);
  }
});

test('结果页 URL 正确编码查询词', () => {
  assert.equal(buildSearchUrl('baidu', '深度 求索'), `https://www.baidu.com/s?wd=${encodeURIComponent('深度 求索')}`);
  assert.equal(buildSearchUrl('sogou', 'a&b'), `https://www.sogou.com/web?query=${encodeURIComponent('a&b')}`);
  assert.equal(buildSearchUrl('bing', 'hello world'), `https://www.bing.com/search?q=${encodeURIComponent('hello world')}`);
  assert.equal(buildSearchUrl('google', 'x'), 'https://www.google.com/search?q=x&hl=zh-CN');
});
