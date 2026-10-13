// T9 / T10 / T11 — 站点筛选逻辑（两个页面共用）。纯函数，不碰 DOM。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isNew, isRecent, matchesQuery, filterJobs, sortJobs, paginate, readState, writeState, readApplied, writeApplied } from '../docs/jobs-core.mjs';

const NOW = Date.parse('2026-10-13T12:00:00Z');
const DAY = 86400000;
const WINDOWS = { recentDays: 7, newBadgeDays: 7 };

const job = (over = {}) => ({
  id: 'jobsdb:1',
  title: 'Paralegal',
  company: 'Example & Co',
  location: 'Wan Chai',
  tracks: ['paralegal'],
  postedAt: '2026-10-12',
  firstSeenAt: '2026-10-12T00:00:00Z',
  stillListed: true,
  ...over,
});

const iso = (msAgo) => new Date(NOW - msAgo).toISOString();
const ymd = (msAgo) => iso(msAgo).slice(0, 10);

// ------------------------------------------------------------ NEW 徽章

test('NEW 依据 firstSeenAt，不看 postedAt', () => {
  assert.equal(isNew(job({ firstSeenAt: iso(3 * DAY), postedAt: '2026-01-01' }), NOW, WINDOWS), true);
  assert.equal(isNew(job({ firstSeenAt: iso(30 * DAY) }), NOW, WINDOWS), false);
});

test('静默期的记录不打 NEW 徽章', () => {
  assert.equal(isNew(job({ firstSeenAt: iso(DAY), suppressNew: true }), NOW, WINDOWS), false);
});

test('7 天窗口按 postedAt 判定', () => {
  assert.equal(isRecent(job({ postedAt: ymd(3 * DAY) }), NOW, WINDOWS), true);
  assert.equal(isRecent(job({ postedAt: ymd(10 * DAY) }), NOW, WINDOWS), false);
  assert.equal(isRecent(job({ postedAt: null }), NOW, WINDOWS), false, '没日期就不进「最近」列表');
});

test('天数来自 feed.meta.windows，改了 config 就跟着变', () => {
  assert.equal(isNew(job({ firstSeenAt: iso(20 * DAY) }), NOW, { newBadgeDays: 30 }), true);
  assert.equal(isRecent(job({ postedAt: ymd(20 * DAY) }), NOW, { recentDays: 30 }), true);
});

// ------------------------------------------------------------ 搜索

test('关键词搜标题与公司，大小写不敏感', () => {
  assert.equal(matchesQuery(job(), 'paralegal'), true);
  assert.equal(matchesQuery(job(), 'EXAMPLE'), true);
  assert.equal(matchesQuery(job({ title: 'Trainee Solicitor', company: 'W K To & Co' }), 'wk'), false);
  assert.equal(matchesQuery(job(), 'w k'), false);
  assert.equal(matchesQuery(job(), ''), true, '空关键词不过滤');
});

test('多个词之间是 AND', () => {
  const j = job({ title: 'Paralegal', company: 'Central Law Firm' });
  assert.equal(matchesQuery(j, 'paralegal central'), true);
  assert.equal(matchesQuery(j, 'paralegal kowloon'), false);
});

test('关键词也搜职位全文，不只是标题与公司', () => {
  const j = job({ title: 'Paralegal', company: 'Example & Co', description: 'Drafting and reviewing ISDA documentation.' });

  assert.equal(matchesQuery(j, 'isda'), true);
  assert.equal(matchesQuery(j, 'documentation'), true);
  assert.equal(matchesQuery(j, 'isda drafting'), true);
  assert.equal(matchesQuery(j, 'isda arbitration'), false, 'AND 语义在全文里同样成立');
});

test('没有全文时不炸，只是搜不到', () => {
  assert.equal(matchesQuery(job({ description: undefined }), 'isda'), false);
  assert.equal(matchesQuery(job({ description: null }), 'paralegal'), true);
});

test('全文与标题都命中同一个词也只算命中一次', () => {
  const j = job({ title: 'Paralegal', description: 'Paralegal role in a busy team.' });
  assert.equal(matchesQuery(j, 'paralegal'), true);
});

test('同一批职位反复筛选结果稳定（干草堆缓存不改变语义）', () => {
  const jobs = [job({ id: 'a', description: 'ISDA work' }), job({ id: 'b', company: 'Isda & Co' })];
  const first = filterJobs(jobs, { q: 'isda', view: 'archive', now: NOW, windows: WINDOWS }).map((j) => j.id);
  const second = filterJobs(jobs, { q: 'isda', view: 'archive', now: NOW, windows: WINDOWS }).map((j) => j.id);
  assert.deepEqual(first, ['a', 'b']);
  assert.deepEqual(second, first);
});

// ------------------------------------------------------------ 筛选与排序

