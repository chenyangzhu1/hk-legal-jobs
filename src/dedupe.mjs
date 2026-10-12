// T6 — 两层去重与累积主库。本项目最容易出错的部分。
//
// 两层的分工（SPEC §6.3）：
//   1. 按 id —— 跨关键词、跨页的重复。id 一定是精确的。
//   2. 按 fingerprint —— JobsDB 上同一岗位 repost 会拿到新 job id，
//      中介也会重复发同一岗位。指纹用「公司 + 归一化标题 + 地点」识别它。
//
// 指纹命中时保留首次的 firstSeenAt，不重新点亮 NEW 徽章 —— 一个半年前的岗位
// repost 后 postedAt 看起来是新的，用 postedAt 判新旧会持续产生假 NEW。

import { createHash } from 'node:crypto';

const DAY_MS = 24 * 60 * 60 * 1000;

/** 多头广告的分隔符；两侧的头是同一条 Listing 的并列说法，顺序无意义。 */
const HEAD_SEPARATORS = /[/|｜、·\r\n]+/;

/** 只保留字母、数字、空白（含中文）—— 标点差异不该改变指纹。 */
const PUNCTUATION = /[^\p{L}\p{N}\s]/gu;

function fold(value) {
  // NFKC 把全角字母/数字折成半角；大小写单独处理
  return String(value ?? '').normalize('NFKC').toLowerCase();
}

