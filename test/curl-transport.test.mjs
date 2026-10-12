// curl 传输层。子进程被替换成假的，所以不打网络、不起真进程。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, existsSync } from 'node:fs';

import { createHttp, createCurlTransport, createFetchTransport } from '../src/http.mjs';

/**
 * 假 execFile：按脚本把正文写进 --output 指定的文件（真 curl 就是这么干的），
 * 状态码从 stdout 返回。记录收到的参数，便于断言请求头确实传下去了。
 */
function fakeExec({ status = 200, body = '', exitCode = 0, stderr = '' } = {}) {
  const calls = [];
  const exec = (cmd, args, opts, cb) => {
    calls.push({ cmd, args });
    const outIdx = args.indexOf('--output');
    if (outIdx >= 0 && exitCode === 0) writeFileSync(args[outIdx + 1], body);
    queueMicrotask(() =>
      cb(exitCode ? Object.assign(new Error('curl failed'), { code: exitCode }) : null, String(status), stderr),
    );
  };
  return { exec, calls };
}

/** sleep 立即返回但推进时钟，否则限速闸门每次都会再补 400ms。 */
function advancingClock() {
  let t = 1_000_000;
  const slept = [];
  return { slept, sleep: async (ms) => { slept.push(ms); t += ms; }, now: () => t };
}

const clock = () => ({ sleep: async () => {}, now: () => 1_000_000 });

function clientWith(script, extra = {}) {
  const { exec, calls } = fakeExec(script);
  const http = createHttp({
    ...clock(),
    ...extra,
    transport: createCurlTransport({ execFile: exec }),
  });
  return { http, calls };
}

test('curl 传输取到正文，状态码从 stdout 解析', async () => {
  const { http } = clientWith({ status: 200, body: '<li>职位卡片</li>' });
  assert.equal(await http.fetchText('https://www.linkedin.com/x'), '<li>职位卡片</li>');
});

test('非 2xx 抛错并带上 status', async () => {
  const { http } = clientWith({ status: 451, body: '' });
  const err = await http.fetchText('https://www.linkedin.com/x').then(() => null, (e) => e);
  assert.equal(err.status, 451);
  assert.match(err.message, /451/);
});

test('429 走同一套退避重试', async () => {
  const { exec, calls } = fakeExec({ status: 429 });
  const { slept, ...clockFns } = advancingClock();
  const http = createHttp({
    ...clockFns,
    random: () => 0,
    transport: createCurlTransport({ execFile: exec }),
  });

  await assert.rejects(() => http.fetchText('https://www.linkedin.com/x'), /429/);
  assert.equal(calls.length, 7, '初次 + 6 次重试');
  assert.deepEqual(slept, [500, 1000, 2000, 4000, 8000, 8000]);
});

test('curl 自身失败（如超时 28）当作网络层错误并可重试', async () => {
  const { exec, calls } = fakeExec({ exitCode: 28, stderr: 'Operation timed out' });
  const http = createHttp({
    sleep: async () => {},
    now: () => 1_000_000,
    retries: 2,
    transport: createCurlTransport({ execFile: exec }),
  });

  await assert.rejects(() => http.fetchText('https://www.linkedin.com/x'), /curl 退出码 28/);
  assert.equal(calls.length, 3, '重试到上限');
});

test('404 返回空串（与 fetch 传输契约一致）', async () => {
  const { http } = clientWith({ status: 404 });
  assert.equal(await http.fetchText('https://www.linkedin.com/x'), '');
});

test('请求头以 --header 传给 curl，且带浏览器 UA', async () => {
  const { http, calls } = clientWith({ status: 200, body: 'ok' });
  await http.fetchText('https://www.linkedin.com/x', { headers: { 'X-Requested-With': 'XMLHttpRequest' } });

  const { args } = calls[0];
  assert.equal(calls[0].cmd, 'curl');
  assert.ok(args.includes('--header'));
  const headers = args.filter((_, i) => args[i - 1] === '--header');
  assert.ok(headers.some((h) => /^x-requested-with: XMLHttpRequest$/i.test(h)));
  assert.ok(headers.some((h) => /^user-agent: Mozilla\/5\.0/.test(h)));
});

test('超时按秒传给 curl --max-time', async () => {
  const { http, calls } = clientWith({ status: 200, body: 'ok' }, { timeoutMs: 15_000 });
  await http.fetchText('https://www.linkedin.com/x');
  const { args } = calls[0];
  assert.equal(args[args.indexOf('--max-time') + 1], '15');
});

test('正文里出现任何字节都不会被误当成状态码分隔符', async () => {
  // 正文含 "200"、"__STATUS__"、换行 —— 正文走临时文件，所以不可能串味
  const nasty = '__STATUS__200\n200\n{"http_code":200}\n';
  const { http } = clientWith({ status: 200, body: nasty });
  assert.equal(await http.fetchText('https://www.linkedin.com/x'), nasty);
});

test('URL 放在参数末尾，前面的都是选项', async () => {
  const { http, calls } = clientWith({ status: 200, body: 'ok' });
  await http.fetchText('https://www.linkedin.com/jobs-guest/x?keywords=paralegal');
  const { args } = calls[0];
  assert.equal(args.at(-1), 'https://www.linkedin.com/jobs-guest/x?keywords=paralegal');
});

test('临时目录用完即删', async () => {
  const { http, calls } = clientWith({ status: 200, body: 'ok' });
  await http.fetchText('https://www.linkedin.com/x');

  const bodyPath = calls[0].args[calls[0].args.indexOf('--output') + 1];
  assert.equal(existsSync(bodyPath), false, '临时正文文件应已清理');
});

test('两个传输都能装配进同一个 createHttp（重试策略只有一份）', () => {
  assert.equal(typeof createFetchTransport(), 'function');
  assert.equal(typeof createCurlTransport(), 'function');
});
