// T5 — 把一条职位映射到 tracks[]（多标签），并执行负面过滤。
//
// 为什么过滤必须抓标题：SEEK 的 v5 搜索是语义匹配，搜 "paralegal" 会返回
// "Litigation Clerk"、"Legal Secretary"、"法务专员" 等大量不含关键词的职位。
// 实测 130 条唯一标题里只有 67 条真正属于这两条 track —— 过滤在这里，
// 不在抓取层。
//
// 匹配语义全部来自 config.json，代码里不写死任何职位关键字。

/**
 * 编译一个 track 的 patterns：全部命中才算归属（AND）。
 * 语义来自 config —— 例如 trainee 要求 "trainee" 与 "solicitor" 同时出现，
 * 这样 "Paralegal Trainee" 只会拿到 paralegal，不会误标成见习律师岗。
 */
function compileAll(patterns, label) {
  return (patterns ?? []).map((p) => {
    try {
      return new RegExp(p, 'i');
    } catch (cause) {
      throw new Error(`config.json 里 ${label} 的正则无法编译（${p}）：${cause.message}`);
    }
  });
}

/**
 * 用 config 造一个分类器。正则只编译一次，扫描几百条职位时复用。
 *
 * @returns {(title: unknown) => {tracks: string[], keep: boolean, reason: string|null}}
 */
export function createClassifier(config) {
  const trackDefs = Object.entries(config?.tracks ?? {}).map(([id, def]) => ({
    id,
    label: `tracks.${id}.titlePatterns`,
    patterns: compileAll(def?.titlePatterns, `tracks.${id}.titlePatterns`),
  }));

  const negative = compileAll(config?.titleFilter?.negative, 'titleFilter.negative');
  const requireTrack = config?.titleFilter?.requireTrack !== false;

  return function classify(rawTitle) {
    const title = typeof rawTitle === 'string' ? rawTitle : '';

    const tracks = trackDefs
      .filter((def) => def.patterns.length > 0 && def.patterns.every((re) => re.test(title)))
      .map((def) => def.id);

    if (!title.trim()) return { tracks, keep: false, reason: 'empty' };

    // 负面词命中即丢弃。注意这条是无条件的：'Paralegal / Legal Secretary'
    // 这类多头广告会被一并丢掉 —— 在港市场这类广告实质是秘书岗。
    // 若哪天想保留它们，把词从 config.json 的 negative 里删掉即可。
    if (negative.some((re) => re.test(title))) return { tracks, keep: false, reason: 'negative' };

    if (tracks.length === 0 && requireTrack) return { tracks, keep: false, reason: 'no-track' };

    return { tracks, keep: true, reason: null };
  };
}
