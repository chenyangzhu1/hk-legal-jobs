// T4 — LinkedIn jobs-guest 抓取。fixture 是 2026-10-12 的真实响应片段。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { parseLinkedinCards, fetchLinkedin, buildSearchUrl, LINKEDIN_SEARCH_URL } from '../src/sources/linkedin.mjs';

const HTML = readFileSync(new URL('./fixtures/linkedin-search.html', import.meta.url), 'utf8');
const CFG = { searchUrl: LINKEDIN_SEARCH_URL, location: 'Hong Kong', pageSize: 10, maxPages: 3, pageDelayMs: 0 };

/** 按 start 参数脚本化作答。 */
function stubHttp(byStart) {
  const state = { urls: [] };
  return {
    state,
    http: {
      fetchText: async (url) => {
        state.urls.push(url);
        const start = new URL(url).searchParams.get('start');
        return byStart[start] ?? '';
      },
    },
  };
}

test('解析搜索卡片：id / 标题 / 公司 / 地点 / 日期 / 链接', () => {
  const cards = parseLinkedinCards(HTML);

  assert.equal(cards.length, 10, 'fixture 是真实响应的一整页');
  const [a, b] = cards;

  assert.equal(a.id, 'linkedin:4466161768');
  assert.equal(a.source, 'linkedin');
  assert.equal(a.title, 'Senior Paralegal');
  assert.equal(a.company, 'Gammon Construction Limited');
  assert.equal(a.location, 'Kwun Tong District, Hong Kong SAR');
  assert.equal(a.postedAt, '2026-09-15');
  assert.equal(a.url, 'https://hk.linkedin.com/jobs/view/senior-paralegal-at-gammon-construction-limited-4466161768');
  assert.equal(a.salary, null);
  assert.equal(a.excerpt, null, '搜索卡片不带 JD，摘要留空而不是编一个');
  assert.equal(a.stillListed, true);

  assert.equal(b.title, 'IP Paralegal');
  assert.equal(b.company, 'Simmons & Simmons');
});

test('HTML 实体解码（&amp; 不能原样进页面）', () => {
  const cards = parseLinkedinCards(HTML);
  assert.equal(cards[2].location, 'Central & Western District, Hong Kong SAR');
});

test('URL 去掉查询串，保留干净的职位页链接', () => {
  for (const c of parseLinkedinCards(HTML)) {
    assert.ok(!c.url.includes('?'), c.url);
    assert.match(c.url, /linkedin\.com\/jobs\/view\//);
  }
});

test('卡片缺链接时用 id 兜底构造 URL', () => {
  const minimal = '<div data-entity-urn="urn:li:jobPosting:1234567890"><h3 class="base-search-card__title">Paralegal</h3></div>';
  const [card] = parseLinkedinCards(minimal);
  assert.equal(card.url, 'https://www.linkedin.com/jobs/view/1234567890');
  assert.equal(card.id, 'linkedin:1234567890');
});

test('没有标题的卡片跳过，不影响后续卡片', () => {
  const broken = '<div data-entity-urn="urn:li:jobPosting:11111111"></div><div data-entity-urn="urn:li:jobPosting:22222222"><h3 class="base-search-card__title">Paralegal</h3></div>';
  const cards = parseLinkedinCards(broken);
  assert.equal(cards.length, 1);
  assert.equal(cards[0].id, 'linkedin:22222222');
});

test('空响应体 = 没有更多结果，返回空数组', () => {
  assert.deepEqual(parseLinkedinCards(''), []);
  assert.deepEqual(parseLinkedinCards('   \n  '), []);
});

test('结构变了必须抛错 —— 源挂了不能被读成「今天没有新岗位」', () => {
  assert.throws(
    () => parseLinkedinCards('<html><body><div class="auth-wall">请登录</div></body></html>'),
    /结构|解析/,
  );
});

test('搜索 URL 带 keywords / location / start，每页固定 10 条', () => {
  const url = new URL(buildSearchUrl(LINKEDIN_SEARCH_URL, { keywords: 'trainee solicitor', location: 'Hong Kong', page: 3 }));
  assert.equal(url.origin + url.pathname, LINKEDIN_SEARCH_URL);
  assert.equal(url.searchParams.get('keywords'), 'trainee solicitor');
  assert.equal(url.searchParams.get('location'), 'Hong Kong');
  assert.equal(url.searchParams.get('start'), '20');
});

test('翻页直到某页没有卡片', async () => {
  const { state, http } = stubHttp({ 0: HTML, 10: HTML, 20: '' });
  const jobs = await fetchLinkedin(CFG, { keywords: 'paralegal', http });

  assert.equal(state.urls.length, 3, '第 3 页空响应体 → 停');
  // 第 1、2 页各 10 条，按 id 去重后仍是 10 条
  assert.equal(jobs.length, 10);
  assert.ok(jobs.every((j) => j.id.startsWith('linkedin:')));
});

test('第 1 页解析失败要抛错', async () => {
  const { http } = stubHttp({ 0: '<html><body>nope</body></html>' });
  await assert.rejects(() => fetchLinkedin(CFG, { keywords: 'x', http }), /结构|解析/);
});

test('第 1 页零结果视为异常并抛错（这些关键词不该一条都没有）', async () => {
  const { http } = stubHttp({ 0: '' });
  await assert.rejects(() => fetchLinkedin(CFG, { keywords: 'x', http }), /第 1 页/);
});

test('第 2 页起解析失败是非致命的，保留已收集的部分', async () => {
  const { http } = stubHttp({ 0: HTML, 10: '<html><body>nope</body></html>' });
  const jobs = await fetchLinkedin(CFG, { keywords: 'x', http });
  assert.equal(jobs.length, 10);
});

test('达到 maxPages 就停', async () => {
  const { state, http } = stubHttp({ 0: HTML, 10: HTML, 20: HTML });
  await fetchLinkedin({ ...CFG, maxPages: 2 }, { keywords: 'x', http });
  assert.equal(state.urls.length, 2);
});
