// T2 — fetch 封装的行为契约。
//
// 全部用 createHttp 注入的 sleep/now/fetchImpl 驱动，不打网络、不依赖真实时钟。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createHttp, BROWSER_USER_AGENT } from '../src/http.mjs';

/** 记录 sleep 请求的假时钟；sleep 立即返回但把时长记账。 */
function fakeClock() {
  const slept = [];
  let t = 1_000_000;
  return {
    slept,
    sleep: async (ms) => { slept.push(ms); t += ms; },
    now: () => t,
  };
}

/** 按脚本依次返回响应；用尽后重复最后一个。 */
function stubFetch(responses) {
  const state = { calls: 0, inits: [], urls: [] };
  return {
    state,
    fetchImpl: async (url, init) => {
      state.urls.push(String(url));
      state.inits.push(init);
      const i = Math.min(state.calls, responses.length - 1);
      state.calls++;
      return responses[i]();
    },
  };
}

const ok = (body) => () => new Response(body, { status: 200 });

test('fetchText 在 429 后退避重试，第二次成功', async () => {
  const clock = fakeClock();
  const { state, fetchImpl } = stubFetch([
    () => new Response('', { status: 429 }),
    ok('<html>ok</html>'),
  ]);
  const { fetchText } = createHttp({ ...clock, fetchImpl, random: () => 0 });

  assert.equal(await fetchText('https://example.com/x'), '<html>ok</html>');
  assert.equal(state.calls, 2);
  assert.ok(clock.slept.length >= 1, '应至少退避一次');
  assert.equal(clock.slept[0], 500, '首次退避 500ms（上游既定节奏）');
});

test('fetchText 在 404 返回空串且不重试', async () => {
  const clock = fakeClock();
  const { state, fetchImpl } = stubFetch([() => new Response('', { status: 404 })]);
  const { fetchText } = createHttp({ ...clock, fetchImpl });

  assert.equal(await fetchText('https://example.com/x'), '');
  assert.equal(state.calls, 1);
  assert.equal(clock.slept.length, 0);
});

test('fetchJson 在 404 抛错且不重试 —— 缺端点不是「没有结果」', async () => {
  const clock = fakeClock();
  const { state, fetchImpl } = stubFetch([() => new Response('', { status: 404 })]);
  const { fetchJson } = createHttp({ ...clock, fetchImpl });

  await assert.rejects(() => fetchJson('https://example.com/x'), /404/);
  assert.equal(state.calls, 1);
});

test('持续 5xx：初次尝试 + 6 次重试后放弃', async () => {
  const clock = fakeClock();
  const { state, fetchImpl } = stubFetch([() => new Response('', { status: 500 })]);
  const { fetchText } = createHttp({ ...clock, fetchImpl, random: () => 0 });

  await assert.rejects(() => fetchText('https://example.com/x'), /500/);
  assert.equal(state.calls, 7);
  // 退避指数增长，封顶 8000
  assert.deepEqual(clock.slept, [500, 1000, 2000, 4000, 8000, 8000]);
});

test('非 429 的 4xx 立即抛错，不重试', async () => {
  const clock = fakeClock();
  const { state, fetchImpl } = stubFetch([() => new Response('', { status: 403 })]);
  const { fetchText } = createHttp({ ...clock, fetchImpl });

  await assert.rejects(() => fetchText('https://example.com/x'), /403/);
  assert.equal(state.calls, 1);
  assert.equal(clock.slept.length, 0);
});

test('抛出的错误带上 status 与 attempts', async () => {
  const clock = fakeClock();
  const { fetchImpl } = stubFetch([() => new Response('', { status: 503 })]);
  const { fetchText } = createHttp({ ...clock, fetchImpl, random: () => 0 });

  const err = await fetchText('https://example.com/x').then(() => null, (e) => e);
  assert.equal(err.status, 503);
  assert.equal(err.attempts, 7);
});

test('请求带 AbortSignal（超时不靠对端自觉）', async () => {
  const clock = fakeClock();
  const { state, fetchImpl } = stubFetch([ok('{}')]);
  const { fetchJson } = createHttp({ ...clock, fetchImpl });

  await fetchJson('https://example.com/x');
  assert.ok(state.inits[0].signal instanceof AbortSignal);
});

test('带浏览器式 User-Agent', async () => {
  const clock = fakeClock();
  const { state, fetchImpl } = stubFetch([ok('{}')]);
  const { fetchJson } = createHttp({ ...clock, fetchImpl });

  await fetchJson('https://example.com/x');
  const headers = new Headers(state.inits[0].headers);
  assert.equal(headers.get('user-agent'), BROWSER_USER_AGENT);
  assert.match(BROWSER_USER_AGENT, /Mozilla\/5\.0/);
});

test('请求间隔有下限：连续两次请求之间会等待', async () => {
  const clock = fakeClock();
  const { fetchImpl } = stubFetch([ok('a'), ok('b')]);
  const { fetchText } = createHttp({ ...clock, fetchImpl, minIntervalMs: 400 });

  await fetchText('https://example.com/1');
  assert.equal(clock.slept.length, 0, '首次请求无需等待');

  await fetchText('https://example.com/2');
  assert.equal(clock.slept.length, 1);
  assert.equal(clock.slept[0], 400);
});

test('调用方可用 headers 覆盖 User-Agent，且不会与默认值拼接成两个', async () => {
  const clock = fakeClock();
  const { state, fetchImpl } = stubFetch([ok('{}')]);
  const { fetchJson } = createHttp({ ...clock, fetchImpl });

  await fetchJson('https://example.com/x', { headers: { 'User-Agent': 'custom/1.0' } });
  const ua = new Headers(state.inits[0].headers).get('user-agent');
  assert.equal(ua, 'custom/1.0');
});

test('每次调用可覆盖 timeoutMs 与 retries', async () => {
  const clock = fakeClock();
  const { state, fetchImpl } = stubFetch([() => new Response('', { status: 500 })]);
  const { fetchText } = createHttp({ ...clock, fetchImpl, retries: 6, random: () => 0 });

  await assert.rejects(() => fetchText('https://example.com/x', { retries: 1 }), /500/);
  assert.equal(state.calls, 2);
});

test('fetchJson 解析 JSON；响应不是 JSON 时抛错而非返回 undefined', async () => {
  const clock = fakeClock();
  const { fetchImpl } = stubFetch([ok('{"data":[1,2]}'), ok('<html>nope</html>')]);
  const { fetchJson } = createHttp({ ...clock, fetchImpl });

  assert.deepEqual(await fetchJson('https://example.com/a'), { data: [1, 2] });
  await assert.rejects(() => fetchJson('https://example.com/b'), /JSON/);
});

test('退避带随机抖动（避免多实例同步重试）', async () => {
  const clock = fakeClock();
  const { fetchImpl } = stubFetch([() => new Response('', { status: 429 }), ok('x')]);
  const { fetchText } = createHttp({ ...clock, fetchImpl, random: () => 0.5 });

  await fetchText('https://example.com/x');
  assert.equal(clock.slept[0], 500 + 250, '500ms 退避 + 0..499ms 抖动');
});
