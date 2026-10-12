// 取数原语：超时 / 重试 / 指数退避 / 限速 / User-Agent。两个源共用。
//
// 重试与退避节奏照抄上游 ai-job-search 的 linkedin-search（500ms 起、翻倍、
// 封顶 8000ms、叠加 0..499ms 抖动），不自行发明 —— 上游有
// retry-backoff.test.ts / request-timeout.test.ts 覆盖这套参数。
//
// 传输层有两个实现，重试策略只有一份：
//   fetch —— Node 自带的 undici，JobsDB 用
//   curl  —— 系统 curl，LinkedIn 用
//
// 为什么 LinkedIn 必须走 curl：LinkedIn 的 jobs-guest 端点对 Node fetch 一律
// 回 HTTP 451 Unavailable For Legal Reasons，换任何 User-Agent / Accept 组合
// 都一样（2026-10-12 实测），而同样的 URL 用 curl 拿 200 —— 是按 TLS 指纹做的
// 机器流量拦截，不是内容协商。curl 不是 npm 依赖，T4「零 npm 依赖」依然成立。

import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** 浏览器式 UA：这些是公开页面，非浏览器 UA 更容易被前置 WAF 拒绝。 */
export const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const DEFAULTS = {
  timeoutMs: 15000,
  retries: 6,
  minIntervalMs: 400,
  backoffStartMs: 500,
  backoffCapMs: 8000,
};

/** 只有这两个状态值得重试：限流与对端故障。其余 4xx 是确定性拒绝。 */
function isRetryable(status) {
  return status === 429 || status >= 500;
}

/** 把调用方的头改写成 Headers，让大小写写法也能真正覆盖默认值。 */
export function buildHeaders(defaultUa, overrides) {
  const headers = new Headers(overrides ?? {});
  if (!headers.has('user-agent')) headers.set('user-agent', defaultUa);
  if (!headers.has('accept-language')) headers.set('accept-language', 'en-US,en;q=0.9');
  return headers;
}

/** 默认传输：Node 自带 fetch。 */
export function createFetchTransport(fetchImpl = (...args) => globalThis.fetch(...args)) {
  return (url, { headers, timeoutMs, redirect }) =>
    fetchImpl(url, {
      method: 'GET',
      headers,
      redirect,
      // 超时不靠对端自觉：fetch 自身没有默认超时
      signal: AbortSignal.timeout(timeoutMs),
    });
}

/** curl 的响应对象做得像 Response，好让上面那套消费逻辑原样复用。 */
function curlResponse(status, body) {
  return {
    status,
    ok: status >= 200 && status < 300,
    statusText: '',
    headers: new Headers(),
    text: async () => body,
  };
}

/**
 * 每次请求一个临时目录，只给 curl 写正文用。
 *
 * 不用 mkdtemp：它要求模板以 6 个 X 结尾，而那种写法在 POSIX 上会被 Node 警告
 * 「not portable」。自己拼 pid + 序号同样不会撞车，还没有警告。
 */
