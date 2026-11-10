
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { defineTool, ToolArgsError } from '@deepseek-ai/dsh-tools';
import { deadline } from '@deepseek-ai/dsh-timeout';
import { searchResults } from '../lib/search-results.js';
import { registerWebTools } from '../lib/tools.js';
import { resolvePluginConfig } from '../lib/config.js';

test('站点限定检查真实目标和子域，排除相似域名和不透明跳转', () => {
  const good = 'https://sub.example.com/paper';
  const encoded = Buffer.from(good).toString('base64url');
  const candidates = [
    { title: '有效结果', url: '/ck/a?u=a1' + encoded, snippet: '' },
    { title: '重复结果', url: good, snippet: '' },
    { title: '相似域名', url: 'https://badexample.com/paper', snippet: '' },
    { title: '跳转未知', url: '/ck/a?u=unknown', snippet: '' },
    { title: '非网络地址', url: 'javascript:alert(1)', snippet: '' },
  ];
  assert.deepEqual(searchResults('bing', 'site:example.com 兴波 计算', 'https://www.bing.com/search', candidates, 10),
    [{ title: '有效结果', url: good, snippet: '' }]);
  assert.equal(searchResults('bing', '"site:example.com" 兴波', 'https://www.bing.com/search', candidates, 10).length, 3);
});

test('备用引擎只用于未指定引擎的调用，并给首次尝试保留退出预算', async () => {
  const tools = new Map();
  const visited = [];
  let config = resolvePluginConfig({ search: { engine: 'bing', fallbackEngine: 'baidu', timeoutMs: 2000 } });
  const registration = registerWebTools({
    ctx: { tools: { register(tool) { tools.set(tool.name, tool); return () => tools.delete(tool.name); } } },
    facade: { dsh: { tools: { defineTool, ToolArgsError }, timeout: { deadline } } },
    manager: {
      withPage(_config, _session, signal, fn, endsAt) {
        visited.push(Math.round(endsAt - performance.now()));
        return fn({}, {
          async open(url, _browser, _signal, _deadline, engine) {
            if (engine === 'bing') {
              await delay(10000, undefined, { signal });
            }
            assert.equal(new URL(url).searchParams.get('wd'), '中国舰船研究 兴波 计算');
            return { status: 'ready', state: { url, candidates: [{ title: '论文', url: 'https://example.com/', snippet: '' }] } };
          },
        }, signal);
      },
    },
    get: () => config,
    subagents: () => undefined,
  });
  try {
    const exec = { signal: new AbortController().signal };
    const search = tools.get('browser_web_search');
    const result = await search.execute({ query: '中国舰船研究 兴波 计算' }, exec);
    assert.equal(result.engine, 'baidu');
    assert.deepEqual(result.attempts.map(({ engine, status }) => [engine, status]), [['bing', 'timeout'], ['baidu', 'ok']]);
    assert.ok(visited[0] < 1000);
    const explicit = await search.execute({ query: '中国舰船研究 兴波 计算', engine: 'bing' }, exec);
    assert.equal(explicit.status, 'timeout');
    assert.deepEqual(explicit.attempts.map(({ engine }) => engine), ['bing']);

    config = resolvePluginConfig({ search: { enabled: false } });
    registration.reconcile();
    assert.deepEqual([...tools.keys()], ['browser_web_fetch']);
  } finally {
    registration.dispose();
  }
});
