/**
 * 搜索引擎定义：结果页 URL 构造与展示名。
 *
 * @module dsh-web-search/engines
 */
import type { SearchEngine } from './config.js';

/** 单个搜索引擎的定义。 */
export interface SearchEngineDefinition {
  /** 面向模型与日志的展示名。 */
  readonly label: string;
  /** 结果页 URL 构造器；实现必须对查询词做 URL 编码。 */
  readonly buildUrl: (query: string) => string;
}

/** 四个受支持的搜索引擎。 */
export const SEARCH_ENGINE_DEFINITIONS: Record<SearchEngine, SearchEngineDefinition> = {
  baidu: {
    label: '百度',
    buildUrl: (query) => `https://www.baidu.com/s?wd=${encodeURIComponent(query)}`,
  },
  sogou: {
    label: '搜狗',
    buildUrl: (query) => `https://www.sogou.com/web?query=${encodeURIComponent(query)}`,
  },
  bing: {
    label: 'Bing',
    buildUrl: (query) => `https://www.bing.com/search?q=${encodeURIComponent(query)}`,
  },
  google: {
    label: 'Google',
    buildUrl: (query) => `https://www.google.com/search?q=${encodeURIComponent(query)}&hl=zh-CN`,
  },
};

/** 构造指定引擎的搜索结果页 URL。 */
export function buildSearchUrl(engine: SearchEngine, query: string): string {
  return SEARCH_ENGINE_DEFINITIONS[engine].buildUrl(query);
}

/** 引擎展示名。 */
export function engineLabel(engine: SearchEngine): string {
  return SEARCH_ENGINE_DEFINITIONS[engine].label;
}
