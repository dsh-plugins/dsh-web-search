
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { defineTool, ToolArgsError } from '@deepseek-ai/dsh-tools';
import { deadline } from '@deepseek-ai/dsh-timeout';
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm';
import { BrowserManager } from '../lib/browser.js';
import { resolvePluginConfig } from '../lib/config.js';
import { registerWebTools } from '../lib/tools.js';

const executablePath = process.env.DSH_WEB_SEARCH_TEST_BROWSER;
const skip = executablePath ? false : '未指定 DSH_WEB_SEARCH_TEST_BROWSER';
const browser = { kind: 'chromium', executablePath, settleMs: 120, launchTimeoutMs: 10000, navigationTimeoutMs: 12000 };
const allowed = 'https://journal.ship-research.com/paper';
const offsite = 'https://badship-research.com/paper';
const query = 'site:ship-research.com 兴波 计算';
const facade = {
  dsh: { tools: { defineTool, ToolArgsError }, timeout: { deadline }, llm: { BlockAssembler } },
  llm: { createUserMessage },
};

function searchPage(engine) {
  const bingLink = '/ck/a?u=a1' + Buffer.from(allowed).toString('base64url');
  return {
    bing: '<ol id="b_results"><li class="b_algo"><h2><a href="' + bingLink + '">目标论文</a></h2><p>论文摘要</p></li>'
      + '<li class="b_algo"><h2><a href="' + offsite + '">站外结果</a></h2></li></ol>',
    baidu: '<div id="content_left"><div class="result" mu="' + allowed + '"><h3><a href="/link?url=opaque">目标论文</a></h3>'
      + '<div class="c-abstract">论文摘要</div></div><div class="result"><h3><a href="/link?url=other">未知链接</a></h3></div></div>',
    sogou: '<div class="results"><div class="vrwrap"><h3><a href="' + allowed + '">目标论文</a></h3>'
      + '<p class="str-text-info">论文摘要</p></div><div class="vrwrap"><h3><a href="' + offsite + '">站外结果</a></h3></div></div>',
    google: '<div id="search"><div class="MjjYud"><a href="/url?q=' + encodeURIComponent(allowed) + '"><h3>目标论文</h3></a>'
      + '<div class="VwiC3b">论文摘要</div></div><div class="g" data-text-ad><a href="' + offsite + '"><h3>广告</h3></a></div></div>',
  }[engine];
}