function squeeze(value) {
  return value.replace(PUNCTUATION, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * 轻量去复数：只砍长度 > 3 且非 -ss 结尾的尾随 s。
 * 目的是让 "Trainee Solicitors" 与 "Trainee Solicitor" 指纹相同（同一岗位的
 * 常见 repost 变体），同时不碰 "funds" 之外的短词。
 */
function stripPlural(token) {
  if (token.length > 3 && token.endsWith('s') && !token.endsWith('ss')) return token.slice(0, -1);
  return token;
}

function normalizeTokens(text) {
  return squeeze(fold(text))
    .split(' ')
    .filter(Boolean)
    .map(stripPlural);
}

/**
 * 标题归一化：大小写、全角/半角、标点、多余空格、单复数都不影响结果；
 * `/` 分隔的多头广告按头排序，因此 "Paralegal / Trainee Solicitor" 与
 * "Trainee Solicitor/Paralegal" 归一化到同一个串。
 */
export function normalizeTitle(title) {
  const heads = fold(title)
    .split(HEAD_SEPARATORS)
    .map((head) => normalizeTokens(head).join(' '))
    .filter(Boolean);

  return [...new Set(heads)].sort().join('|');
}

/**
 * 公司名归一化：只做大小写与标点。
 *
 * 刻意**不**消除 "Co" / "Company" / "Ltd" / "LLP" 之类的后缀 —— 两家不同的所
 * 名字相近时，误合会让一条真实岗位消失，比少识别一次 repost 更糟。
 */
export function normalizeCompany(company) {
  return squeeze(fold(company));
}

export function normalizeLocation(location) {
  return squeeze(fold(location));
}

/** 指纹 = sha1(公司 | 归一化标题 | 地点)。 */
export function fingerprintOf(record) {
  const basis = [
    normalizeCompany(record?.company),
    normalizeTitle(record?.title),
    normalizeLocation(record?.location),
  ].join('|');
  return createHash('sha1').update(basis).digest('hex');
}

function toDate(value) {
  return value instanceof Date ? value : new Date(value);
}

/** NEW = 首次被本系统见到落在最近 `days` 天内。静默期入库的记录永不点亮。 */
export function isNew(record, now, days = 7) {
  if (!record || record.suppressNew === true) return false;
  const seen = Date.parse(record?.firstSeenAt ?? '');
  if (Number.isNaN(seen)) return false;
  return toDate(now).getTime() - seen <= days * DAY_MS;
}

/** 'YYYY-MM-DD' 字符串，直接按字典序比大小即为时间序。 */
function newestDate(a, b) {
  if (!a) return b ?? null;
  if (!b) return a;
  return a >= b ? a : b;
}

function keyOf(source, fingerprint) {
  // 指纹按源隔离：不同来源的同名岗位是两条 Listing，各自保留各自的 URL。
  // 跨源合并会丢掉一个可点的原始职位页，代价大于收益。
  return `${source ?? ''}::${fingerprint}`;
}

function unionTracks(existing, incoming) {
  const out = [...(existing ?? [])];
  for (const t of incoming ?? []) if (!out.includes(t)) out.push(t);
  return out;
}

function mergeInto(target, incoming, nowIso) {
  target.lastSeenAt = nowIso;
  target.stillListed = true;
  target.tracks = unionTracks(target.tracks, incoming.tracks);
  target.postedAt = newestDate(target.postedAt, incoming.postedAt);

  // 只在原有字段空着时补，不用入参的 null 覆盖已有值
  if (!target.company && incoming.company) target.company = incoming.company;
  if (!target.location && incoming.location) target.location = incoming.location;
  if (!target.salary && incoming.salary) target.salary = incoming.salary;
  if (!target.excerpt && incoming.excerpt) target.excerpt = incoming.excerpt;

  // 新的 id 追加到该记录（SPEC §6.3）；canonical id / url 不变
  if (incoming.id && incoming.id !== target.id) {
    target.repostIds = target.repostIds ?? [];
    if (!target.repostIds.includes(incoming.id)) target.repostIds.push(incoming.id);
  }
}

function createRecord(incoming, fingerprint, nowIso, silentNew) {
  const record = {
    id: incoming.id,
    source: incoming.source,
    tracks: [...(incoming.tracks ?? [])],
    title: incoming.title,
    company: incoming.company ?? null,
    location: incoming.location ?? null,
    salary: incoming.salary ?? null,
    postedAt: incoming.postedAt ?? null,
    firstSeenAt: nowIso,
    lastSeenAt: nowIso,
    url: incoming.url,
    excerpt: incoming.excerpt ?? null,
    fingerprint,
    stillListed: true,
  };
  // 静默期：时间照记（字段语义不撒谎），只是不打 NEW 徽章
  if (silentNew) record.suppressNew = true;
  return record;
}

/**
 * 把本次扫描结果 upsert 进累积主库。
 *
 * @param {object[]} master 现有主库（data/jobs.json）
 * @param {object[]} incoming 本次扫描到、已归好 track 的职位
 * @param {object} opts
 * @param {Date|string} opts.now 本次运行时刻
 * @param {boolean} [opts.silentNew] 静默期：入库但不点亮 NEW
 * @param {Set<string>} [opts.completeSources] 本次真正跑完的源。
 *   **只有跑完的源才参与「下架」判定** —— 源失败时把它的岗位全标成下架，
 *   等于静默地少显示数据，正是失败降级要避免的事。
 * @returns {{jobs: object[], added: object[], updated: object[], delisted: object[]}}
 */
export function upsert(master = [], incoming = [], opts = {}) {
  const nowIso = toDate(opts.now ?? Date.now()).toISOString();
  const silentNew = opts.silentNew === true;
  // 默认 = 本次有产出的源，这是最保守的取值
  const completeSources = opts.completeSources ?? new Set(incoming.map((j) => j.source));

  const jobs = master.map((record) => structuredClone(record));

  const byKey = new Map();
  const byId = new Map();
  for (const record of jobs) {
    // 每次运行重算指纹：它本就是 (company, title, location) 的纯函数，
    // 归一化规则演进时老数据自动自愈，不会因为指纹过期而重复入库。
    record.fingerprint = fingerprintOf(record);
    byKey.set(keyOf(record.source, record.fingerprint), record);
    byId.set(record.id, record);
    for (const alias of record.repostIds ?? []) byId.set(alias, record);
  }

  const touched = new Set();
  const added = [];
  const updated = new Set();

  for (const item of incoming) {
    if (!item?.id) continue;
    const fingerprint = fingerprintOf(item);
    const key = keyOf(item.source, fingerprint);

    const hit = byId.get(item.id) ?? byKey.get(key);
    if (hit) {
      mergeInto(hit, item, nowIso);
      touched.add(hit);
      // 同一条 Listing 改了标题后被 repost：把新指纹也指向它，
      // 否则下一次 repost 会认不出来，凭空多出一条记录。
      if (!byKey.has(key)) byKey.set(key, hit);
      continue;
    }

    const record = createRecord(item, fingerprint, nowIso, silentNew);
    jobs.push(record);
    byKey.set(key, record);
    byId.set(record.id, record);
    touched.add(record);
    added.push(record);
  }

  // 一条都没见到的记录置为下架，但**保留不删** —— 历史页需要它
  const delisted = [];
  for (const record of jobs) {
    if (touched.has(record)) continue;
    if (!completeSources.has(record.source)) continue;
    if (record.stillListed === false) continue;
    record.stillListed = false;
    delisted.push(record);
  }

  for (const record of jobs) {
    if (touched.has(record) && !added.includes(record)) updated.add(record);
  }

  return { jobs, added, updated: [...updated], delisted };
}
