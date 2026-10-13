// T7 — 入口编排、失败降级、落盘。全部在临时目录里跑，不打网络。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runScan, parseArgs } from '../src/scan.mjs';

const CONFIG = {
  tracks: {
    trainee: { label: 'Trainee Solicitor', searchKeywords: 'trainee solicitor', titlePatterns: ['\\btrainee\\b', 'solicitor'] },
    paralegal: { label: 'Paralegal', searchKeywords: 'paralegal', titlePatterns: ['\\bparalegal\\b'] },
  },
  titleFilter: { requireTrack: true, negative: ['\\bsecretary\\b'] },
  sources: {
    jobsdb: { enabled: true, api: 'https://hk.jobsdb.com/api/jobsearch/v5/search', siteKey: 'HK-Main', pageSize: 100, maxPages: 1 },
    linkedin: { enabled: true, searchUrl: 'https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search', location: 'Hong Kong', pageSize: 10, maxPages: 1 },
  },
  http: {},
  site: { recentDays: 7, newBadgeDays: 7, excerptLength: 300 },
};

const NOW = new Date('2026-10-13T23:47:31Z');

function makeProject(config = CONFIG, seed = {}) {
  const root = mkdtempSync(join(tmpdir(), 'hkj-'));
  writeFileSync(join(root, 'config.json'), JSON.stringify(config, null, 2));
  mkdirSync(join(root, 'data', 'history'), { recursive: true });
  mkdirSync(join(root, 'docs'), { recursive: true });
  for (const [rel, body] of Object.entries(seed)) {
    writeFileSync(join(root, rel), typeof body === 'string' ? body : JSON.stringify(body));
  }
  return root;
}

function job(over = {}) {
  const id = over.id ?? 'jobsdb:1';
  return {
    id,
    source: over.source ?? 'jobsdb',
    title: 'Paralegal',
    company: 'Example & Co',
    location: 'Wan Chai, Wan Chai District',
    salary: null,
    postedAt: '2026-10-10',
    url: over.url ?? `https://hk.jobsdb.com/job/${id.split(':')[1]}`,
    excerpt: null,
    stillListed: true,
    ...over,
  };
}

/** 每个源一个固定返回；传 Error 实例表示该源抛错。 */
function sources({ jobsdb = [], linkedin = [] } = {}) {
  const asFn = (v) => async () => {
    if (v instanceof Error) throw v;
    return v;
  };
  return { jobsdb: asFn(jobsdb), linkedin: asFn(linkedin) };
}

const read = (root, rel) => JSON.parse(readFileSync(join(root, rel), 'utf8'));
const quiet = { error() {}, log() {}, warn() {} };

function scan(root, opts = {}) {
  return runScan({ rootDir: root, now: NOW, log: quiet, http: {}, ...opts });
}

// ------------------------------------------------------------------ 参数

test('parseArgs 认 --dry-run / --silent-new / --no-silent-new', () => {
  assert.deepEqual(parseArgs([]), { dryRun: false, silentNew: undefined, help: false });
  assert.equal(parseArgs(['--dry-run']).dryRun, true);
  assert.equal(parseArgs(['--silent-new']).silentNew, true);
  assert.equal(parseArgs(['--no-silent-new']).silentNew, false);
});

// ------------------------------------------------------------------ 正常路径

