/**
 * 页面快照提取：在页面内清理 DOM 后导出 HTML 与纯文本，并做长度截断。
 *
 * @module dsh-web-search/html
 */
import type { Page } from 'playwright-core';

/** 一次页面快照。 */
export interface PageSnapshot {
  readonly url: string;
  readonly title: string;
  /** 清理并截断后的 HTML。 */
  readonly html: string;
  /** 截断后的可见纯文本（`innerText`）。 */
  readonly text: string;
  /** 原始 HTML 是否被截断。 */
  readonly truncated: boolean;
}

/**
 * 注入页面执行的清理函数：移除脚本/样式等噪声节点，仅保留少量语义属性。
 * 必须保持自包含（不引用闭包变量），由 Playwright 序列化后在页面内运行。
 */
function extractInPage(maxChars: number): { url: string; title: string; html: string; text: string; truncated: boolean } {
  const root = document.documentElement.cloneNode(true) as HTMLElement;
  root.querySelectorAll('script,style,noscript,svg,canvas,template,link,meta,iframe,object,embed,audio,video,source,track')
    .forEach((node) => node.remove());
  root.querySelectorAll('[hidden],[aria-hidden="true"],[style*="display:none"],[style*="display: none"]').forEach((node) => node.remove());
  const keep = new Set(['href', 'src', 'alt', 'title', 'role', 'aria-label', 'type', 'name', 'value', 'placeholder']);
  const stripAttributes = (el: Element): void => {
    for (const attr of Array.from(el.attributes)) {
      if (!keep.has(attr.name)) el.removeAttribute(attr.name);
    }
    for (const child of Array.from(el.children)) stripAttributes(child);
  };
  stripAttributes(root);
  let html = root.outerHTML;
  // 折叠标签间空白，保留文本内部的换行语义。
  html = html.replace(/>\s+</g, '><').replace(/\s{2,}/g, ' ');
  const truncated = html.length > maxChars;
  if (truncated) html = html.slice(0, maxChars);
  const text = (document.body?.innerText ?? '').replace(/\n{3,}/g, '\n\n').slice(0, maxChars);
  return { url: location.href, title: document.title, html, text, truncated };
}

/** 抓取当前页面快照。 */
export async function captureSnapshot(page: Page, maxHtmlChars: number): Promise<PageSnapshot> {
  return page.evaluate(extractInPage, maxHtmlChars);
}
