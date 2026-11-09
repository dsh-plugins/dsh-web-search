/**
 * config-api 模板：声明统一配置表单与「浏览器诊断」临时操作区。
 *
 * @module dsh-web-search/config-template
 */
import { defineConfig, type ConfigField } from '@dsh-plugin/dsh-loader/config';
import {
  DEFAULT_FETCH_TIMEOUT_MS,
  DEFAULT_LAUNCH_TIMEOUT_MS,
  DEFAULT_MAX_HTML_CHARS,
  DEFAULT_MAX_MARKDOWN_CHARS,
  DEFAULT_MAX_RESULTS,
  DEFAULT_MAX_SUBAGENT_ROUNDS,
  DEFAULT_MAX_TOKENS,
  DEFAULT_NAVIGATION_TIMEOUT_MS,
  DEFAULT_SEARCH_TIMEOUT_MS,
  DEFAULT_SETTLE_MS,
  MAX_TIMER_DELAY_MS,
  PLUGIN_ID,
  PLUGIN_NAME,
} from './config.js';

/** 搜索引擎下拉选项。 */
const ENGINE_OPTIONS = [
  { label: 'Bing', value: 'bing' },
  { label: '百度', value: 'baidu' },
  { label: '搜狗', value: 'sogou' },
  { label: 'Google', value: 'google' },
];

/** 浏览器类型下拉选项。 */
const BROWSER_OPTIONS = [
  { label: '自动（依次尝试 Chromium → Firefox → WebKit）', value: 'auto' },
  { label: 'Chromium（Chrome / Edge / Playwright Chromium）', value: 'chromium' },
  { label: 'Firefox（Playwright 版 Firefox）', value: 'firefox' },
  { label: 'WebKit（Playwright 版 Safari 内核）', value: 'webkit' },
];

const object = (key: string, label: string, fields: ConfigField[], description?: string): ConfigField => ({
  type: 'object', key, label, ...(description ? { description } : {}), collapsible: true, fields,
});

/** 创建插件配置模板。 */
export function createConfigTemplate() {
  return defineConfig({
    id: PLUGIN_ID,
    packageName: PLUGIN_NAME,
    title: '网页搜索（浏览器）',
    description: '基于真实浏览器的 web_search / web_fetch：搜索引擎与目标页面在本机浏览器中打开，页面 HTML 由配置的模型分析后返回结构化结果。',
    fields: [
      object('search', '网页搜索', [
        { type: 'boolean', key: 'enabled', label: '启用 web_search', default: true, description: '启用后向各会话提供浏览器版 web_search，并隐藏官方同名工具。' },
        { type: 'select', key: 'engine', label: '默认搜索引擎', default: 'bing', options: ENGINE_OPTIONS, description: '工具调用时可另行指定。' },
        { type: 'number', key: 'maxResults', label: '结果数量上限', default: DEFAULT_MAX_RESULTS, min: 1, max: 50 },
        { type: 'number', key: 'timeoutMs', label: '整体超时（毫秒）', default: DEFAULT_SEARCH_TIMEOUT_MS, min: 1000, max: MAX_TIMER_DELAY_MS },
      ]),
      object('fetch', '网页抓取', [
        { type: 'boolean', key: 'enabled', label: '启用 web_fetch', default: true, description: '启用后向各会话提供浏览器版 web_fetch，并隐藏官方同名工具。' },
        { type: 'number', key: 'timeoutMs', label: '整体超时（毫秒）', default: DEFAULT_FETCH_TIMEOUT_MS, min: 1000, max: MAX_TIMER_DELAY_MS },
        { type: 'number', key: 'maxMarkdownChars', label: 'Markdown 输出上限（字符）', default: DEFAULT_MAX_MARKDOWN_CHARS, min: 1000, max: 2000000 },
      ]),
      object('browser', '浏览器', [
        { type: 'select', key: 'kind', label: '浏览器类型', default: 'auto', options: BROWSER_OPTIONS },
        {
          type: 'text', key: 'executablePath', label: '自定义浏览器路径', default: '',
          description: '浏览器可执行文件的绝对路径（如 Chrome / Edge / Chromium 主程序）。留空时自动搜索：Chromium 依次尝试本机 Chrome、Edge 与 Playwright 缓存的浏览器；Firefox 与 WebKit 使用 Playwright 缓存版本（可用 npx playwright install firefox webkit 安装）。',
        },
        { type: 'boolean', key: 'headless', label: '无头模式', default: true, description: '关闭后弹出可见浏览器窗口，便于观察页面交互过程。' },
        { type: 'number', key: 'settleMs', label: '加载后静置（毫秒）', default: DEFAULT_SETTLE_MS, min: 0, max: 30000, description: '页面 load 事件后额外等待的时间，用于等搜索结果渲染。' },
        { type: 'number', key: 'launchTimeoutMs', label: '启动超时（毫秒）', default: DEFAULT_LAUNCH_TIMEOUT_MS, min: 1000, max: 300000 },
        { type: 'number', key: 'navigationTimeoutMs', label: '导航超时（毫秒）', default: DEFAULT_NAVIGATION_TIMEOUT_MS, min: 1000, max: 300000 },
      ], '自动搜索本机可用的浏览器，也可指定可执行文件路径。'),
      object('analysis', '分析模型', [
        { type: 'model', key: 'selection', label: '模型', default: null, description: '分析页面 HTML 并产出结果的模型；留空时使用发起调用的会话模型。' },
        { type: 'number', key: 'maxTokens', label: '输出上限（tokens）', default: DEFAULT_MAX_TOKENS, min: 256, max: 200000 },
        { type: 'number', key: 'maxHtmlChars', label: 'HTML 输入上限（字符）', default: DEFAULT_MAX_HTML_CHARS, min: 2000, max: 2000000, description: '送入模型的页面 HTML 长度上限，超出后截断。' },
      ]),
      object('subagent', '子代理页面操作', [
        { type: 'boolean', key: 'enabled', label: '允许子代理操作页面', default: true, description: '当分析模型判断页面需要点击、输入等交互时，派出子代理使用浏览器工具操作页面后重新分析。' },
        { type: 'model', key: 'selection', label: '子代理模型', default: null, description: '留空时子代理沿用发起会话的模型。' },
        { type: 'number', key: 'maxRounds', label: '交互轮数上限', default: DEFAULT_MAX_SUBAGENT_ROUNDS, min: 0, max: 5, description: '单次工具调用最多允许的「子代理操作 → 重新分析」轮数；0 表示不派出子代理。' },
      ]),
    ],
    panels: [{
      id: 'diagnostics',
      title: '诊断',
      fields: [],
      operations: [{
        id: 'check-browser',
        input: [],
        readOnly: true,
        button: { label: '检测浏览器', success: '检测完成' },
        result: [{ type: 'text', title: '检测结果', path: ['report'] }],
      }],
    }],
  });
}
