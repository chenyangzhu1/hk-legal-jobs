// T3 — JobsDB (SEEK v5) 抓取。fixture 是 2026-10-12 的真实响应。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { fetchJobsdb, parseJobsdbItem, buildSearchUrl, assertAllowedHost, ALLOWED_JOBSTREET_HOSTS } from '../src/sources/jobsdb.mjs';

const PAGE = JSON.parse(readFileSync(new URL('./fixtures/jobsdb-page.json', import.meta.url), 'utf8'));
const CFG = { api: 'https://hk.jobsdb.com/api/jobsearch/v5/search', siteKey: 'HK-Main', pageSize: 30, maxPages: 3, pageDelayMs: 0 };

/** 收集 fetchJson 收到的 URL，并按给定响应脚本作答。 */
function stubHttp(responses) {
  const state = { urls: [], calls: 0 };
  return {
    state,
    http: {
      fetchJson: async (url) => {
        state.urls.push(url);
        const i = Math.min(state.calls, responses.length - 1);
        state.calls++;
        const r = responses[i];
        if (typeof r === 'function') return r();
        return r;
      },
    },
  };
}

test('解析单条：字段逐个对照上游 parseJobstreetItem', () => {
  const origin = 'https://hk.jobsdb.com';
  const job = parseJobsdbItem(PAGE.data[0], origin);

  assert.equal(job.id, 'jobsdb:95201118');
  assert.equal(job.source, 'jobsdb');
  assert.equal(job.title, 'Trainee Solicitor');
  // advertiser.description 优先于 companyName（品牌名更完整）
  assert.equal(job.company, 'Tsui & Co');
  assert.equal(job.location, 'Wan Chai, Wan Chai District');
  assert.equal(job.postedAt, '2026-10-12');
  assert.equal(job.url, 'https://hk.jobsdb.com/job/95201118');
  assert.equal(job.salary, null);
  // teaser 截断为摘要，不存全文
  assert.match(job.excerpt, /^Established in 2004/);
  assert.ok(job.excerpt.length <= 300);
  assert.equal(job.stillListed, true);
  assert.equal(job.firstSeenAt, undefined, '首次见到由 dedupe 层写入');
});

test('缺 title 或 id 的条目返回 null，不产生半条记录', () => {
  assert.equal(parseJobsdbItem({ id: '1' }, 'https://hk.jobsdb.com'), null);
  assert.equal(parseJobsdbItem({ title: 'x' }, 'https://hk.jobsdb.com'), null);
  assert.equal(parseJobsdbItem(null, 'https://hk.jobsdb.com'), null);
});

test('香港市场用 /job/<id> 路径，不带 /id/ 前缀', () => {
  const job = parseJobsdbItem({ id: '42', title: 'Paralegal' }, 'https://hk.jobsdb.com');
  assert.equal(job.url, 'https://hk.jobsdb.com/job/42');
});

test('搜索 URL 带 siteKey 与关键词', () => {
  const url = buildSearchUrl('https://hk.jobsdb.com', { siteKey: 'HK-Main', keywords: 'trainee solicitor', pageSize: 100, page: 2 });
  const u = new URL(url);
  assert.equal(u.pathname, '/api/jobsearch/v5/search');
  assert.equal(u.searchParams.get('siteKey'), 'HK-Main');
  assert.equal(u.searchParams.get('keywords'), 'trainee solicitor');
  assert.equal(u.searchParams.get('pageSize'), '100');
  assert.equal(u.searchParams.get('page'), '2');
  // 地域由 siteKey 锁定，不加 where —— 加了会误杀真实岗位
  assert.equal(u.searchParams.get('where'), null);
});

test('保留 host 白名单：配置写错就打不出去', () => {
  assert.equal(assertAllowedHost('https://hk.jobsdb.com/api/jobsearch/v5/search'), 'https://hk.jobsdb.com/api/jobsearch/v5/search');
  assert.ok(ALLOWED_JOBSTREET_HOSTS.has('hk.jobsdb.com'));
  assert.throws(() => assertAllowedHost('https://evil.example.com/api/jobsearch/v5/search'), /白名单|untrusted/);
  assert.throws(() => assertAllowedHost('http://hk.jobsdb.com/api'), /HTTPS/);
});

test('分页取数并按 id 去重，id 带 jobsdb: 前缀', async () => {
  // pageSize=3 恰好等于本页条数，所以会继续翻第 2 页；第 2 页空 → 停。
  const { state, http } = stubHttp([PAGE, { totalCount: 3, data: [] }]);
  const jobs = await fetchJobsdb({ ...CFG, pageSize: 3 }, { keywords: 'trainee solicitor', http });

  assert.equal(jobs.length, 3);
  assert.ok(jobs.every((j) => j.id.startsWith('jobsdb:')));
  assert.equal(state.calls, 2, '空页即停');
});

test('第 1 页失败要抛错 —— 否则源挂了会被读成「今天没有新岗位」', async () => {
  const { http } = stubHttp([() => { throw new Error('boom'); }]);
  await assert.rejects(() => fetchJobsdb(CFG, { keywords: 'x', http }), /boom/);
});

test('第 2 页失败是非致命的：返回已收集的部分，并上报 partial', async () => {
  const { state, http } = stubHttp([PAGE, () => { throw new Error('page 2 boom'); }]);
  const partials = [];
  const jobs = await fetchJobsdb({ ...CFG, pageSize: 3, maxPages: 3 }, { keywords: 'x', http, onPartial: (r) => partials.push(r) });

  assert.equal(jobs.length, 3);
  assert.equal(state.calls, 2);
  assert.equal(partials.length, 1, '半程结果要告诉调用方，否则会被误当作跑完');
  assert.match(partials[0], /page 2 boom/);
});

test('全程成功时不上报 partial', async () => {
  const { http } = stubHttp([PAGE, { data: [] }]);
  const partials = [];
  await fetchJobsdb({ ...CFG, pageSize: 3, maxPages: 3 }, { keywords: 'x', http, onPartial: (r) => partials.push(r) });
  assert.deepEqual(partials, []);
});

test('结果不满一页即停止翻页', async () => {
  const { state, http } = stubHttp([PAGE]);
  await fetchJobsdb({ ...CFG, pageSize: 30, maxPages: 5 }, { keywords: 'x', http });
  assert.equal(state.calls, 1);
});

test('达到 maxPages 就停', async () => {
  const { state, http } = stubHttp([PAGE]);
  await fetchJobsdb({ ...CFG, pageSize: 3, maxPages: 2 }, { keywords: 'x', http });
  assert.equal(state.calls, 2);
});

test('返回的 URL 全部通过白名单校验（防配置写错把请求打到别处）', async () => {
  const { http } = stubHttp([PAGE, { data: [] }]);
  const jobs = await fetchJobsdb(CFG, { keywords: 'x', http });
  for (const j of jobs) assert.equal(new URL(j.url).hostname, 'hk.jobsdb.com');
});
