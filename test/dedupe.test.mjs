// T6 — 两层去重与主库 upsert。本项目最容易出错的部分，测试先写。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeTitle, normalizeCompany, normalizeLocation, fingerprintOf, isNew, upsert } from '../src/dedupe.mjs';

const NOW = new Date('2026-10-13T23:47:31Z');
const DAY = 24 * 60 * 60 * 1000;

/** 造一条已入库记录（模拟从 data/jobs.json 读回来的）。 */
function stored(over = {}) {
  const base = {
    id: 'jobsdb:1',
    source: 'jobsdb',
    tracks: ['paralegal'],
    title: 'Paralegal',
    company: 'Example & Co',
    location: 'Wan Chai, Wan Chai District',
    salary: null,
    postedAt: '2026-10-01',
    firstSeenAt: '2026-10-05T00:00:00Z',
    lastSeenAt: '2026-10-12T00:00:00Z',
    url: 'https://hk.jobsdb.com/job/1',
    excerpt: 'x',
    stillListed: true,
  };
  const rec = { ...base, ...over };
  rec.fingerprint = over.fingerprint ?? fingerprintOf(rec);
  return rec;
}

/** 造一条本次扫描到的新记录。 */
function incoming(over = {}) {
  return {
    id: 'jobsdb:1',
    source: 'jobsdb',
    tracks: ['paralegal'],
    title: 'Paralegal',
    company: 'Example & Co',
    location: 'Wan Chai, Wan Chai District',
    salary: null,
    postedAt: '2026-10-12',
    url: 'https://hk.jobsdb.com/job/1',
    excerpt: null,
    stillListed: true,
    ...over,
  };
}

// ---------------------------------------------------------------- 标题归一化

test('归一化：大小写、全角半角、多余空格', () => {
  assert.equal(normalizeTitle('Trainee  Solicitor'), 'trainee solicitor');
  assert.equal(normalizeTitle('ＴＲＡＩＮＥＥ　ＳＯＬＩＣＩＴＯＲ'), 'trainee solicitor');
  assert.equal(normalizeTitle('  Trainee\tSolicitor \n'), 'trainee solicitor');
});

test('归一化：/ 分隔的多头广告，头序不影响指纹', () => {
  assert.equal(normalizeTitle('Paralegal / Trainee Solicitor'), normalizeTitle('Trainee Solicitor/Paralegal'));
  assert.equal(normalizeTitle('Paralegal/Legal Executive/ Trainee Solicitor'), normalizeTitle('Trainee Solicitor / Legal Executive / Paralegal'));
});

test('归一化：标点与单复数不影响指纹', () => {
  assert.equal(normalizeTitle('Paralegal (Civil Litigation)'), normalizeTitle('Paralegal - Civil Litigation'));
  assert.equal(normalizeTitle('Trainee Solicitors'), normalizeTitle('Trainee Solicitor'));
});

test('归一化不会把真正不同的岗位合到一起', () => {
  assert.notEqual(normalizeTitle('Paralegal (Corporate)'), normalizeTitle('Paralegal (Litigation)'));
  assert.notEqual(normalizeTitle('Senior Paralegal'), normalizeTitle('Junior Paralegal'));
  assert.notEqual(normalizeTitle('Trainee Solicitor'), normalizeTitle('Paralegal'));
});

test('归一化保留中文', () => {
  assert.equal(normalizeTitle('法务专员'), '法务专员');
});

// ---------------------------------------------------------------- 指纹

test('指纹 = sha1(公司|归一化标题|地点)，且稳定', () => {
  const a = fingerprintOf({ company: 'Example & Co', title: 'Paralegal', location: 'Wan Chai, Wan Chai District' });
  const b = fingerprintOf({ company: 'example & co.', title: 'PARALEGAL', location: 'Wan Chai,  Wan Chai District' });
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{40}$/);
});

test('公司或地点不同，指纹就不同', () => {
  const base = { company: 'A & Co', title: 'Paralegal', location: 'Wan Chai' };
  assert.notEqual(fingerprintOf(base), fingerprintOf({ ...base, company: 'B & Co' }));
  assert.notEqual(fingerprintOf(base), fingerprintOf({ ...base, location: 'Central' }));
});

test('公司名归一化只做大小写与标点，不做后缀消除（避免误合两家所）', () => {
  assert.equal(normalizeCompany('Henry Wai & Co.,Solicitors LLP'), normalizeCompany('henry wai  co solicitors llp'));
  assert.notEqual(normalizeCompany('Tsui & Co'), normalizeCompany('Tsui & Company'));
  assert.equal(normalizeLocation('Wan Chai,  Wan Chai District'), 'wan chai wan chai district');
});

// ---------------------------------------------------------------- NEW 徽章

