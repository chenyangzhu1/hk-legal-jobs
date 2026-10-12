// 站点的纯逻辑：筛选、排序、分页、NEW 判定。index.html 与 archive.html 共用。
//
// 单独成一个文件是为了能测 —— 这部分不碰 DOM，可以用 node:test 直接跑。
//
// 为什么 NEW 规则在这里又写了一遍：Pages 只发布 /docs，页面因此不能 import
// /src 下的模块（dedupe.mjs 还依赖 node:crypto，浏览器里根本加载不了）。
// 两处的**天数**都来自 config.json、经 feed.meta.windows 带过来，
// 所以只有判定语句重复，不会有第二个「7 天」。

export const DAY_MS = 24 * 60 * 60 * 1000;

function windowDays(windows, key, fallback) {
  const value = Number(windows?.[key]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/** NEW = 首次见到在最近 N 天内。静默期入库的记录永不点亮。 */
export function isNew(job, now, windows) {
  if (!job || job.suppressNew === true) return false;
  const seen = Date.parse(job?.firstSeenAt ?? '');
  if (Number.isNaN(seen)) return false;
  return now - seen <= windowDays(windows, 'newBadgeDays', 7) * DAY_MS;
}

/** 「最近发布的职位」按 postedAt 判定（SPEC §6.3）。 */
export function isRecent(job, now, windows) {
  const posted = Date.parse(job?.postedAt ?? '');
  if (Number.isNaN(posted)) return false;
  return now - posted <= windowDays(windows, 'recentDays', 7) * DAY_MS;
}

/** 关键词搜标题 + 公司，大小写与多余空格不敏感。 */
export function matchesQuery(job, query) {
  const q = String(query ?? '').trim().toLowerCase();
  if (!q) return true;
  const haystack = `${job?.title ?? ''} ${job?.company ?? ''}`.toLowerCase();
  // 空格分隔的多个词是 AND：搜「paralegal central」不该被 OR 放大成噪声
  return q.split(/\s+/).every((term) => haystack.includes(term));
}

export function matchesTrack(job, track) {
  if (!track || track === 'all') return true;
  return (job?.tracks ?? []).includes(track);
}

/**
 * 一次筛完。view='recent' 走 7 天窗口，view='archive' 出全部历史。
 * archive 默认带上已下架记录（页面负责置灰）。
 */
export function filterJobs(jobs, { q = '', track = 'all', view = 'recent', now, windows, hideDelisted = false } = {}) {
  return (jobs ?? []).filter((job) => {
    if (hideDelisted && job.stillListed === false) return false;
    if (view === 'recent' && !isRecent(job, now, windows)) return false;
    if (!matchesTrack(job, track)) return false;
    if (!matchesQuery(job, q)) return false;
    return true;
  });
}

/** 排序：'new' 发布日期倒序，'old' 正序。同日期按首次见到同向，保证稳定。 */
export function sortJobs(jobs, sort = 'new') {
  const dir = sort === 'old' ? 1 : -1;
  const cmp = (x, y) => (x < y ? -1 : x > y ? 1 : 0);
  return [...(jobs ?? [])].sort((a, b) => {
    const byPosted = cmp(a?.postedAt ?? '', b?.postedAt ?? '');
    if (byPosted !== 0) return dir * byPosted;
    const bySeen = cmp(a?.firstSeenAt ?? '', b?.firstSeenAt ?? '');
    if (bySeen !== 0) return dir * bySeen;
    return cmp(String(a?.id ?? ''), String(b?.id ?? ''));
  });
}

export function paginate(items, page = 1, pageSize = 50) {
  const total = (items ?? []).length;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const current = Math.min(Math.max(1, Number(page) || 1), pages);
  const start = (current - 1) * pageSize;
  return { items: (items ?? []).slice(start, start + pageSize), page: current, pages, total };
}

/** 从 URL query 读筛选状态；非法值退回默认，不抛错。 */
export function readState(search) {
  const params = new URLSearchParams(search ?? '');
  return {
    q: params.get('q') ?? '',
    track: params.get('track') ?? 'all',
    sort: params.get('sort') === 'old' ? 'old' : 'new',
    page: Math.max(1, Number(params.get('page')) || 1),
  };
}

/**
 * 只把非默认值写进 URL，便于分享/收藏。返回 query 串（可能为空），
 * 不碰 location —— 这样这个模块在 Node 里也能测。
 */
export function writeState(state) {
  const params = new URLSearchParams();
  if (state.q) params.set('q', state.q);
  if (state.track && state.track !== 'all') params.set('track', state.track);
  if (state.sort && state.sort !== 'new') params.set('sort', state.sort);
  if (state.page > 1) params.set('page', String(state.page));
  const query = params.toString();
  return query ? `?${query}` : '';
}

/** 「已投递」标记的读写。存 localStorage，不上服务器（SPEC §8.3）。 */
export function readApplied(storage) {
  try {
    const raw = storage?.getItem('hkj:applied');
    const list = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(list) ? list : []);
  } catch {
    return new Set();
  }
}

export function writeApplied(storage, applied) {
  try {
    storage?.setItem('hkj:applied', JSON.stringify([...applied]));
  } catch {
    // 隐私模式下 localStorage 会抛错；标记丢失不该让页面崩掉
  }
}