test('Edge 页面样本覆盖四个引擎、挑战识别、抓取模式及缓存隔离', { skip, timeout: 45000 }, async () => {
  const browserManager = new BrowserManager();
  const registered = new Map();
  const visits = new Map();
  const observedQueries = new Map();
  let modelCalls = 0;
  let delegated = 0;
  let config = resolvePluginConfig({ browser, search: { engine: 'baidu', fallbackEngine: 'bing' } });
  const registration = registerWebTools({
    ctx: {
      tools: { register(tool) { registered.set(tool.name, tool); return () => registered.delete(tool.name); } },
      llm: { async *stream({ messages }) {
        modelCalls += 1;
        const outcome = messages[0].content[0].text.includes('/no-progress')
          ? { status: 'interact', task: '点击同意按钮' }
          : { status: 'ok', title: '模型标题', markdown: '# 模型正文' };
        yield { type: 'text-delta', index: 0, text: JSON.stringify(outcome) };
      } },
    },
    facade,
    manager: {
      withPage(options, session, signal, action, endsAt) {
        return browserManager.withPage(options, session, signal, async (page, navigation, pageSignal) => {
          await page.route('**/*', async (route) => {
            if (!route.request().isNavigationRequest()) {
              return route.abort();
            }
            const url = new URL(route.request().url());
            const key = url.hostname + url.pathname;
            visits.set(key, (visits.get(key) ?? 0) + 1);
            const html = (body, status = 200, headers = {}) =>
              route.fulfill({ status, headers, contentType: 'text/html; charset=utf-8', body });
            if (url.hostname === 'wappass.baidu.com') {
              return html('<title>百度安全验证</title><main>请验证</main>');
            }
            if (url.pathname === '/antispider/') {
              return html('<title>搜狗搜索</title><main>验证码</main>');
            }
            if (url.hostname === 'fixture.example') {
              if (url.pathname === '/blocked') {
                return html('<title>请稍候…</title><main>等待验证</main>', 403, { 'cf-mitigated': 'challenge' });
              }
              const cookie = url.pathname === '/cookie' ? { 'set-cookie': 'session=fixture; Path=/' } : {};
              return html('<title>原始标题</title><nav>导航</nav><main>抓取正文</main>', 200,
                { 'cache-control': url.pathname === '/max-age-zero' ? 'public, max-age=0' : 'public, max-age=60', ...cookie });
            }
            const engine = ['bing', 'baidu', 'sogou', 'google'].find((name) => url.hostname === 'www.' + name + '.com');
            if (engine === undefined) {
              return route.abort();
            }
            const actualQuery = url.searchParams.get({ bing: 'q', baidu: 'wd', sogou: 'query', google: 'q' }[engine]);
            if (actualQuery !== null) {
              observedQueries.set(engine, actualQuery);
            }
            if (actualQuery === '挑战') {
              if (engine === 'baidu') {
                return html('<script>location.replace("https://wappass.baidu.com/static/captcha/foo.html")</script>');
              }
              if (engine === 'sogou') {
                return html('<script>location.replace("/antispider/")</script>');
              }
              return html(searchPage(engine));
            }
            if (actualQuery === '没有论文') {
              return html('<ol id="b_results"><li class="b_no">没有与此相关的结果</li></ol>');
            }
            return html(searchPage(engine));
          });
          return action(page, navigation, pageSignal);
        }, endsAt);
      },
    },
    get: () => config,
    subagents: () => ({
      async start() {
        delegated += 1;
        return { result: Promise.resolve({ stopReason: 'completed', output: [] }), async dispose() {} };
      },
    }),
  });
  const exec = (id) => ({ agent: { session: { id }, options: { provider: 'fixture', model: 'fixture' } }, signal: AbortSignal.timeout(15000) });
  try {
    const search = registered.get('browser_web_search');
    for (const engine of ['bing', 'baidu', 'sogou', 'google']) {
      const result = await search.execute({ query, engine }, exec('search'));
      assert.equal(observedQueries.get(engine), query, JSON.stringify({ engine, result, visits: [...visits] }));
      assert.equal(result.status, 'ok', JSON.stringify(result));
      assert.deepEqual(result.results, [{ title: '目标论文', url: allowed, snippet: '论文摘要' }]);
    }
    assert.equal((await search.execute({ query: '没有论文', engine: 'bing' }, exec('search'))).status, 'no_results');
    for (const engine of ['baidu', 'sogou']) {
      const result = await search.execute({ query: '挑战', engine }, exec('search'));
      assert.equal(result.status, 'blocked', JSON.stringify(result));
      assert.match(result.reason, /验证码|验证/);
      assert.equal(result.attempts.length, 1);
    }
    const fallback = await search.execute({ query: '挑战' }, exec('search'));
    assert.equal(fallback.engine, 'bing');
    assert.deepEqual(fallback.attempts.map(({ status }) => status), ['blocked', 'ok']);
    assert.equal(modelCalls, 0);

    const fetch = registered.get('browser_web_fetch');
    const blocked = await fetch.execute({ url: 'https://fixture.example/blocked' }, exec('fetch'));
    assert.equal(blocked.status, 'blocked', JSON.stringify(blocked));
    assert.match(blocked.reason, /Cloudflare/);
    assert.equal(modelCalls, 0);

    const url = 'https://fixture.example/paper';
    const model = await fetch.execute({ url }, exec('fetch'));
    assert.equal(model.markdown, '# 模型正文', JSON.stringify(model));
    assert.equal(modelCalls, 1);
    assert.equal((await fetch.execute({ url }, exec('fetch'))).markdown, model.markdown);
    assert.equal(modelCalls, 1);
    const text = await fetch.execute({ url, mode: 'text' }, exec('fetch'));
    assert.equal(text.text, '抓取正文');
    assert.equal(modelCalls, 1);
    assert.equal((await fetch.execute({ url, mode: 'text' }, exec('fetch'))).text, text.text);
    assert.equal(visits.get('fixture.example/paper'), 2);
    await fetch.execute({ url, mode: 'text' }, exec('different-session'));
    assert.equal(visits.get('fixture.example/paper'), 3);
    config = resolvePluginConfig({ browser });
    registration.reconcile();
    await fetch.execute({ url, mode: 'text' }, exec('fetch'));
    assert.equal(visits.get('fixture.example/paper'), 4);
    for (const pathname of ['/cookie', '/max-age-zero']) {
      for (let index = 0; index < 2; index += 1) {
        await fetch.execute({ url: 'https://fixture.example' + pathname, mode: 'text' }, exec('fetch'));
      }
      assert.equal(visits.get('fixture.example' + pathname), 2);
    }

    const noProgress = await fetch.execute({ url: 'https://fixture.example/no-progress' }, exec('fetch'));
    assert.equal(noProgress.status, 'no_content', JSON.stringify(noProgress));
    assert.match(noProgress.reason, /可见正文未变化/);
    assert.equal(delegated, 1);
    assert.equal(modelCalls, 2);
  } finally {
    registration.dispose();
    await browserManager.dispose();
  }
});