test('track 筛选：多标签职位在两个筛选下都出现', () => {
  const both = job({ id: 'jobsdb:2', title: 'Paralegal / Trainee Solicitor', tracks: ['trainee', 'paralegal'] });
  const jobs = [job({ id: 'jobsdb:1', tracks: ['paralegal'] }), job({ id: 'jobsdb:3', tracks: ['trainee'] }), both];

  const asParalegal = filterJobs(jobs, { track: 'paralegal', view: 'archive', now: NOW, windows: WINDOWS }).map((j) => j.id);
  const asTrainee = filterJobs(jobs, { track: 'trainee', view: 'archive', now: NOW, windows: WINDOWS }).map((j) => j.id);

  assert.ok(asParalegal.includes('jobsdb:2'));
  assert.ok(asTrainee.includes('jobsdb:2'));
  assert.deepEqual(filterJobs(jobs, { track: 'all', view: 'archive', now: NOW, windows: WINDOWS }).length, 3);
});

test('recent 视图只出 7 天内发布的', () => {
  const jobs = [job({ id: 'a', postedAt: ymd(2 * DAY) }), job({ id: 'b', postedAt: ymd(20 * DAY) })];
  assert.deepEqual(filterJobs(jobs, { view: 'recent', now: NOW, windows: WINDOWS }).map((j) => j.id), ['a']);
  assert.equal(filterJobs(jobs, { view: 'archive', now: NOW, windows: WINDOWS }).length, 2, '归档视图出全部');
});

test('归档视图带上已下架记录（页面负责置灰，不在这里过滤掉）', () => {
  const jobs = [job({ id: 'gone', stillListed: false }), job({ id: 'live' })];
  const out = filterJobs(jobs, { view: 'archive', now: NOW, windows: WINDOWS }).map((j) => j.id);
  assert.deepEqual(out.sort(), ['gone', 'live']);
});

test('排序：按发布日期，同日期按首次见到', () => {
  const jobs = [
    job({ id: 'c', postedAt: '2026-10-01', firstSeenAt: iso(DAY) }),
    job({ id: 'a', postedAt: '2026-10-12', firstSeenAt: iso(3 * DAY) }),
    job({ id: 'b', postedAt: '2026-10-12', firstSeenAt: iso(2 * DAY) }),
  ];
  assert.deepEqual(sortJobs(jobs, 'new').map((j) => j.id), ['b', 'a', 'c']);
  assert.deepEqual(sortJobs(jobs, 'old').map((j) => j.id), ['c', 'a', 'b']);
});

test('排序不改动入参', () => {
  const jobs = [job({ id: 'z', postedAt: '2026-01-01' }), job({ id: 'a', postedAt: '2026-12-01' })];
  const before = jobs.map((j) => j.id);
  sortJobs(jobs, 'new');
  assert.deepEqual(jobs.map((j) => j.id), before);
});

test('分页夹住越界页号', () => {
  const items = Array.from({ length: 120 }, (_, i) => job({ id: `j${i}` }));
  assert.equal(paginate(items, 1, 50).items.length, 50);
  assert.equal(paginate(items, 3, 50).items.length, 20);
  assert.equal(paginate(items, 99, 50).page, 3, '越界回落到最后一页');
  assert.equal(paginate(items, 0, 50).page, 1);
  assert.equal(paginate([], 5, 50).pages, 1);
});

// ------------------------------------------------------------ URL 状态

test('筛选状态写进 URL，默认值不写', () => {
  assert.equal(writeState({ q: '', track: 'all', sort: 'new', page: 1 }), '', '全默认 → 空 query');
  assert.equal(writeState({ q: 'paralegal', track: 'trainee', sort: 'old', page: 3 }), '?q=paralegal&track=trainee&sort=old&page=3');
  assert.equal(readState(writeState({ q: 'a b', track: 'all', sort: 'new', page: 1 })).q, 'a b', '往返不丢值');
});

test('从 URL 读回筛选状态，非法值退回默认', () => {
  assert.deepEqual(readState('?q=a&track=trainee&sort=old&page=2'), { q: 'a', track: 'trainee', sort: 'old', page: 2 });
  assert.deepEqual(readState('?sort=乱写&page=-3'), { q: '', track: 'all', sort: 'new', page: 1 });
  assert.deepEqual(readState(''), { q: '', track: 'all', sort: 'new', page: 1 });
});

// ------------------------------------------------------------ 已投递

test('已投递标记读写 localStorage，损坏数据不炸', () => {
  const store = new Map();
  const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };

  assert.deepEqual([...readApplied(storage)], []);
  writeApplied(storage, new Set(['jobsdb:1', 'linkedin:2']));
  assert.deepEqual([...readApplied(storage)].sort(), ['jobsdb:1', 'linkedin:2']);

  store.set('hkj:applied', '{不是 JSON');
  assert.deepEqual([...readApplied(storage)], []);
});

test('localStorage 不可用时（隐私模式）降级为空集，不抛错', () => {
  const hostile = { getItem() { throw new Error('nope'); }, setItem() { throw new Error('nope'); } };
  assert.deepEqual([...readApplied(hostile)], []);
  assert.doesNotThrow(() => writeApplied(hostile, new Set(['a'])));
});
