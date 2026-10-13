// 详情页 HTML → 纯文本。两个源共用同一套规则。
//
// 单独成文件的原因：两个源的**取数**方式完全不同（JobsDB 走 fetch、LinkedIn 走
// curl，端点也不一样），但拿到 HTML 之后的处理是同一件事 —— 解实体、把块级标签
// 折算成换行、限长。分头写迟早会分叉成两套转义规则，而转义写错在页面上是看不
// 出来的：只是少几个字符、多一个 &amp;。
//
// 这里输出的始终是**纯文本**，最终走 textContent。抓来的正文是数据，不是标记。

/** HTML 实体解码。数字实体与常见命名实体；认不出来的原样保留。 */
export function decodeEntities(text) {
  return String(text ?? '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&#[xX]([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    // & 最后解 —— 先解会把 "&amp;lt;" 二次解码成 "<"，那是错的
    .replace(/&amp;/g, '&');
}

/** 去掉全部标签、压成一行。标题、公司名这类单行字段用。 */
export function stripTags(html) {
  return decodeEntities(String(html ?? '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** 这些闭合标签之后要换行 —— 否则整篇 JD 会挤成一行。 */
const BLOCK_END = /<\/(p|div|section|article|li|ul|ol|h[1-6]|blockquote|tr|table)\s*>/gi;

/**
 * 详情正文 → 纯文本，保留段落与列表的换行。
 *
 * `<li>` 折算成 "- " 而不是原样保留标签：页面用 `white-space: pre-wrap` 渲染，
 * 没有符号的裸列表项读起来是一串断句。
 */
export function htmlToText(html) {
  const raw = String(html ?? '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<\/li\s*>/gi, '')
    .replace(BLOCK_END, '\n')
    .replace(/<[^>]*>/g, '');

  return decodeEntities(raw)
    .replace(/\r\n?/g, '\n')
    .replace(/[^\S\n]+/g, ' ') // 行内空白压成一个空格，换行不动
    .replace(/ ?\n ?/g, '\n') // 换行两侧不留空格
    .replace(/\n{3,}/g, '\n\n') // 最多留一个空行
    .trim();
}

/** 折叠成单行并截断。空内容返回 null —— 「没有」与「空串」要能区分。 */
export function oneLine(text, max) {
  return truncate(String(text ?? '').replace(/\s+/g, ' ').trim(), max);
}

/** 截断到 max 字符，只在真的截断时补省略号；max 非法时不截。 */
export function truncate(text, max) {
  const value = String(text ?? '').trim();
  if (!value) return null;
  const limit = Number(max);
  if (!Number.isFinite(limit) || limit <= 0) return value;
  return value.length <= limit ? value : `${value.slice(0, limit)}…`;
}

/**
 * 短于这个长度的「正文」是解析失败，不是正文 —— 抓错块、只拿到标题、撞上登录墙
 * 都会长这样。宁可当作没抓到，也不要把半截噪声当成 JD 写进主库。
 */
export const MIN_DESCRIPTION_LENGTH = 100;

/** 正文的收尾处理：限长 + 长度下限。不合格返回 null。 */
export function usableDescription(text, maxLength) {
  const out = truncate(text, maxLength);
  return out && out.length >= MIN_DESCRIPTION_LENGTH ? out : null;
}