test('NEW = 首次见到在最近 7 天内，与发布日期无关', () => {
  const fresh = stored({ firstSeenAt: new Date(NOW - 3 * DAY).toISOString(), postedAt: '2026-01-01' });
  const old = stored({ firstSeenAt: new Date(NOW - 30 * DAY).toISOString(), postedAt: new Date(NOW - DAY).toISOString() });

  assert.equal(isNew(fresh, NOW, 7), true, '半年前发布但三天前首次见到 → NEW');
  assert.equal(isNew(old, NOW, 7), false, '昨天发布但一个月前就见过 → 不是 NEW');
});

test('静默期入库的记录永远不点亮 NEW 徽章', () => {
  const r = stored({ firstSeenAt: NOW.toISOString(), suppressNew: true });
  assert.equal(isNew(r, NOW, 7), false);
});

// ---------------------------------------------------------------- upsert

test('同 id 重复出现只留一条', () => {
  const { jobs, added } = upsert([], [incoming(), incoming()], { now: NOW });
  assert.equal(jobs.length, 1);
  assert.equal(added.length, 1);
});

test('新记录写入 firstSeenAt / lastSeenAt / stillListed', () => {
  const { jobs } = upsert([], [incoming()], { now: NOW });
  assert.equal(jobs[0].firstSeenAt, NOW.toISOString());
  assert.equal(jobs[0].lastSeenAt, NOW.toISOString());
  assert.equal(jobs[0].stillListed, true);
  assert.equal(jobs[0].fingerprint, fingerprintOf(jobs[0]));
});

test('repost 换 id：合并进原记录，保留 firstSeenAt，新 id 追加', () => {
  const before = stored();
  const repost = incoming({ id: 'jobsdb:2', url: 'https://hk.jobsdb.com/job/2', postedAt: '2026-10-12' });

  const { jobs, added } = upsert([before], [repost], { now: NOW });

  assert.equal(jobs.length, 1, 'repost 不产生第二条记录');
  assert.equal(added.length, 0);
  assert.equal(jobs[0].id, 'jobsdb:1', 'canonical id 保持首次那条');
  assert.deepEqual(jobs[0].repostIds, ['jobsdb:2']);
  assert.equal(jobs[0].firstSeenAt, '2026-10-05T00:00:00Z', '保留首次见到的时间');
  assert.equal(jobs[0].lastSeenAt, NOW.toISOString());
  assert.equal(jobs[0].postedAt, '2026-10-12', '发布日期取最新');
  assert.equal(isNew(jobs[0], NOW, 7), false, '一个月前见过的岗位 repost 后不重新点亮 NEW');
});

test('repost 多次只累积 id，不重复累积', () => {
  const { jobs } = upsert([stored()], [
    incoming({ id: 'jobsdb:2' }),
    incoming({ id: 'jobsdb:3' }),
    incoming({ id: 'jobsdb:2' }),
  ], { now: NOW });
  assert.deepEqual(jobs[0].repostIds, ['jobsdb:2', 'jobsdb:3']);
});

test('跨关键词重叠：同一条被两个 track 抓到时合并 tracks', () => {
  const { jobs } = upsert([], [
    incoming({ tracks: ['trainee'] }),
    incoming({ tracks: ['paralegal'] }),
  ], { now: NOW });
  assert.equal(jobs.length, 1);
  assert.deepEqual(jobs[0].tracks.sort(), ['paralegal', 'trainee']);
});

test('按 id 命中已有记录时也合并 tracks，不新建', () => {
  const before = stored({ tracks: ['trainee'] });
  const { jobs, added } = upsert([before], [incoming({ tracks: ['paralegal'] })], { now: NOW });
  assert.equal(added.length, 0);
  assert.deepEqual(jobs[0].tracks.sort(), ['paralegal', 'trainee']);
});

test('消失后再出现：stillListed 翻回 true，firstSeenAt 不变', () => {
  const gone = stored({ stillListed: false });
  const { jobs } = upsert([gone], [incoming()], { now: NOW });
  assert.equal(jobs[0].stillListed, true);
  assert.equal(jobs[0].firstSeenAt, '2026-10-05T00:00:00Z');
});

test('本次没见到就置 stillListed=false，但记录保留不删', () => {
  const a = stored({ id: 'jobsdb:1' });
  const b = stored({ id: 'jobsdb:9', title: 'Trainee Solicitor', tracks: ['trainee'], fingerprint: undefined });

  const { jobs, delisted } = upsert([a, b], [incoming()], { now: NOW });

  assert.equal(jobs.length, 2, '下架记录保留（历史页要用）');
  const gone = jobs.find((j) => j.id === 'jobsdb:9');
  assert.equal(gone.stillListed, false);
  assert.equal(gone.lastSeenAt, '2026-10-12T00:00:00Z', 'lastSeenAt 不被改写');
  assert.deepEqual(delisted.map((j) => j.id), ['jobsdb:9']);
});

