// T4 — LinkedIn 公开 jobs-guest 端点。
//
// 用 Node 重写上游 ai-job-search 的 linkedin-search CLI（663 行 TS，跑在 Bun
// 上），只保留搜索所需的核心：零依赖、纯 fetch + 正则、不需要构建步骤。
//
// 用法限定：见 ADR 0001 —— 低频率、单一关键词、每日一次，个人使用量级。

import { fetchText as defaultFetchText } from '../http.mjs';
import { fetchPaged } from './paged.mjs';

export const LINKEDIN_SEARCH_URL = 'https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search';

/** 每页条数由端点写死，不能调。 */
const PAGE_SIZE = 10;

export function buildSearchUrl(searchUrl, { keywords, location, page = 1 }) {
  const url = new URL(searchUrl);
  if (keywords) url.searchParams.set('keywords', keywords);
  if (location) url.searchParams.set('location', location);
  url.searchParams.set('start', String((page - 1) * PAGE_SIZE));
  return url.href;
}

function decodeEntities(text) {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&#[xX]([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&nbsp;/g, ' ');
}

function clean(html) {
  return decodeEntities(String(html).replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** 判定响应体究竟长什么样 —— 解析失败要显式报错还是「本来就没有」。 */
function looksLikeSearchResults(html) {
  return html.includes('data-entity-urn="urn:li:jobPosting:') || html.includes('base-search-card');
}

/**
 * 解析搜索结果：一串扁平的 <li> 卡片。按 jobPosting URN 切块后各块独立解析，
 * 一张卡片畸形不会带崩其余。
 *
 * 三种结果刻意区分开（T4 验收的关键）：
 *   - 空响应体        → 没有更多结果，返回 []
 *   - 有卡片标记      → 正常解析
 *   - 非空但无标记    → 抛错。结构漂移或碰到登录墙时若静默返回 []，
 *                       会被下游读成「今天没有新职位」，整个源挂掉而没人知道。
 */
export function parseLinkedinCards(html) {
  const source = String(html ?? '');
  if (!source.trim()) return [];

  if (!looksLikeSearchResults(source)) {
    throw new Error(
      'linkedin: 响应里找不到任何职位卡片标记 —— 端点结构可能已变更，或请求被登录墙拦截。' +
        `响应开头：${source.slice(0, 120).replace(/\s+/g, ' ')}`,
    );
  }

  const cards = [];
  const chunks = source.split(/data-entity-urn="urn:li:jobPosting:/).slice(1);

  for (const chunk of chunks) {
    const idMatch = chunk.match(/^(\d+)/);
    if (!idMatch) continue;
    const sourceId = idMatch[1];

    const linkMatch = chunk.match(/class="base-card__full-link[^"]*"[^>]*href="([^"]+)"/i);
    const href = linkMatch ? decodeEntities(linkMatch[1]).split('?')[0] : '';

    let title = null;
    const h3 = chunk.match(/class="base-search-card__title"[^>]*>([\s\S]*?)<\/h3>/i);
    if (h3) title = clean(h3[1]);
    if (!title) {
      const sr = chunk.match(/class="sr-only"[^>]*>([\s\S]*?)<\/span>/i);
      if (sr) title = clean(sr[1]);
    }
    if (!title) continue;

    const sub = chunk.match(/class="base-search-card__subtitle"[^>]*>([\s\S]*?)<\/h4>/i);
    const company = sub ? clean(sub[1]) || null : null;

    const loc = chunk.match(/class="job-search-card__location"[^>]*>([\s\S]*?)<\/span>/i);
    const location = loc ? clean(loc[1]) || null : null;

    const dt = chunk.match(/class="job-search-card__listdate[^"]*"[^>]*datetime="([^"]+)"/i);
    const postedAt = dt && /^\d{4}-\d{2}-\d{2}/.test(dt[1]) ? dt[1].slice(0, 10) : null;

    cards.push({
      id: `linkedin:${sourceId}`,
      source: 'linkedin',
      title,
      company,
      location,
      // 搜索卡片不带薪资，也不带任何 JD 文本。摘要留 null，不额外请求详情页
      // —— ADR 0001 承诺的是低频，逐条取详情会把请求量翻十倍。
      salary: null,
      postedAt,
      url: href || `https://www.linkedin.com/jobs/view/${sourceId}`,
      excerpt: null,
      stillListed: true,
    });
  }

  return cards;
}

/**
 * 抓取一个关键词的全部页。
 *
 * 第 1 页零卡片直接抛错（见 parseLinkedinCards 的注释）：这些关键词在香港
 * 有数百条结果，第 1 页什么都没有，是端点异常而不是「今天没有职位」。
 * 第 2 页起零卡片是正常的翻页终点。
 */
export async function fetchLinkedin(config = {}, options = {}) {
  const { keywords, http } = options;
  const searchUrl = config.searchUrl ?? LINKEDIN_SEARCH_URL;
  const location = config.location ?? 'Hong Kong';
  const fetchText = http?.fetchText ?? defaultFetchText;

  return fetchPaged({
    label: 'linkedin',
    maxPages: Number(config.maxPages) || 3,
    // 每页条数由端点写死，config 里没有这个旋钮
    pageSize: PAGE_SIZE,
    pageDelayMs: Number(config.pageDelayMs) || 0,
    sleep: options.sleep,
    log: options.log,
    onPartial: options.onPartial,
    zeroFirstPageThrows: true,
    zeroFirstPageMessage: 'linkedin: 第 1 页零卡片 —— 端点异常或已变更，不当作「今天没有新职位」',
    fetchPage: async (page) => {
      // 取数失败与解析失败在这里都变成「该页抛错」，由 paged 统一处理：
      // 第 1 页抛出、第 2 页起记 partial 并保留已收集的部分。
      const html = await fetchText(buildSearchUrl(searchUrl, { keywords, location, page }));
      const cards = parseLinkedinCards(html);
      return { rawCount: cards.length, items: cards };
    },
  });
}