test('全部源成功：落盘 jobs.json / history / feed.json，退出码 0', async () => {
  const root = makeProject();
  try {
    const res = await scan(root, { sources: sources({ jobsdb: [job()], linkedin: [job({ id: 'linkedin:9', source: 'linkedin', url: 'https://hk.linkedin.com/jobs/view/9' })] }) });

    assert.equal(res.exitCode, 0);
    assert.equal(res.meta.complete, true);
    assert.deepEqual(res.meta.sources, { jobsdb: 'ok', linkedin: 'ok' });

    const master = read(root, 'data/jobs.json');
    assert.equal(master.length, 2);
    assert.ok(existsSync(join(root, 'data/history/2026-10-13.json')));
    assert.ok(existsSync(join(root, 'docs/feed.json')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('meta 带上本次运行时刻与各源状态', async () => {
  const root = makeProject();
  try {
    const res = await scan(root, { sources: sources({ jobsdb: [job()] }) });
    assert.equal(res.meta.ranAt, NOW.toISOString());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('按关键词分别调用各源（每个 track 一个搜索词）', async () => {
  const root = makeProject();
  try {
    const calls = [];
    const spy = (name) => async (cfg, { keywords }) => { calls.push(`${name}:${keywords}`); return []; };
    await scan(root, { sources: { jobsdb: spy('jobsdb'), linkedin: spy('linkedin') } });

    assert.deepEqual(calls.sort(), ['jobsdb:paralegal', 'jobsdb:trainee solicitor', 'linkedin:paralegal', 'linkedin:trainee solicitor']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------ 标题过滤

test('归属不到 track 的噪声在入库前就被丢掉', async () => {
  const root = makeProject();
  try {
    const res = await scan(root, {
      sources: sources({
        jobsdb: [
          job({ id: 'jobsdb:1', title: 'Paralegal' }),
          job({ id: 'jobsdb:2', title: 'Litigation Clerk' }),
          job({ id: 'jobsdb:3', title: 'Legal Secretary' }),
          job({ id: 'jobsdb:4', title: 'Trainee Solicitor' }),
        ],
      }),
    });

    const master = read(root, 'data/jobs.json');
    assert.deepEqual(master.map((j) => j.title).sort(), ['Paralegal', 'Trainee Solicitor']);
    // 假源每个 track 各被调用一次，所以原始条数是 4 × 2
    assert.equal(res.stats.fetched, 8);
    assert.equal(res.stats.kept, 2, '首轮按 id 去重后只剩归得上 track 的 2 条');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('多头广告两个 track 都打上', async () => {
  const root = makeProject();
  try {
    await scan(root, { sources: sources({ jobsdb: [job({ title: 'Paralegal / Trainee Solicitor' })] }) });
    const [record] = read(root, 'data/jobs.json');
    assert.deepEqual(record.tracks.sort(), ['paralegal', 'trainee']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------ 失败降级

test('一个源失败不中断整体：成功源照常落盘，complete=false，退出码仍为 0', async () => {
  const root = makeProject();
  try {
    const res = await scan(root, {
      sources: sources({ jobsdb: [job()], linkedin: new Error('timeout') }),
    });

    assert.equal(res.exitCode, 0, '部分失败不是整体失败');
    assert.equal(res.meta.complete, false);
    assert.equal(res.meta.sources.jobsdb, 'ok');
    assert.match(res.meta.sources.linkedin, /^failed: /);
    assert.match(res.meta.sources.linkedin, /timeout/);

    const master = read(root, 'data/jobs.json');
    assert.equal(master.length, 1, '成功源的数据照常写入');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('全部源失败：退出码非 0', async () => {
  const root = makeProject();
  try {
    const res = await scan(root, {
      sources: sources({ jobsdb: new Error('boom'), linkedin: new Error('timeout') }),
    });
    assert.notEqual(res.exitCode, 0);
    assert.equal(res.meta.complete, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('源失败不会把它名下的历史记录判为下架', async () => {
  const root = makeProject(CONFIG, {
    'data/jobs.json': [
      { id: 'jobsdb:1', source: 'jobsdb', tracks: ['paralegal'], title: 'Paralegal', company: 'Example & Co', location: 'Wan Chai, Wan Chai District', salary: null, postedAt: '2026-10-01', firstSeenAt: '2026-10-01T00:00:00Z', lastSeenAt: '2026-10-12T00:00:00Z', url: 'https://hk.jobsdb.com/job/1', excerpt: null, stillListed: true },
      { id: 'linkedin:5', source: 'linkedin', tracks: ['paralegal'], title: 'Paralegal', company: 'Example & Co', location: 'Wan Chai, Wan Chai District', salary: null, postedAt: '2026-10-01', firstSeenAt: '2026-10-01T00:00:00Z', lastSeenAt: '2026-10-12T00:00:00Z', url: 'https://hk.linkedin.com/jobs/view/5', excerpt: null, stillListed: true },
    ],
  });
  try {
    await scan(root, { sources: sources({ jobsdb: [], linkedin: new Error('timeout') }) });
    const master = read(root, 'data/jobs.json');

    // jobsdb 跑完且一条没见到 → 下架
    assert.equal(master.find((j) => j.id === 'jobsdb:1').stillListed, false);
    // linkedin 挂了 → 不动
    assert.equal(master.find((j) => j.id === 'linkedin:5').stillListed, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('配置里关闭的源不参与，也不影响 complete', async () => {
  const root = makeProject({ ...CONFIG, sources: { ...CONFIG.sources, linkedin: { ...CONFIG.sources.linkedin, enabled: false } } });
  try {
    const res = await scan(root, { sources: sources({ jobsdb: [job()], linkedin: new Error('不该被调用') }) });
    assert.equal(res.meta.complete, true);
    assert.deepEqual(Object.keys(res.meta.sources), ['jobsdb']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('半程抓取的源不算跑完：complete=false，且没有下架判定权', async () => {
  const root = makeProject(CONFIG, {
    'data/jobs.json': [
      { id: 'jobsdb:stale', source: 'jobsdb', tracks: ['paralegal'], title: 'Paralegal', company: 'X & Co', location: 'Wan Chai', salary: null, postedAt: '2026-10-01', firstSeenAt: '2026-10-01T00:00:00Z', lastSeenAt: '2026-10-12T00:00:00Z', url: 'https://hk.jobsdb.com/job/9', excerpt: null, stillListed: true },
    ],
  });
  try {
    const halfFetched = async (cfg, { onPartial }) => { onPartial('第 2 页失败：boom'); return [job({ id: 'jobsdb:1' })]; };
    const res = await scan(root, { sources: { jobsdb: halfFetched, linkedin: async () => [] } });

    assert.equal(res.meta.complete, false);
    assert.match(res.meta.sources.jobsdb, /^partial: /);
    assert.equal(res.exitCode, 0, '抓了一半不是整体失败');

    const master = read(root, 'data/jobs.json');
    assert.equal(master.find((j) => j.id === 'jobsdb:stale').stillListed, true, '半程结果不能判下架');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------ dry-run

test('--dry-run 不写任何文件', async () => {
  const root = makeProject();
  try {
    const res = await scan(root, { dryRun: true, sources: sources({ jobsdb: [job()] }) });

    assert.equal(res.exitCode, 0);
    assert.ok(!existsSync(join(root, 'data/jobs.json')));
    assert.ok(!existsSync(join(root, 'docs/feed.json')));
    assert.ok(!existsSync(join(root, 'data/history/2026-10-13.json')));
    assert.equal(res.stats.kept, 1, '统计照常输出');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------ 静默期

test('首次运行（主库为空）自动进入静默期：入库但不点亮 NEW', async () => {
  const root = makeProject();
  try {
    const res = await scan(root, { sources: sources({ jobsdb: [job()] }) });

    assert.equal(res.silentNew, true, '主库为空 → 自动静默');
    const [record] = read(root, 'data/jobs.json');
    assert.equal(record.suppressNew, true);
    assert.equal(record.firstSeenAt, NOW.toISOString(), '时间照记，只是不打徽章');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('主库非空时不再静默，新岗位正常点亮 NEW', async () => {
  const root = makeProject(CONFIG, {
    'data/jobs.json': [job({ id: 'jobsdb:old', firstSeenAt: '2026-09-01T00:00:00Z', postedAt: '2026-09-01' })],
  });
  try {
    const res = await scan(root, {
      sources: sources({
        jobsdb: [
          job({ id: 'jobsdb:old', postedAt: '2026-09-01' }),
          // 换公司才是真正的新岗位；同名同公司会被指纹认成 repost（见 dedupe 测试）
          job({ id: 'jobsdb:new', company: 'Another Firm' }),
        ],
      }),
    });

    assert.equal(res.silentNew, false);
    const fresh = read(root, 'data/jobs.json').find((j) => j.id === 'jobsdb:new');
    assert.equal(fresh.suppressNew, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('--no-silent-new 可在首次运行时强制点亮', async () => {
  const root = makeProject();
  try {
    const res = await scan(root, { silentNew: false, sources: sources({ jobsdb: [job()] }) });
    assert.equal(res.silentNew, false);
    assert.equal(read(root, 'data/jobs.json')[0].suppressNew, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------ 增量与主库

test('第二次运行不重写 firstSeenAt', async () => {
  const root = makeProject();
  try {
    await scan(root, { sources: sources({ jobsdb: [job()] }) });
    const first = read(root, 'data/jobs.json')[0].firstSeenAt;

    const later = new Date('2026-10-14T23:47:31Z');
    await scan(root, { now: later, sources: sources({ jobsdb: [job()] }) });

    const [record] = read(root, 'data/jobs.json');
    assert.equal(record.firstSeenAt, first);
    assert.equal(record.lastSeenAt, later.toISOString());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('history 只记当天新增，同日二次运行合并而非覆盖', async () => {
  const root = makeProject();
  try {
    await scan(root, { sources: sources({ jobsdb: [job({ id: 'jobsdb:1' })] }) });
    await scan(root, {
      sources: sources({ jobsdb: [job({ id: 'jobsdb:1' }), job({ id: 'jobsdb:2', company: 'Another Firm' })] }),
    });

    const history = read(root, 'data/history/2026-10-13.json');
    assert.deepEqual(history.map((j) => j.id).sort(), ['jobsdb:1', 'jobsdb:2']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------ 站点载荷

test('feed.json 裁剪掉站点不用的字段，并带上 meta', async () => {
  const root = makeProject();
  try {
    await scan(root, { sources: sources({ jobsdb: [job()] }) });
    const feed = read(root, 'docs/feed.json');

    const [record] = feed.jobs;
    assert.equal(record.fingerprint, undefined);
    assert.equal(record.lastSeenAt, undefined);
    assert.equal(record.repostIds, undefined);
    // 站点要用的字段都在
    for (const key of ['id', 'source', 'tracks', 'title', 'company', 'location', 'salary', 'postedAt', 'firstSeenAt', 'url', 'excerpt', 'description', 'stillListed']) {
      assert.ok(key in record, `feed 缺字段 ${key}`);
    }

    assert.equal(feed.meta.complete, true);
    assert.equal(feed.meta.ranAt, NOW.toISOString());
    assert.equal(feed.jobs.length, 1);
    // 站点算 7 天窗口与来源显示名都靠 meta 带过去，不是前端写死的
    assert.equal(feed.meta.windows.recentDays, 7);
    assert.deepEqual(feed.meta.sourceLabels, { jobsdb: 'jobsdb', linkedin: 'linkedin' });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('feed.json 里 complete=false 会被带到站点', async () => {
  const root = makeProject();
  try {
    await scan(root, { sources: sources({ jobsdb: [job()], linkedin: new Error('timeout') }) });
    const feed = read(root, 'docs/feed.json');
    assert.equal(feed.meta.complete, false);
    assert.match(feed.meta.sources.linkedin, /timeout/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('统计按 track 计数', async () => {
  const root = makeProject();
  try {
    const res = await scan(root, {
      sources: sources({ jobsdb: [job({ id: 'jobsdb:1', title: 'Paralegal' }), job({ id: 'jobsdb:2', title: 'Trainee Solicitor' }), job({ id: 'jobsdb:3', title: 'Paralegal / Trainee Solicitor' })] }),
    });
    assert.equal(res.stats.byTrack.paralegal, 2);
    assert.equal(res.stats.byTrack.trainee, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------ JD 全文补全

const FULL = `这是一段足够长的职位正文，用来越过「太短就是解析失败」的下限。${'补充说明。'.repeat(20)}`;

/** 一个源：搜索返回固定列表，详情按 id 脚本化作答。 */
function withDescriptions(search, byId) {
  return {
    search: async () => search,
    description: async (listing) => {
      const v = byId[listing.id];
      if (v instanceof Error) throw v;
      return v ?? null;
    },
  };
}

test('新职位会去取全文，并写进主库与 feed.json', async () => {
  const root = makeProject();
  try {
    await scan(root, {
      sources: {
        jobsdb: withDescriptions([job({ id: 'jobsdb:1' })], { 'jobsdb:1': FULL }),
        linkedin: { search: async () => [], description: async () => null },
      },
    });

    const [record] = read(root, 'data/jobs.json');
    assert.equal(record.description, FULL);

    const [feedJob] = read(root, 'docs/feed.json').jobs;
    assert.equal(feedJob.description, FULL, '摘要之外，全文也要进站点载荷（搜索要用）');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('已经有全文的职位不再重复抓 —— 请求量不随主库增长', async () => {
  const root = makeProject(CONFIG, {
    'data/jobs.json': [job({ id: 'jobsdb:1', description: '上次抓到的全文', firstSeenAt: '2026-10-01T00:00:00Z' })],
  });
  try {
    const asked = [];
    await scan(root, {
      sources: {
        jobsdb: {
          search: async () => [job({ id: 'jobsdb:1' })],
          description: async (l) => { asked.push(l.id); return FULL; },
        },
        linkedin: { search: async () => [], description: async () => null },
      },
    });

    assert.deepEqual(asked, [], '主库里已有全文 → 一条详情请求都不该发');
    assert.equal(read(root, 'data/jobs.json')[0].description, '上次抓到的全文');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('主库里没全文的旧职位会被补上', async () => {
  const root = makeProject(CONFIG, {
    'data/jobs.json': [job({ id: 'jobsdb:1', description: null, firstSeenAt: '2026-10-01T00:00:00Z' })],
  });
  try {
    await scan(root, {
      sources: {
        jobsdb: withDescriptions([job({ id: 'jobsdb:1' })], { 'jobsdb:1': FULL }),
        linkedin: { search: async () => [], description: async () => null },
      },
    });
    assert.equal(read(root, 'data/jobs.json')[0].description, FULL);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('取全文失败只是降级：抓取照常成功，源状态仍是 ok', async () => {
  const root = makeProject();
  try {
    const res = await scan(root, {
      sources: {
        jobsdb: withDescriptions([job({ id: 'jobsdb:1' })], { 'jobsdb:1': new Error('boom') }),
        linkedin: { search: async () => [], description: async () => null },
      },
    });

    assert.equal(res.exitCode, 0);
    assert.equal(res.meta.complete, true, '详情挂了不算源挂了 —— 列表数据是完整的');
    assert.equal(res.meta.sources.jobsdb, 'ok');
    assert.equal(res.meta.descriptions.failed, 1);

    const [record] = read(root, 'data/jobs.json');
    assert.equal(record.description ?? null, null, '没有全文就是 null，不编一段出来');
    assert.equal(read(root, 'data/jobs.json').length, 1, '职位本身照常入库');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('403 立刻短路：同源后续职位不再逐条送死', async () => {
  const root = makeProject();
  try {
    const asked = [];
    const jobs = Array.from({ length: 5 }, (_, i) => job({ id: `jobsdb:${i}`, title: `Paralegal ${i}` }));
    const res = await scan(root, {
      sources: {
        jobsdb: {
          search: async () => jobs,
          description: async (l) => {
            asked.push(l.id);
            const err = new Error('Cloudflare');
            err.status = 403;
            throw err;
          },
        },
        linkedin: { search: async () => [], description: async () => null },
      },
    });

    assert.equal(asked.length, 1, '第一条撞上 403 之后就停手');
    assert.deepEqual(res.meta.descriptions.blocked, ['jobsdb']);
    assert.equal(res.meta.descriptions.skipped, 4);
    assert.equal(res.meta.complete, true, '被拦的是详情页，列表数据仍然完整');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('连续的成功/失败在 meta 里如实记账', async () => {
  const root = makeProject();
  try {
    const res = await scan(root, {
      sources: {
        jobsdb: withDescriptions(
          [job({ id: 'jobsdb:1', title: 'Paralegal A' }), job({ id: 'jobsdb:2', title: 'Paralegal B' })],
          { 'jobsdb:1': FULL, 'jobsdb:2': null },
        ),
        linkedin: { search: async () => [], description: async () => null },
      },
    });

    assert.deepEqual(res.meta.descriptions, { fetched: 1, skipped: 1, failed: 0, blocked: [] });
    assert.equal(res.stats.described, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('注入裸函数形式的源时不会去取全文（测试因此不会意外打网络）', async () => {
  const root = makeProject();
  try {
    const res = await scan(root, { sources: sources({ jobsdb: [job()] }) });
    assert.deepEqual(res.meta.descriptions, { fetched: 0, skipped: 0, failed: 0, blocked: [] });
    assert.equal(read(root, 'data/jobs.json')[0].description, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('descriptionLength 来自 site 配置并传下去', async () => {
  const root = makeProject({ ...CONFIG, site: { ...CONFIG.site, descriptionLength: 1234 } });
  try {
    let seen = null;
    await scan(root, {
      sources: {
        jobsdb: {
          search: async () => [job()],
          description: async (l, opts) => { seen = opts.descriptionLength; return FULL; },
        },
        linkedin: { search: async () => [], description: async () => null },
      },
    });
    assert.equal(seen, 1234);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('抓到全文时给没有摘要的源补一条摘要（LinkedIn 的卡片本来是空白的）', async () => {
  const root = makeProject();
  try {
    const long = FULL.repeat(5); // 越过 excerptLength，摘要才会真的被截断
    await scan(root, {
      sources: {
        jobsdb: withDescriptions([], {}),
        linkedin: withDescriptions(
          [job({ id: 'linkedin:1', source: 'linkedin', url: 'https://hk.linkedin.com/jobs/view/1', excerpt: null })],
          { 'linkedin:1': long },
        ),
      },
    });

    const [record] = read(root, 'data/jobs.json');
    assert.equal(record.description, long);
    assert.equal(record.excerpt.length, 301, 'excerptLength=300 + 省略号');
    assert.ok(long.startsWith(record.excerpt.slice(0, 300)), '摘要取自全文开头');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('源自带摘要时不覆盖它（JobsDB 的 teaser 比正文开头更贴题）', async () => {
  const root = makeProject();
  try {
    await scan(root, {
      sources: {
        jobsdb: withDescriptions([job({ id: 'jobsdb:1', excerpt: '来源自带的 teaser' })], { 'jobsdb:1': FULL }),
        linkedin: withDescriptions([], {}),
      },
    });
    assert.equal(read(root, 'data/jobs.json')[0].excerpt, '来源自带的 teaser');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
