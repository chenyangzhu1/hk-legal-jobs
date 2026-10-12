// T3 — JobsDB HK。SEEK v5 公开搜索接口，零 npm 依赖。
//
// 抽取自 career-ops/providers/jobstreet.mjs（258 行）的最小闭包：香港是 SEEK
// 集团的 JobsDB 品牌，与 JobStreet / SEEK 共用同一个 v5 端点，所以不需要
// 单独的 provider，只需要 host 白名单里加上 hk.jobsdb.com（见 ADR 0002）。

import { fetchJson as defaultFetchJson } from '../http.mjs';

const DEFAULT_API = 'https://hk.jobsdb.com/api/jobsearch/v5/search';
const DEFAULT_SITE_KEY = 'HK-Main';
const V5_SEARCH_PATH = '/api/jobsearch/v5/search';

/**
 * 唯一防止配置写错把请求打到别处的东西。ADR 0002 特意保留它，
 * 因为其余（DNS 缓存、私网地址防护）是为「任意 ATS 域名」框架准备的，
 * 单一可信端点用不上。
 */
export const ALLOWED_JOBSTREET_HOSTS = new Set([
  'hk.jobsdb.com',
  'www.jobsdb.com',
  'id.jobstreet.com',
  'www.jobstreet.com',
  'sg.jobstreet.com',
  'my.jobstreet.com',
  'www.seek.com.au',
  'www.seek.co.nz',
]);

/** 只有印尼站带 /id/ 地区前缀；其余 SEEK 平台站点都走 /job/<id>。 */
const ID_LOCALE_HOSTS = new Set(['id.jobstreet.com', 'www.jobstreet.co.id', 'jobstreet.co.id']);

function jobDetailPath(origin) {
  try {
    return ID_LOCALE_HOSTS.has(new URL(origin).hostname) ? '/id/job/' : '/job/';
  } catch {
    return '/job/';
  }
}

/** 校验并返回 url；不合规就抛错（调用方据此知道自己配错了）。 */
export function assertAllowedHost(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`jobsdb: URL 无法解析：${url}`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`jobsdb: 必须使用 HTTPS：${url}`);
  if (!ALLOWED_JOBSTREET_HOSTS.has(parsed.hostname)) {
    throw new Error(`jobsdb: host 不在白名单内：「${parsed.hostname}」，只允许：${[...ALLOWED_JOBSTREET_HOSTS].join(', ')}`);
  }
  return url;
}

/** 由 API 地址推出站点 origin，例如 https://hk.jobsdb.com */
function deriveOrigin(apiUrl) {
  try {
    const parsed = new URL(apiUrl);
    return `${parsed.protocol}//${parsed.hostname}`;
  } catch {
    return 'https://hk.jobsdb.com';
  }
}

export function buildSearchUrl(origin, params) {
  const url = new URL(V5_SEARCH_PATH, origin);
  const { siteKey, keywords, pageSize, page } = params;
  if (siteKey) url.searchParams.set('siteKey', siteKey);
  if (keywords) url.searchParams.set('keywords', keywords);
  url.searchParams.set('pageSize', String(pageSize));
  url.searchParams.set('page', String(page));
  return url.href;
}

/** 折叠空白，截断到 max 字符，只在真的截断时补省略号。 */
function excerptOf(text, max) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!flat) return null;
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`;
}

/** SEEK 的 listingDate 是 ISO 时间戳；记录里只要日期部分（SPEC §6.1）。 */
function dateOnly(value) {
  const parsed = Date.parse(value ?? '');
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString().slice(0, 10);
}

/**
 * 把一条 v5 搜索结果映射成 SPEC §6.1 的记录结构。
 * `tracks` 与 `fingerprint` 由后续层写入，这里不碰分类。
 *
 * 字段对照上游 parseJobstreetItem：company 取 advertiser.description（带品牌的
 * 全名）优先于 companyName，location 取 locations[0].label，postedAt 取
 * listingDate。上游没有的 id / salary / teaser / url 前缀是本项目补的。
 */
export function parseJobsdbItem(item, origin, options = {}) {
  if (!item || typeof item !== 'object') return null;

  const title = String(item.title ?? '').trim();
  const sourceId = String(item.id ?? '').trim();
  if (!title || !sourceId) return null;

  const url = `${origin}${jobDetailPath(origin)}${sourceId}`;
  // 解析出来的 URL 也要过白名单：origin 是配置来的，可能被写错
  if (!ALLOWED_JOBSTREET_HOSTS.has(new URL(url).hostname)) return null;

  const company = String(item.advertiser?.description ?? item.companyName ?? '').trim() || null;
  const location = String(item.locations?.[0]?.label ?? '').trim() || null;
  const salaryLabel = String(item.salaryLabel ?? '').trim();
  const postedAt = dateOnly(item.listingDate);

  return {
    id: `jobsdb:${sourceId}`,
    source: 'jobsdb',
    title,
    company,
    location,
    salary: salaryLabel || null,
    postedAt,
    url,
    excerpt: excerptOf(item.teaser, options.excerptLength ?? 300),
    stillListed: true,
  };
}

/**
 * 抓取一个关键词的全部页。
 *
 * 失败语义（T3 验收）：第 1 页失败必须抛错 —— 第 1 页挂了说明端点或网络有问题，
 * 返回空数组会被下游读成「今天没有新岗位」；第 2 页起失败只记一条 stderr，
 * 返回已收集的部分。
 */
export async function fetchJobsdb(config = {}, { keywords, http, sleep, log = console, onPartial } = {}) {
  const apiUrl = assertAllowedHost(config.api ?? DEFAULT_API);
  const origin = deriveOrigin(apiUrl);
  const siteKey = config.siteKey ?? DEFAULT_SITE_KEY;
  const pageSize = Number(config.pageSize) || 30;
  const maxPages = Number(config.maxPages) || 3;
  const pageDelayMs = Number(config.pageDelayMs) || 0;
  const wait = sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const fetchJson = http?.fetchJson ?? defaultFetchJson;

  const collected = [];
  const seenIds = new Set();

  for (let page = 1; page <= maxPages; page++) {
    let json;
    try {
      json = await fetchJson(buildSearchUrl(origin, { siteKey, keywords, pageSize, page }));
    } catch (err) {
      if (page === 1) throw err;
      log.error(`jobsdb: 第 ${page} 页抓取失败（非致命，保留已收集的 ${collected.length} 条）—— ${err.message}`);
      // 告知调用方这次是「抓了一半」：半程结果没有下架判定权
      onPartial?.(`第 ${page} 页失败：${err.message}`);
      break;
    }

    const data = Array.isArray(json?.data) ? json.data : [];
    if (data.length === 0) break;

    for (const item of data) {
      const job = parseJobsdbItem(item, origin, config);
      // 跨关键词、跨页的重复在这里先挡一道；主库层的去重是第二道
      if (job && !seenIds.has(job.id)) {
        seenIds.add(job.id);
        collected.push(job);
      }
    }

    if (data.length < pageSize) break;
    if (page < maxPages && pageDelayMs > 0) await wait(pageDelayMs);
  }

  return collected;
}
