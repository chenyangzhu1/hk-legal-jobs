#!/usr/bin/env node
// T7 — 入口编排：读 config → 依次调用各源 → 分类 → 去重 → 落盘。
//
// 失败降级是这一层的核心职责（SPEC §7.3）：一个源失败不应导致整体失败。
// 成功源的结果照常提交，并在 meta 里如实记录哪个源没跑成。
//
//   node src/scan.mjs                 正常抓取并写盘
//   node src/scan.mjs --dry-run       只看统计，不写盘
//   node src/scan.mjs --silent-new    首次运行静默期：入库但不点亮 NEW
//   node src/scan.mjs --no-silent-new 强制关闭静默期

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createHttp, createCurlTransport } from './http.mjs';
import { createClassifier } from './tracks.mjs';
import { upsert } from './dedupe.mjs';
import { oneLine } from './text.mjs';
import { fetchJobsdb, fetchDescription as fetchJobsdbDescription } from './sources/jobsdb.mjs';
import { fetchLinkedin, fetchDescription as fetchLinkedinDescription } from './sources/linkedin.mjs';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 每个源两件事：搜索列表，以及按需取单条的 JD 全文。 */
const DEFAULT_SOURCES = {
  jobsdb: { search: fetchJobsdb, description: fetchJobsdbDescription },
  linkedin: { search: fetchLinkedin, description: fetchLinkedinDescription },
};

/** 站点载荷只带页面用得上的字段（feed.json 由主库派生，见 SPEC §6.4）。 */
const FEED_FIELDS = [
  'id', 'source', 'tracks', 'title', 'company', 'location',
  'salary', 'postedAt', 'firstSeenAt', 'url', 'excerpt', 'description',
  'stillListed', 'suppressNew',
];

/** 详情页被按机器人挡掉时的状态码：403（Cloudflare 挑战）、451（法律原因）。 */
const BOT_BLOCKED = new Set([403, 451]);

/**
 * 源状态是 `ok` / `partial: <原因>` / `failed: <原因>` 三种之一。
 * 判定「跑完了没」只看前缀 —— 之前这个解析散在三处，加一种状态就容易漏改。
 */
function statusKind(status) {
  return String(status ?? '').split(':')[0].trim();
}

export function parseArgs(argv = []) {
  const args = { dryRun: false, silentNew: undefined, help: false };
  for (const flag of argv) {
    if (flag === '--dry-run') args.dryRun = true;
    else if (flag === '--silent-new') args.silentNew = true;
    else if (flag === '--no-silent-new') args.silentNew = false;
    else if (flag === '--help' || flag === '-h') args.help = true;
  }
  return args;
}

function toDate(value) {
  return value instanceof Date ? value : new Date(value);
}

/**
 * 读 JSON。文件损坏时抛错而不是当作空库 —— 静默从零开始会把整库当成
 * 新职位重新点亮 NEW，那是最坏的一种「看起来正常」。
 */
function readJson(path) {
  if (!existsSync(path)) return undefined;
  const text = readFileSync(path, 'utf8');
  if (!text.trim()) return undefined;
  try {
    return JSON.parse(text);
  } catch (cause) {
    throw new Error(`${path} 不是合法 JSON（${cause.message}）—— 拒绝当作空库继续`);
  }
}

