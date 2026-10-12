// 分页取数的公共循环：两个源只差「怎么取一页、怎么解析一页」。
//
// 抽出来不是为了少敲几行，而是因为这套语义已经改过一次（加 onPartial 时要同时
// 改两个文件），再放任下去就会分叉 —— 而分叉的后果是「源挂了一半」这件事
// 在两个源上的表现不一样。

/**
 * @param {object} spec
 * @param {string} spec.label 日志前缀
 * @param {number} spec.maxPages 最多翻几页
 * @param {number} spec.pageSize 每页条数（由端点决定，用来判断是否最后一页）
 * @param {number} spec.pageDelayMs 页间限速
 * @param {(page: number) => Promise<{items: object[], rawCount: number}>} spec.fetchPage
 *   取并解析一页。**抛错即视为该页失败**（网络错误与解析错误一视同仁）。
 *   `rawCount` 是端点原始条数，`items` 是能用的记录 —— 两者在 jobsdb 侧会不同
 *   （解析不出来的条目会被丢掉），而「是不是最后一页」必须看原始条数。
 * @param {boolean} [spec.zeroFirstPageThrows] 第 1 页零结果是否算错误。
 *   两个源都为 true：这两个关键词在香港各有数百条结果，第 1 页零结果只可能是
 *   端点变更或被拦。作为「跑完的源」静默返回空，会连带把存量全判成已下架。
 */
export async function fetchPaged(spec) {
  const {
    label,
    maxPages,
    pageSize,
    pageDelayMs,
    fetchPage,
    sleep,
    log = console,
    onPartial,
    zeroFirstPageThrows = false,
    zeroFirstPageMessage,
  } = spec;

  const wait = sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const collected = [];
  const seenIds = new Set();

  for (let page = 1; page <= maxPages; page++) {
    let result;
    try {
      result = await fetchPage(page);
    } catch (err) {
      // 第 1 页失败必须抛出：源挂了返回空数组，会被下游读成「今天没有新职位」
      if (page === 1) throw err;
      log.error(`${label}: 第 ${page} 页失败（非致命，保留已收集的 ${collected.length} 条）—— ${err.message}`);
      // 半程结果没有下架判定权，必须显式告诉调用方
      onPartial?.(`第 ${page} 页失败：${err.message}`);
      break;
    }

    const items = result?.items ?? [];
    const rawCount = result?.rawCount ?? items.length;

    if (items.length === 0) {
      if (page === 1 && zeroFirstPageThrows) {
        throw new Error(zeroFirstPageMessage ?? `${label}: 第 1 页零结果`);
      }
      break;
    }

    for (const item of items) {
      // 跨关键词、跨页的重复先在这里挡一道；主库层的去重是第二道
      if (item?.id && !seenIds.has(item.id)) {
        seenIds.add(item.id);
        collected.push(item);
      }
    }

    // 不满一页 = 最后一页。看 rawCount 而不是 items，否则一页里有几条解析失败
    // 就会被误判成翻到底了，丢掉后面的页。
    if (rawCount < pageSize) break;
    if (page < maxPages && pageDelayMs > 0) await wait(pageDelayMs);
  }

  return collected;
}
