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
import { fetchJobsdb } from './sources/jobsdb.mjs';
import { fetchLinkedin } from './sources/linkedin.mjs';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const DEFAULT_SOURCES = { jobsdb: fetchJobsdb, linkedin: fetchLinkedin };

/** 站点载荷只带页面用得上的字段（feed.json 由主库派生，见 SPEC §6.4）。 */
const FEED_FIELDS = [
  'id', 'source', 'tracks', 'title', 'company', 'location',
  'salary', 'postedAt', 'firstSeenAt', 'url', 'excerpt', 'stillListed', 'suppressNew',
];

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
 * 新岗位重新点亮 NEW，那是最坏的一种「看起来正常」。
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
  const classify = createClassifier(config);

  const enabled = Object.entries(config.sources ?? {}).filter(([, cfg]) => cfg?.enabled !== false);
  if (enabled.length === 0) throw new Error('config.json 里没有任何启用的源');

  const keywords = Object.values(config.tracks ?? {}).map((t) => t.searchKeywords).filter(Boolean);
  const byId = new Map();
  const sourceStatus = {};
  let fetched = 0;

  for (const [name, sourceConfig] of enabled) {
    const fetchFn = registry[name];
    if (typeof fetchFn !== 'function') {
      sourceStatus[name] = `failed: 没有名为 ${name} 的源实现`;
      continue;
    }

    let partial = null;
    try {
      for (const keyword of keywords) {
        const listings = await fetchFn(sourceConfig, {
          keywords: keyword,
          keyword,
          http: httpFor(sourceConfig),
          log,
          onPartial: (reason) => { partial ??= reason; },
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

  const collected = [...byId.values()];
  const completeSources = new Set(
    Object.entries(sourceStatus).filter(([, status]) => status === 'ok').map(([name]) => name),
  );
  const complete = enabled.every(([name]) => sourceStatus[name] === 'ok');

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
    byTrack: Object.fromEntries(
      Object.keys(config.tracks ?? {}).map((id) => [id, jobs.filter((j) => (j.tracks ?? []).includes(id)).length]),
    ),
  };

  const feed = {
    meta: {
      ranAt: nowIso,
      generatedAt: nowIso,
      complete,
      sources: sourceStatus,
      // 站点要按同一套窗口算 NEW 与「最近 7 天」，窗口值从 config 带过去，
      // 免得页面逻辑与入库逻辑各写一个天数而悄悄分叉
      windows: {
        recentDays: config.site?.recentDays ?? 7,
        newBadgeDays: config.site?.newBadgeDays ?? 7,
      },
      // 页面的筛选按钮由 config 驱动，不在前端写死 track 名单
      tracks: Object.fromEntries(
        Object.entries(config.tracks ?? {}).map(([id, def]) => [id, def?.label ?? id]),
      ),
      counts: {
        total: jobs.length,
        active: jobs.filter((j) => j.stillListed !== false).length,
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
  const allFailed = enabled.every(([name]) => String(sourceStatus[name]).startsWith('failed'));

  return { exitCode: allFailed ? 1 : 0, meta: feed.meta, stats, silentNew, dryRun };
}

function printSummary(result, log = console) {
  const { meta, stats } = result;
  log.log(`抓取 ${stats.fetched} 条 → 归属 ${stats.kept} 条 → 新增 ${stats.added} / 更新 ${stats.updated} / 下架 ${stats.delisted}`);
  log.log(`主库 ${meta.counts.total} 条（在列 ${meta.counts.active}）`);
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
