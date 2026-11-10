
import type { SearchEngine } from './config.js';

interface ResultSelectors {
  readonly results: string;
  readonly cards: string;
  readonly title: string;
  readonly snippet: string;
  readonly empty: string;
  readonly destinationAttribute?: string;
}

export const RESULT_SELECTORS: Record<SearchEngine, ResultSelectors> = {
  bing: {
    results: '#b_results',
    cards: 'li.b_algo',
    title: 'h2 a[href]',
    snippet: '.b_caption p, p',
    empty: '#b_results .b_no, #b_results .b_noResults, #b_results .b_no_results',
  },
  baidu: {
    results: '#content_left',
    cards: '.result, .c-container',
    title: 'h3 a[href]',
    snippet: '.c-abstract, [class*="content-right"], [class*="abstract"], .c-span-last',
    empty: '#content_left .nors, #content_left .search-no-result',
    destinationAttribute: 'mu',
  },
  sogou: {
    results: '.results, #main, #results',
    cards: '.vrwrap, .rb',
    title: 'h3 a[href], .vr-title a[href]',
    snippet: '.str-text-info, .str_info, .ft',
    empty: '.no-result, .noresult, .no-results',
  },
  google: {
    results: '#search',
    cards: 'div.MjjYud, div.g',
    title: 'a:has(h3)',
    snippet: '[data-sncf], .VwiC3b, .IsZvec',
    empty: '#topstuff .card-section, #topstuff [role="heading"]',
  },
};

export interface ResultCandidate {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
  readonly destination?: string;
}

export interface SearchResult {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
}

function httpUrl(value: string | undefined, base?: string): URL | undefined {
  const url = value === undefined || value.length === 0 ? null : URL.parse(value, base);
  if (url === null || !['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    return undefined;
  }
  return url;
}

function resultTarget(engine: SearchEngine, url: URL): { target?: URL; wrapped: boolean } {
  if (engine === 'bing' && /^(?:www\.|cn\.)?bing\.com$/.test(url.hostname) && url.pathname === '/ck/a') {
    const encoded = url.searchParams.get('u');
    const target = encoded?.startsWith('a1') === true
      ? httpUrl(Buffer.from(encoded.slice(2), 'base64url').toString('utf8'))
      : undefined;
    return { target, wrapped: true };
  }
  if (engine === 'google' && /^(?:www\.)?google\.(?:com|[a-z]{2}|(?:co|com)\.[a-z]{2})$/.test(url.hostname)
    && url.pathname === '/url') {
    return { target: httpUrl(url.searchParams.get('q') ?? url.searchParams.get('url') ?? undefined), wrapped: true };
  }
  if ((engine === 'baidu' && /^(?:www\.)?baidu\.com$/.test(url.hostname) && url.pathname === '/link')
    || (engine === 'sogou' && /^(?:www\.)?sogou\.com$/.test(url.hostname) && /^\/(?:link|websearch\/article\.jsp)$/.test(url.pathname))) {
    return { wrapped: true };
  }
  return { target: url, wrapped: false };
}

function siteOf(query: string): string | undefined {
  const tokens = query.match(/"(?:[^"\\]|\\.)*"|[^\s"]+/gu) ?? [];
  const sites = tokens.filter((token) => /^-?site:/i.test(token));
  if (sites.length !== 1 || !/^site:/i.test(sites[0])) {
    return undefined;
  }
  const domain = sites[0].slice(5).replace(/\.$/, '');
  if (!domain.includes('.') || /[:/@?#\\*%]/.test(domain)) {
    return undefined;
  }
  const hostname = httpUrl('https://' + domain + '/')?.hostname;
  return hostname && hostname.split('.').every((label) => /^[a-z\d](?:[a-z\d-]*[a-z\d])?$/i.test(label)) ? hostname : undefined;
}

/** 校验结果卡片的链接。站点限定只依据已知落地地址。 */
export function searchResults(
  engine: SearchEngine,
  query: string,
  pageUrl: string,
  candidates: readonly ResultCandidate[],
  maxResults: number,
): SearchResult[] {
  const site = siteOf(query);
  const seen = new Set<string>();
  const results: SearchResult[] = [];
  for (const candidate of candidates) {
    const title = candidate.title.trim();
    const link = httpUrl(candidate.url, pageUrl);
    if (!title || link === undefined) {
      continue;
    }
    const { target, wrapped } = resultTarget(engine, link);
    const destination = (wrapped ? httpUrl(candidate.destination) : undefined) ?? target;
    const hostname = destination?.hostname.replace(/\.$/, '');
    if (site !== undefined && hostname !== site && !hostname?.endsWith('.' + site)) {
      continue;
    }
    const url = (destination ?? link).href;
    if (seen.has(url)) {
      continue;
    }
    seen.add(url);
    results.push({ title, url, snippet: candidate.snippet.trim() });
    if (results.length === maxResults) {
      break;
    }
  }
  return results;
}