test('Edge 持久化目录可重开、任务隔离，并能重新识别人工验证后的页面', { skip, timeout: 40000 }, async () => {
  const tempRoot = await realpath(tmpdir());
  const profile = await mkdtemp(join(tempRoot, 'dsh-browser-fixture-'));
  const config = resolvePluginConfig({ browser: { ...browser, persistentProfileDir: profile } }).browser;
  const manager = new BrowserManager();
  const controller = new AbortController();
  const opened = Promise.withResolvers();
  const released = Promise.withResolvers();
  const initial = manager.withPage(config, 'first', controller.signal, async (page, _navigation, signal) => {
    await page.context().addCookies([{ url: 'https://fixture.example/', name: 'saved', value: 'yes', expires: Date.now() / 1000 + 3600 }]);
    opened.resolve(page);
    await delay(20000, undefined, { signal });
  }).catch((error) => {
    opened.reject(error);
    if (!controller.signal.aborted) {
      throw error;
    }
  });
  try {
    const first = await opened.promise;
    const second = await manager.withPage(config, 'second', AbortSignal.timeout(10000), async (page, navigation, signal) => {
      assert.equal(manager.pageFor('unrelated', undefined), undefined);
      assert.equal(manager.pageFor('child', 'first'), first);
      assert.notEqual(page, first);
      assert.equal((await page.context().cookies()).find((cookie) => cookie.name === 'saved')?.value, 'yes');
      const sameSession = manager.withPage(config, 'second', AbortSignal.timeout(10000), async () => released.resolve());
      void sameSession.catch(() => {});
      await delay(100);
      assert.equal(manager.pageFor('second', undefined), page);
      controller.abort();
      await initial;
      assert.equal(first.isClosed(), true);
      assert.equal(page.isClosed(), false);

      await page.route('https://fixture.example/**', (route) => new URL(route.request().url()).pathname === '/verify'
        ? route.fulfill({
          status: 403, contentType: 'text/html; charset=utf-8', headers: { 'cf-mitigated': 'challenge' },
          body: '<title>Challenge</title><script>setTimeout(() => location.href="/done", 250)</script>',
        })
        : route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: '<main>验证后的正文</main>' }));
      const result = await navigation.open('https://fixture.example/verify', { ...config, headless: false, challengeWaitMs: 2000 },
        signal, performance.now() + 4000);
      assert.equal(result.status, 'ready', JSON.stringify(result));
      assert.match(result.state.text, /验证后的正文/);
      return { sameSession };
    });
    await second.sameSession;
    await released.promise;
    await manager.close();
    await manager.withPage(config, 'new-session', AbortSignal.timeout(10000), async (page) => {
      assert.equal((await page.context().cookies()).find((cookie) => cookie.name === 'saved')?.value, 'yes');
    });
  } finally {
    controller.abort();
    await Promise.allSettled([initial, manager.dispose()]);
    assert.equal(dirname(await realpath(profile)), tempRoot);
    await rm(profile, { recursive: true, force: true });
  }
});
