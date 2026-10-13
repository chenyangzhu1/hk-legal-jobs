// 站点逻辑。index.html 与 archive.html 共用这一个文件，靠 <body data-view> 分流。
//
// 零构建、零框架、零依赖：直接 fetch('feed.json')。两个页面的差别只有视图模式
// （recent 走 7 天窗口，archive 出全部历史）。
//
// 第三方内容（公司名、标题、摘要）一律走 textContent 构造 DOM，不拼 innerHTML
// —— 职位描述是从别人站点抓来的**数据**，不是我们的标记。

import { filterJobs, sortJobs, paginate, isNew, readState, writeState, readApplied, writeApplied } from './jobs-core.mjs';

const PAGE_SIZE = 50; // 归档页分页大小，保证千条量级不卡

// 来源显示名的兜底值。正常走 feed.meta.sourceLabels（由 config.json 派生），
// 这里只是 feed 缺字段时页面仍然能读。
const SOURCE_LABELS = { jobsdb: 'JobsDB', linkedin: 'LinkedIn' };

const view = document.body.dataset.view === 'archive' ? 'archive' : 'recent';

const dom = {
  title: document.getElementById('page-title'),
  banner: document.getElementById('banner'),
  q: document.getElementById('q'),
  tracks: document.getElementById('tracks'),
  sort: document.getElementById('sort'),
  status: document.getElementById('status'),
  list: document.getElementById('list'),
  pager: document.getElementById('pager'),
};

let feed = { meta: {}, jobs: [] };
let state = readState(location.search);
let applied = readApplied(localStorage);

// 哪些行被展开了。渲染是整页重绘的，所以这个状态必须留在 DOM 之外，
// 否则筛选、翻页、标记已投递之后展开的行会自己收回去。
const expanded = new Set();