let curlTempSeq = 0;
function defaultTempDir() {
  const dir = join(tmpdir(), `hkj-curl-${process.pid}-${curlTempSeq++}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * curl 传输：绕开 undici 的 TLS 指纹。
 *
 * 正文写进临时文件、状态码走 stdout —— 避免在 stdout 里塞分隔符再切分
 * （正文里万一出现同样的字节就会解析错）。
 *
 * execFile 可注入，测试因此不需要真的起子进程。
 */
export function createCurlTransport({ execFile: exec = execFile, makeTempDir = defaultTempDir } = {}) {
  return (url, { headers, timeoutMs }) =>
    new Promise((resolve, reject) => {
      const dir = makeTempDir();
      const bodyPath = join(dir, 'body');

      const args = [
        '--silent',
        '--show-error',
        '--location',
        '--max-time', String(Math.max(1, Math.ceil(timeoutMs / 1000))),
        '--output', bodyPath,
        '--write-out', '%{http_code}',
      ];
      for (const [name, value] of headers?.entries?.() ?? []) {
        args.push('--header', `${name}: ${value}`);
      }
      args.push(url);

      exec('curl', args, { maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
        let body = '';
        try {
          body = readFileSync(bodyPath, 'utf8');
        } catch {
          body = '';
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }

        if (err) {
          // curl 的非零退出码（28 超时、7 连不上……）：当作网络层失败，
          // 交给上面的重试循环。error.transportFailure 让调用方能分辨。
          const failure = new Error(`curl 退出码 ${err.code ?? '?'}：${String(stderr).trim() || err.message}`);
          failure.transportFailure = true;
          return reject(failure);
        }

        resolve(curlResponse(Number(String(stdout).trim()) || 0, body));
      });
    });
}

/**
 * 造一个带状态的 HTTP 客户端。限速闸门（上一次请求发了多久）是实例级的，
 * 所以同一次扫描里同源请求共享节奏，不会各自打满目标站。
 *
 * sleep / now / random / transport 可注入，测试因此不需要真实时钟与网络。
 */
export function createHttp(options = {}) {
  const cfg = { ...DEFAULTS, ...options };
  const sleep = cfg.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const now = cfg.now ?? (() => Date.now());
  const random = cfg.random ?? Math.random;
  const transport = cfg.transport ?? createFetchTransport(cfg.fetchImpl);

  let lastRequestAt = -Infinity;

  /** 距上次请求不足 minIntervalMs 就先补齐，避免打爆目标站。 */
  async function throttle(minIntervalMs) {
    const waitMs = lastRequestAt + minIntervalMs - now();
    if (waitMs > 0) await sleep(waitMs);
    lastRequestAt = now();
  }

  async function request(url, opts, consume) {
    const timeoutMs = opts.timeoutMs ?? cfg.timeoutMs;
    const retries = opts.retries ?? cfg.retries;
    const minIntervalMs = opts.minIntervalMs ?? cfg.minIntervalMs;

    let backoff = cfg.backoffStartMs;

    for (let attempt = 0; attempt <= retries; attempt++) {
      await throttle(minIntervalMs);

      let res;
      try {
        res = await transport(url, {
          headers: buildHeaders(cfg.userAgent ?? BROWSER_USER_AGENT, opts.headers),
          timeoutMs,
          redirect: opts.redirect ?? 'follow',
        });
      } catch (cause) {
        // 网络层失败（超时、连接重置）与 5xx 同类：值得重试。
        if (attempt === retries) {
          const err = new Error(`${url} 请求失败：${cause?.message ?? cause}`);
          err.attempts = attempt + 1;
          err.cause = cause;
          throw err;
        }
        await sleep(backoff + Math.floor(random() * 500));
        backoff = Math.min(backoff * 2, cfg.backoffCapMs);
        continue;
      }

      if (isRetryable(res.status)) {
        if (attempt === retries) throw httpError(url, res, attempt + 1);
        await sleep(backoff + Math.floor(random() * 500));
        backoff = Math.min(backoff * 2, cfg.backoffCapMs);
        continue;
      }

      // 非重试状态交给 consume 判定：404 对 fetchText 是空串、对 fetchJson 是错误。
      return consume(res, url, attempt + 1);
    }

    throw new Error(`${url} 重试耗尽`); // 不可达：循环必在 retries 处返回或抛出
  }

  /** 取文本。404 视为「该资源不存在」返回空串 —— 上游既定契约。 */
  async function fetchText(url, opts = {}) {
    return request(url, opts, (res, u, attempts) => {
      if (res.status === 404) return '';
      if (!res.ok) throw httpError(u, res, attempts);
      return res.text();
    });
  }

  /**
   * 取 JSON。与 fetchText 的唯一差别：404 抛错。
   * 搜索端点返回 404 意味着端点没了，把它读成「今天没有新岗位」会静默漏掉整个源。
   */
  async function fetchJson(url, opts = {}) {
    return request(url, opts, async (res, u, attempts) => {
      if (!res.ok) throw httpError(u, res, attempts);
      const text = await res.text();
      try {
        return JSON.parse(text);
      } catch {
        const err = new Error(`${u} 返回的不是 JSON：${text.slice(0, 120)}`);
        err.status = res.status;
        throw err;
      }
    });
  }

  return { fetchText, fetchJson };
}

function httpError(url, res, attempts) {
  const err = new Error(`${url} 返回 HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''}`);
  err.status = res.status;
  err.attempts = attempts;
  return err;
}

const defaultHttp = createHttp();

export const fetchText = defaultHttp.fetchText;
export const fetchJson = defaultHttp.fetchJson;