/** 稳定的排序：发布日期倒序 → 首次见到倒序 → id。让每日 diff 干净可读。 */
function sortJobs(jobs) {
  return [...jobs].sort((a, b) => {
    if (a.postedAt !== b.postedAt) return (b.postedAt ?? '') < (a.postedAt ?? '') ? -1 : 1;
    if (a.firstSeenAt !== b.firstSeenAt) return (b.firstSeenAt ?? '') < (a.firstSeenAt ?? '') ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

function toFeedJob(record) {
  const out = {};
  for (const field of FEED_FIELDS) {
    if (record[field] !== undefined) out[field] = record[field];
  }
  return out;
}

export async function runScan(options = {}) {
  const rootDir = options.rootDir ?? ROOT;
  const now = toDate(options.now ?? new Date());
  const nowIso = now.toISOString();
  const dryRun = options.dryRun === true;
  const log = options.log ?? console;

  const configPath = join(rootDir, 'config.json');
  const config = options.config ?? JSON.parse(readFileSync(configPath, 'utf8'));
  const masterPath = join(rootDir, 'data', 'jobs.json');
  const master = readJson(masterPath) ?? [];
  if (!Array.isArray(master)) throw new Error(`${masterPath} 的顶层不是数组`);

  // 每个源可以有自己的传输层：LinkedIn 必须走 curl（undici 会被 451 挡掉，
  // 见 http.mjs 顶部注释）。options.http 是测试注入，优先于一切。
  const transportOf = (sourceConfig) =>
    sourceConfig?.transport === 'curl' ? createCurlTransport() : undefined;
  const httpCache = new Map();
  const httpFor = (sourceConfig) => {
    if (options.http) return options.http;
    const key = sourceConfig?.transport === 'curl' ? 'curl' : 'fetch';
    if (!httpCache.has(key)) httpCache.set(key, createHttp({ ...(config.http ?? {}), transport: transportOf(sourceConfig) }));
    return httpCache.get(key);
  };
  const registry = { ...DEFAULT_SOURCES, ...(options.sources ?? {}) };
  // 注入一个裸函数等于只接管搜索那一半（测试最常用的写法），详情抓取随之留空
  // —— 这样测试不会因为没提供 description 就意外打到网络。
  const sourceEntry = (name) => {
    const raw = registry[name];
    if (typeof raw === 'function') return { search: raw };
    return raw ?? {};
  };
  const classify = createClassifier(config);

  const enabled = Object.entries(config.sources ?? {}).filter(([, cfg]) => cfg?.enabled !== false);
  if (enabled.length === 0) throw new Error('config.json 里没有任何启用的源');

  const keywords = Object.values(config.tracks ?? {}).map((t) => t.searchKeywords).filter(Boolean);
  const byId = new Map();
  const sourceStatus = {};
  let fetched = 0;

  for (const [name, sourceConfig] of enabled) {
    const { search } = sourceEntry(name);
    if (typeof search !== 'function') {
      sourceStatus[name] = `failed: 没有名为 ${name} 的源实现`;
      continue;
    }

    let partial = null;
    try {
      for (const keyword of keywords) {
        const listings = await search(sourceConfig, {
          keywords: keyword,
          http: httpFor(sourceConfig),
          log,
          onPartial: (reason) => { partial ??= reason; },
          // 摘要在 site 段配置，源自己读不到，由编排层传下去
          excerptLength: config.site?.excerptLength,
        });
        fetched += listings.length;

        // 同一个 id 可能被两个关键词、两页重复拿到；先合并，tracks 取并集
        for (const listing of listings) {
          const verdict = classify(listing.title);
          if (!verdict.keep) continue;
          const existing = byId.get(listing.id);
          if (existing) {
            existing.tracks = [...new Set([...existing.tracks, ...verdict.tracks])];
          } else {
            byId.set(listing.id, { ...listing, tracks: verdict.tracks });
          }
        }
      }
      // 抓了一半的源不算跑完：它没有下架判定权，也不能算 complete
      sourceStatus[name] = partial ? `partial: ${partial}` : 'ok';
    } catch (err) {
      sourceStatus[name] = `failed: ${err?.message ?? err}`;
      log.error(`scan: 源 ${name} 失败（非致命，其余源照常）—— ${err?.message ?? err}`);
    }
  }

  // ---------------------------------------------------------------- 详情补全
  //
  // 搜索接口只给摘要（JobsDB 是 teaser，LinkedIn 干脆什么都没有）。全文要从各自的
  // 职位详情页单独取，所以这里做一趟补全。
  //
  // 三条约束：
  //   1. **只补主库里还没有全文的**。每天新增十几条，而不是把主库整个重抓一遍 ——
  //      请求量不随主库增长，这是 ADR 0001「低频」承诺得以维持的前提。
  //   2. **失败一律降级**。取不到全文只是页面上少一个展开按钮，绝不改变抓取本身的
  //      成败、也不影响下架判定。
  //   3. **403/451 立刻短路**。那是 Cloudflare / 法律拦截，同源后续每一条都必然
  //      一样失败，继续试只是白白把对方惹毛。实测 JobsDB 详情页正是这种情况。
  const descriptionLength = config.site?.descriptionLength ?? 4000;
  const excerptLength = config.site?.excerptLength ?? 300;
  const described = new Set(
    master.filter((record) => record.description).flatMap((record) => [record.id, ...(record.repostIds ?? [])]),
  );
  const detailStats = { fetched: 0, skipped: 0, failed: 0, blocked: [] };

  for (const [name, sourceConfig] of enabled) {
    const { description } = sourceEntry(name);
    if (typeof description !== 'function') continue;

    const targets = [...byId.values()].filter(
      (listing) => listing.source === name && !described.has(listing.id),
    );

    let blocked = false;
    for (const listing of targets) {
      if (blocked) {
        detailStats.skipped += 1;
        continue;
      }
      try {
        const text = await description(listing, {
          http: httpFor(sourceConfig),
          descriptionLength,
          log,
        });
        if (text) {
          listing.description = text;
          // 有的源（LinkedIn）搜索卡片不带任何摘要，卡片上会是一片空白。全文既然
          // 已经在手，就用它开头几句当摘要 —— 比空着强，也让展开按钮有对照物。
          if (!listing.excerpt) listing.excerpt = oneLine(text, excerptLength);
          detailStats.fetched += 1;
        } else {
          detailStats.skipped += 1;
        }
      } catch (err) {
        detailStats.failed += 1;
        if (BOT_BLOCKED.has(err?.status)) {
          blocked = true;
          detailStats.blocked.push(name);
          log.error(`scan: ${name} 详情页被拦截（HTTP ${err.status}），本次不再尝试取全文 —— 该源的行不会有展开按钮`);
        } else {
          log.error(`scan: ${name} 取详情失败（非致命）—— ${err?.message ?? err}`);
        }
      }
    }
  }

  const collected = [...byId.values()];
  const completeSources = new Set(
    Object.entries(sourceStatus).filter(([, status]) => statusKind(status) === 'ok').map(([name]) => name),
  );
  const complete = enabled.every(([name]) => statusKind(sourceStatus[name]) === 'ok');

  // 首次运行主库为空 → 自动进入静默期，否则第一天页面上全是 NEW 徽章
  const silentNew = options.silentNew ?? master.length === 0;
  if (silentNew) log.log('scan: 主库为空，本次按静默期处理（入库但不点亮 NEW）');

  const { jobs, added, updated, delisted } = upsert(master, collected, { now, silentNew, completeSources });

  const stats = {
    fetched,
    kept: collected.length,
    added: added.length,
    updated: updated.length,
    delisted: delisted.length,
    total: jobs.length,
    active: jobs.filter((j) => j.stillListed !== false).length,
    described: detailStats.fetched,
    byTrack: Object.fromEntries(
      Object.keys(config.tracks ?? {}).map((id) => [id, jobs.filter((j) => (j.tracks ?? []).includes(id)).length]),
    ),
  };

  const feed = {
    meta: {
      ranAt: nowIso,
      complete,
      sources: sourceStatus,
      // 站点要按同一套窗口算 NEW 与「最近 7 天」，窗口值从 config 带过去，
      // 免得页面逻辑与入库逻辑各写一个天数而悄悄分叉
      windows: {
        recentDays: config.site?.recentDays ?? 7,
        newBadgeDays: config.site?.newBadgeDays ?? 7,
      },
      // 页面的筛选按钮与来源显示名都由 config 驱动，不在前端写死名单
      tracks: Object.fromEntries(
        Object.entries(config.tracks ?? {}).map(([id, def]) => [id, def?.label ?? id]),
      ),
      sourceLabels: Object.fromEntries(
        Object.entries(config.sources ?? {}).map(([id, def]) => [id, def?.label ?? id]),
      ),
      // 全文补全的战果。某个源被机器人拦截在这里看得见 —— 页面上的表现是
      // 「这个源的行都没有展开按钮」，不写下来就只能靠猜。
      descriptions: {
        fetched: detailStats.fetched,
        skipped: detailStats.skipped,
        failed: detailStats.failed,
        blocked: detailStats.blocked,
      },
    },
    jobs: sortJobs(jobs).map(toFeedJob),
  };

  if (!dryRun) {
    mkdirSync(join(rootDir, 'data', 'history'), { recursive: true });
    mkdirSync(join(rootDir, 'docs'), { recursive: true });

    writeFileSync(masterPath, `${JSON.stringify(sortJobs(jobs), null, 2)}\n`);

    // 当日增量快照：同日重复运行按 id 合并，不覆盖
    if (added.length > 0) {
      const historyPath = join(rootDir, 'data', 'history', `${nowIso.slice(0, 10)}.json`);
      const previous = readJson(historyPath) ?? [];
      const merged = new Map(previous.map((j) => [j.id, j]));
      for (const record of added) merged.set(record.id, record);
      writeFileSync(historyPath, `${JSON.stringify(sortJobs([...merged.values()]), null, 2)}\n`);
    }

    writeFileSync(join(rootDir, 'docs', 'feed.json'), `${JSON.stringify(feed, null, 2)}\n`);
  }

  // 全部源都失败才算整体失败；部分失败退 0，但 complete=false 会被页面显式暴露
  const allFailed = enabled.every(([name]) => statusKind(sourceStatus[name]) === 'failed');

  return { exitCode: allFailed ? 1 : 0, meta: feed.meta, stats, silentNew, dryRun };
}

function printSummary(result, log = console) {
  const { meta, stats } = result;
  log.log(`抓取 ${stats.fetched} 条 → 归属 ${stats.kept} 条 → 新增 ${stats.added} / 更新 ${stats.updated} / 下架 ${stats.delisted}`);
  log.log(`主库 ${stats.total} 条（在列 ${stats.active}）`);
  const d = meta.descriptions ?? {};
  log.log(
    `全文：新增 ${d.fetched ?? 0} / 拿不到 ${d.skipped ?? 0} / 失败 ${d.failed ?? 0}` +
      (d.blocked?.length ? `（${d.blocked.join('、')} 的详情页被拦截）` : ''),
  );
  log.log(`源：${Object.entries(meta.sources).map(([n, s]) => `${n}=${s}`).join('  ')}`);
  if (!meta.complete) log.log('本次数据不完整，站点会显示降级横幅');
  for (const [track, count] of Object.entries(stats.byTrack)) log.log(`  ${track}: ${count}`);
  if (result.dryRun) log.log('--dry-run：未写盘');
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('用法：node src/scan.mjs [--dry-run] [--silent-new|--no-silent-new]');
    process.exit(0);
  }
  runScan(args)
    .then((result) => {
      printSummary(result);
      process.exit(result.exitCode);
    })
    .catch((err) => {
      console.error(`scan 失败：${err?.stack ?? err}`);
      process.exit(1);
    });
}