/** 建元素的小工具；children 里是字符串的一律走 textContent。 */
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'class') node.className = value;
    else if (value !== undefined && value !== null) node.setAttribute(key, value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

/** 来源显示名：以 config 派生的 meta 为准，兜底才用前端映射。 */
function sourceLabel(name) {
  return feed.meta.sourceLabels?.[name] ?? SOURCE_LABELS[name] ?? name;
}

function syncUrl() {
  const query = writeState(state);
  history.replaceState(null, '', query || location.pathname);
}

// ------------------------------------------------------------------ 降级横幅

function renderBanner() {
  const { complete, sources = {} } = feed.meta;
  if (complete !== false) {
    dom.banner.hidden = true;
    return;
  }
  const failed = Object.entries(sources).filter(([, status]) => status !== 'ok');

  dom.banner.hidden = false;
  dom.banner.replaceChildren(
    el('strong', {}, '本次数据不完整'),
    el('span', {}, ` —— ${failed.map(([name, status]) => `${SOURCE_LABELS[name] ?? name}（${status}）`).join('、')} 未能取到数据，下面的列表可能缺少这些来源的岗位。`),
  );
}

// ------------------------------------------------------------------ 控件

function renderControls() {
  const tracks = feed.meta.tracks ?? {};
  const options = [['all', view === 'recent' ? '全部' : '全部（含已下架）'], ...Object.entries(tracks)];

  dom.tracks.replaceChildren(
    ...options.map(([id, label]) =>
      el('button', {
        type: 'button',
        class: 'chip',
        'data-track': id,
        'aria-pressed': String(state.track === id),
      }, label),
    ),
  );

  dom.q.value = state.q;
  dom.sort.value = state.sort;
}

// ------------------------------------------------------------------ 职位行

function jobRow(job, now) {
  const title = el('a', { href: job.url, target: '_blank', rel: 'noopener noreferrer' }, job.title);

  const heading = el('h2', { class: 'job-title' }, title);
  if (isNew(job, now, feed.meta.windows)) heading.append(el('span', { class: 'badge badge-new' }, 'NEW'));
  if (job.stillListed === false) heading.append(el('span', { class: 'badge badge-gone' }, '已下架'));

  const meta = [
    job.company,
    job.location,
    job.salary,
    job.postedAt ? `发布 ${job.postedAt}` : null,
    sourceLabel(job.source),
  ].filter(Boolean).join(' · ');

  // 全文比摘要长才值得给个展开按钮 —— 否则点开只是把同一段话又看一遍
  const hasFullText =
    typeof job.description === 'string' && job.description.length > (job.excerpt?.length ?? 0);
  const isExpanded = hasFullText && expanded.has(job.id);

  const text = isExpanded
    ? el('p', { class: 'job-description' }, job.description)
    : job.excerpt
      ? el('p', { class: 'job-excerpt' }, job.excerpt)
      : null;

  const expand = hasFullText
    ? el('button', {
        type: 'button',
        class: 'expand-toggle',
        'data-id': job.id,
        'aria-expanded': String(isExpanded),
      }, isExpanded ? '收起' : '展开全文')
    : null;

  const isApplied = applied.has(job.id);
  const toggle = el('button', {
    type: 'button',
    class: 'apply-toggle',
    'data-id': job.id,
    'aria-pressed': String(isApplied),
  }, isApplied ? '已投递 ✓' : '标记已投递');

  return el('article', { class: `job${isApplied ? ' is-applied' : ''}${job.stillListed === false ? ' is-gone' : ''}` },
    el('div', { class: 'job-body' },
      heading,
      el('p', { class: 'job-meta' }, meta),
      text,
      expand,
    ),
    toggle,
  );
}

// ------------------------------------------------------------------ 主渲染

function render() {
  const now = Date.now();
  const filtered = filterJobs(feed.jobs, { ...state, view, now, windows: feed.meta.windows });
  const sorted = sortJobs(filtered, state.sort);

  const page = view === 'archive' ? paginate(sorted, state.page, PAGE_SIZE) : { items: sorted, page: 1, pages: 1 };
  state.page = page.page;

  if (sorted.length === 0) {
    dom.list.replaceChildren(el('p', { class: 'empty' }, '没有符合条件的职位。'));
  } else {
    dom.list.replaceChildren(...page.items.map((job) => jobRow(job, now)));
  }

  const appliedCount = sorted.filter((job) => applied.has(job.id)).length;
  const recentDays = feed.meta.windows?.recentDays ?? 7;
  const scope = view === 'recent' ? `最近 ${recentDays} 天发布` : '全部历史';
  dom.status.textContent =
    `${scope} ${filtered.length} 条` +
    (filtered.length !== feed.jobs.length ? `（全库 ${feed.jobs.length} 条）` : '') +
    (appliedCount ? ` · 已投递 ${appliedCount}` : '') +
    (feed.meta.ranAt ? ` · 数据更新于 ${feed.meta.ranAt.slice(0, 16).replace('T', ' ')} UTC` : '');

  // 归档页分页
  if (view === 'archive' && page.pages > 1) {
    dom.pager.hidden = false;
    dom.pager.replaceChildren(
      el('button', { type: 'button', class: 'page-btn', 'data-page': page.page - 1, disabled: page.page <= 1 ? '' : undefined }, '上一页'),
      el('span', { class: 'page-info' }, `第 ${page.page} / ${page.pages} 页`),
      el('button', { type: 'button', class: 'page-btn', 'data-page': page.page + 1, disabled: page.page >= page.pages ? '' : undefined }, '下一页'),
    );
  } else {
    dom.pager.hidden = true;
    dom.pager.replaceChildren();
  }

  if (view === 'recent' && dom.title) {
    const heading = `香港法律职位 · 最近 ${recentDays} 天`;
    dom.title.textContent = heading;
    document.title = heading;
  }

  syncUrl();
}

// ------------------------------------------------------------------ 事件

dom.q.addEventListener('input', () => {
  state.q = dom.q.value;
  state.page = 1;
  render();
});

dom.tracks.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-track]');
  if (!button) return;
  state.track = button.dataset.track;
  state.page = 1;
  renderControls();
  render();
});

dom.sort.addEventListener('change', () => {
  state.sort = dom.sort.value === 'old' ? 'old' : 'new';
  state.page = 1;
  render();
});

dom.list.addEventListener('click', (event) => {
  const expand = event.target.closest('button.expand-toggle');
  if (expand) {
    const { id } = expand.dataset;
    if (expanded.has(id)) expanded.delete(id);
    else expanded.add(id);
    render();
    return;
  }

  const button = event.target.closest('button.apply-toggle');
  if (!button) return;
  const { id } = button.dataset;
  if (applied.has(id)) applied.delete(id);
  else applied.add(id);
  writeApplied(localStorage, applied);
  render(); // 整页重绘：筛选项与计数都要跟着变
});

dom.pager.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-page]');
  if (!button) return;
  state.page = Number(button.dataset.page);
  render();
  window.scrollTo({ top: 0, behavior: 'smooth' });
});

// ------------------------------------------------------------------ 启动

fetch('feed.json', { cache: 'no-cache' })
  .then((res) => {
    if (!res.ok) throw new Error(`feed.json 返回 HTTP ${res.status}`);
    return res.json();
  })
  .then((data) => {
    feed = { meta: data.meta ?? {}, jobs: data.jobs ?? [] };
    renderBanner();
    renderControls();
    render();
  })
  .catch((err) => {
    dom.banner.hidden = false;
    dom.banner.replaceChildren(el('strong', {}, `加载 feed.json 失败：${err.message}`));
    dom.list.replaceChildren();
  });