test('源失败时不能把它名下的记录判为下架', () => {
  const jdb = stored({ id: 'jobsdb:1' });
  const li = stored({ id: 'linkedin:5', source: 'linkedin' });

  // 只有 jobsdb 跑完；linkedin 这次挂了
  const { jobs } = upsert([jdb, li], [incoming({ id: 'jobsdb:1' })], {
    now: NOW,
    completeSources: new Set(['jobsdb']),
  });

  const linkedin = jobs.find((j) => j.id === 'linkedin:5');
  assert.equal(linkedin.stillListed, true, '没跑成功的源不算下架');
  assert.equal(jobs.find((j) => j.id === 'jobsdb:1').stillListed, true);
});

test('指纹命中按源隔离：两个源的同名岗位是两条记录', () => {
  const jdb = stored({ id: 'jobsdb:1', source: 'jobsdb' });
  const li = incoming({ id: 'linkedin:1', source: 'linkedin', url: 'https://linkedin.com/jobs/view/1' });

  const { jobs } = upsert([jdb], [li], { now: NOW, completeSources: new Set(['jobsdb', 'linkedin']) });

  assert.equal(jobs.length, 2, '不同来源各自的 Listing 保留各自的 URL');
  assert.equal(jobs.find((j) => j.source === 'linkedin').repostIds, undefined);
});

test('已入库记录缺 fingerprint 时补算（老数据自愈）', () => {
  const legacy = stored();
  delete legacy.fingerprint;

  const { jobs } = upsert([legacy], [incoming({ id: 'jobsdb:2' })], { now: NOW });

  assert.equal(jobs.length, 1, '补算指纹后仍能识别为同一条');
  assert.deepEqual(jobs[0].repostIds, ['jobsdb:2']);
});

test('静默期：入库但不点亮 NEW', () => {
  const { jobs } = upsert([], [incoming()], { now: NOW, silentNew: true });
  assert.equal(jobs[0].suppressNew, true);
  assert.equal(isNew(jobs[0], NOW, 7), false);
  assert.equal(jobs[0].firstSeenAt, NOW.toISOString(), '时间照记，只是不打徽章');
});

test('已有记录字段不被入参里的 null 覆盖', () => {
  const before = stored({ excerpt: '原有摘要', salary: '$30k' });
  const { jobs } = upsert([before], [incoming({ excerpt: null, salary: null })], { now: NOW });
  assert.equal(jobs[0].excerpt, '原有摘要');
  assert.equal(jobs[0].salary, '$30k');
});

test('新记录带上新增的字段（薪资/摘要）', () => {
  const { jobs } = upsert([], [incoming({ salary: '$25k', excerpt: 'abc' })], { now: NOW });
  assert.equal(jobs[0].salary, '$25k');
  assert.equal(jobs[0].excerpt, 'abc');
});

// ---------------------------------------------------------------- JD 全文

test('新记录的全文入库；没有全文时字段是 null 而不是 undefined', () => {
  const withText = upsert([], [incoming({ description: '职责若干。' })], { now: NOW }).jobs[0];
  assert.equal(withText.description, '职责若干。');

  const without = upsert([], [incoming()], { now: NOW }).jobs[0];
  assert.equal(without.description, null, '字段要在，值可以是 null —— 缺字段和「没有正文」是两回事');
});

test('已有全文的记录不被后来的 null 覆盖', () => {
  const before = stored({ description: '第一次抓到的全文' });
  const { jobs } = upsert([before], [incoming({ description: null })], { now: NOW });
  assert.equal(jobs[0].description, '第一次抓到的全文');
});

test('原先没抓到全文的记录，后续某次抓到了要补上', () => {
  const before = stored({ description: null });
  const { jobs } = upsert([before], [incoming({ description: '后来补上的全文' })], { now: NOW });
  assert.equal(jobs[0].description, '后来补上的全文');
});

test('repost 合进来时也按「空着才补」处理全文', () => {
  const before = stored({ description: '原记录的全文' });
  const { jobs } = upsert([before], [incoming({ id: 'jobsdb:999', description: 'repost 带来的全文' })], { now: NOW });
  assert.equal(jobs.length, 1, '指纹命中 → 仍是同一条记录');
  assert.equal(jobs[0].description, '原记录的全文');
});

test('upsert 不改写入参本身', () => {
  const before = [stored()];
  const snapshot = JSON.stringify(before);
  upsert(before, [incoming({ id: 'jobsdb:2' })], { now: NOW });
  assert.equal(JSON.stringify(before), snapshot);
});

test('老记录里缺失的 description 字段被归一成 null', () => {
  const before = stored();
  delete before.description;
  const { jobs } = upsert([before], [incoming({ description: null })], { now: NOW });
  assert.equal(jobs[0].description, null, '缺字段与「没有正文」不该是两种状态');
});
