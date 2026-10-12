// 站点冒烟测试：零构建的代价是没人替你检查 HTML 与 JS 之间的接缝。
// 这些断言专门盯那些「改一边忘另一边」的错。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
const PAGES = ['docs/index.html', 'docs/archive.html'];

test('两个页面都加载同一份 app.js 与样式（筛选逻辑不重复实现）', () => {
  for (const page of PAGES) {
    const html = read(page);
    assert.match(html, /<script src="app\.js" type="module">/, page);
    assert.match(html, /href="style\.css"/, page);
    assert.match(html, /data-view="(recent|archive)"/, page);
  }
});

test('app.js 用到的每个元素 id 都真实存在于两个页面里', () => {
  const app = read('docs/app.js');
  const ids = [...app.matchAll(/getElementById\('([^']+)'\)/g)].map((m) => m[1]);
  assert.ok(ids.length >= 6, `只找到 ${ids.length} 个 id，选择器写法可能变了`);

  for (const page of PAGES) {
    const html = read(page);
    for (const id of ids) {
      assert.match(html, new RegExp(`id="${id}"`), `${page} 缺 #${id}`);
    }
  }
});

test('app.js 与 jobs-core.mjs 都不拼 innerHTML（第三方内容一律走 textContent）', () => {
  for (const file of ['docs/app.js', 'docs/jobs-core.mjs']) {
    const source = read(file);
    assert.ok(!/\.innerHTML\s*=/.test(source), `${file} 出现了 innerHTML 赋值`);
    assert.ok(!/insertAdjacentHTML/.test(source), `${file} 出现了 insertAdjacentHTML`);
    assert.ok(!/\beval\(/.test(source), `${file} 出现了 eval`);
  }
});

test('app.js 从 jobs-core.mjs 取筛选逻辑，而不是自带一份', () => {
  assert.match(read('docs/app.js'), /from '\.\/jobs-core\.mjs'/);
});

test('来源标签覆盖 config.json 里所有启用的源', () => {
  const app = read('docs/app.js');
  const labels = app.match(/SOURCE_LABELS = \{([^}]+)\}/)?.[1] ?? '';
  const config = JSON.parse(read('config.json'));

  for (const name of Object.keys(config.sources)) {
    assert.match(labels, new RegExp(`\\b${name}\\b`), `SOURCE_LABELS 缺 ${name}`);
  }
});

test('页面语言与 view 语义一致：归档视图出全部历史', () => {
  assert.match(read('docs/archive.html'), /data-view="archive"/);
  assert.match(read('docs/index.html'), /data-view="recent"/);
});

test('已提交的 feed.json 结构正确（防止把坏数据提交上去）', (t) => {
  if (!existsSync(new URL('../docs/feed.json', import.meta.url))) {
    t.skip('feed.json 尚未生成');
    return;
  }
  const feed = JSON.parse(read('docs/feed.json'));

  assert.ok(Array.isArray(feed.jobs));
  assert.ok(feed.meta && typeof feed.meta.complete === 'boolean');
  assert.equal(typeof feed.meta.sources, 'object');
  assert.ok(feed.meta.windows, '站点算 7 天窗口要靠 feed.meta.windows');
  assert.ok(feed.meta.tracks, '筛选按钮靠 feed.meta.tracks 驱动');

  for (const job of feed.jobs) {
    for (const key of ['id', 'source', 'tracks', 'title', 'url', 'firstSeenAt']) {
      assert.ok(job[key] !== undefined, `${job.id} 缺字段 ${key}`);
    }
    // 站点用不上的字段不该出现在载荷里
    for (const key of ['fingerprint', 'repostIds', 'lastSeenAt']) {
      assert.equal(job[key], undefined, `${job.id} 不该带 ${key}`);
    }
    assert.ok(Array.isArray(job.tracks) && job.tracks.length > 0, `${job.id} 的 tracks 为空`);
    assert.match(job.url, /^https:\/\//, `${job.id} 的 url 不是 https`);
  }
});
