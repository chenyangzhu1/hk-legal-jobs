// 详情页 HTML → 纯文本。两个源共用，所以单独测。
//
// 这些函数直接决定页面上正文长什么样：转义写错、换行没折算、列表挤成一行，
// 都不会抛错，只是页面悄悄变难看 —— 因此这里逐条钉死。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { decodeEntities, stripTags, htmlToText, oneLine, truncate, usableDescription, MIN_DESCRIPTION_LENGTH } from '../src/text.mjs';

// ---------------------------------------------------------------- 实体解码

test('常见命名实体与数字实体都解出来', () => {
  assert.equal(decodeEntities('a &amp; b'), 'a & b');
  assert.equal(decodeEntities('&lt;div&gt;'), '<div>');
  assert.equal(decodeEntities('it&#39;s &quot;fine&quot;'), "it's \"fine\"");
  assert.equal(decodeEntities('&nbsp;x'), ' x');
  assert.equal(decodeEntities('&#65;&#x42;'), 'AB');
});

test('&amp; 最后解 —— 否则 &amp;lt; 会被二次解码成 <', () => {
  assert.equal(decodeEntities('&amp;lt;'), '&lt;');
});

test('认不出来的实体原样保留，不吃掉内容', () => {
  assert.equal(decodeEntities('R&amp;D &euro;5'), 'R&D &euro;5');
});

// ---------------------------------------------------------------- 单行字段

test('stripTags 去标签并把整段压成一行', () => {
  assert.equal(stripTags('<h3 class="x">Senior <b>Paralegal</b></h3>'), 'Senior Paralegal');
  assert.equal(stripTags('Simmons &amp; Simmons'), 'Simmons & Simmons');
  assert.equal(stripTags('  a\n\t b  '), 'a b');
  assert.equal(stripTags(''), '');
});

// ---------------------------------------------------------------- 正文

test('块级标签折成换行，段落不会挤成一坨', () => {
  const text = htmlToText('<p>第一段</p><p>第二段</p>');
  assert.equal(text, '第一段\n第二段');
});

test('<br> 折成换行，<li> 折成 "- "', () => {
  assert.equal(htmlToText('a<br>b'), 'a\nb');
  assert.equal(htmlToText('<ul><li>甲</li><li>乙</li></ul>'), '- 甲\n- 乙');
});

test('行内标签不产生换行（&lt;strong&gt; 不该把句子劈开）', () => {
  assert.equal(htmlToText('<p>Department: <strong>Corporate</strong></p>'), 'Department: Corporate');
});

test('连续空行最多留一个，行内空白压成一个空格', () => {
  assert.equal(htmlToText('<p>a</p><p></p><p></p><p>b</p>'), 'a\n\nb');
  assert.equal(htmlToText('<p>a    b\t\tc</p>'), 'a b c');
});

test('换行两侧不留空格', () => {
  assert.equal(htmlToText('<p>a </p><p> b</p>'), 'a\nb');
});

test('CRLF 归一成 LF', () => {
  assert.equal(htmlToText('<p>a\r\nb</p>'), 'a\nb');
});

test('实体在正文里同样解出来', () => {
  assert.equal(htmlToText('<p>Filings &amp; registrations</p>'), 'Filings & registrations');
});

test('空输入返回空串而不是 "null" / "undefined"', () => {
  for (const v of ['', null, undefined, '   ']) assert.equal(htmlToText(v), '');
  for (const v of ['', null, undefined]) assert.equal(stripTags(v), '');
});

// ---------------------------------------------------------------- 截断

test('truncate 只在真的截断时补省略号', () => {
  assert.equal(truncate('abcdef', 10), 'abcdef');
  assert.equal(truncate('abcdef', 6), 'abcdef', '正好等长不算截断');
  assert.equal(truncate('abcdef', 3), 'abc…');
});

test('truncate 空内容返回 null ——「没有」与「空串」要能区分', () => {
  assert.equal(truncate('', 100), null);
  assert.equal(truncate('   ', 100), null);
  assert.equal(truncate(null, 100), null);
});

test('truncate 的 max 非法时不截（宁可不限长，也不要截成空）', () => {
  assert.equal(truncate('abcdef', 0), 'abcdef');
  assert.equal(truncate('abcdef', -1), 'abcdef');
  assert.equal(truncate('abcdef', undefined), 'abcdef');
  assert.equal(truncate('abcdef', 'x'), 'abcdef');
});

test('oneLine 连换行也压掉，用于摘要', () => {
  assert.equal(oneLine('a\n\nb\tc', 100), 'a b c');
  assert.equal(oneLine('<p>a</p>', 100), '<p>a</p>', '它就是压空白，不负责去标签');
});

// ---------------------------------------------------------------- 正文的准入门槛

test('太短的「正文」当解析失败，返回 null', () => {
  assert.equal(usableDescription('太短了', 4000), null);
  assert.equal(usableDescription('', 4000), null);
});

test('够长的正文正常返回，并按上限截断', () => {
  const long = '甲'.repeat(MIN_DESCRIPTION_LENGTH + 50);
  assert.equal(usableDescription(long, 4000).length, MIN_DESCRIPTION_LENGTH + 50);
  assert.equal(usableDescription(long, 120).length, 121, '120 字符 + 省略号');
});
