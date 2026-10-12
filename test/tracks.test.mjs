// T5 — track 归属与标题过滤。样例标题全部取自 2026-10-12 JobsDB 实测结果。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createClassifier } from '../src/tracks.mjs';

const CONFIG = {
  tracks: {
    trainee: { label: 'Trainee Solicitor', searchKeywords: 'trainee solicitor', titlePatterns: ['\\btrainee\\b', 'solicitor'] },
    paralegal: { label: 'Paralegal', searchKeywords: 'paralegal', titlePatterns: ['\\bparalegal\\b'] },
  },
  titleFilter: {
    requireTrack: true,
    negative: ['\\bsecretary\\b', '\\bsecretarial\\b', '\\bintern\\b', '\\binternship\\b', '\\breceptionist\\b'],
  },
};

const classify = createClassifier(CONFIG);
const tracksOf = (t) => classify(t).tracks;
const kept = (t) => classify(t).keep;

test('单头标题只打一个标签', () => {
  assert.deepEqual(tracksOf('Trainee Solicitor'), ['trainee']);
  assert.deepEqual(tracksOf('Senior Paralegal'), ['paralegal']);
});

test('多头广告两个标签都打，且顺序稳定', () => {
  assert.deepEqual(tracksOf('Paralegal / Trainee solicitors'), ['trainee', 'paralegal']);
  assert.deepEqual(tracksOf('Paralegal/Legal Executive/ Trainee Solicitor'), ['trainee', 'paralegal']);
  assert.deepEqual(tracksOf('Trainee Solicitor (1st or 2nd year trainee, 2026 intake), Paralegal/Legal Clerk'), ['trainee', 'paralegal']);
});

test('trainee 需要 trainee 与 solicitor 同时命中 —— 「Paralegal Trainee」不是见习律师', () => {
  assert.deepEqual(tracksOf('Paralegal Trainee'), ['paralegal']);
  assert.deepEqual(tracksOf('Paralegal / Paralegal Trainee'), ['paralegal']);
});

test('大小写不敏感', () => {
  assert.deepEqual(tracksOf('TRAINEE SOLICITOR (GENERAL PRACTICE)'), ['trainee']);
  assert.deepEqual(tracksOf('CONVEYANCING PARALEGAL/LEGAL EXECUTIVE'), ['paralegal']);
});

test('归属不到任何 track 的标题被丢弃（SEEK 语义匹配的噪声）', () => {
  for (const t of ['Litigation Clerk', 'Legal Assistant', '法务专员', 'Administrative Assistant (Legal)', 'Associate - Funds, Corporate & Commercial']) {
    assert.equal(kept(t), false, t);
    assert.deepEqual(tracksOf(t), [], t);
  }
});

test('负面词命中即丢弃', () => {
  for (const t of ['Legal Secretary/ Legal Executive/ Paralegal', 'Paralegal / Legal Secretary', 'Secretary / Paralegal in Litigation Departments', 'Intern, Legal Department']) {
    assert.equal(kept(t), false, t);
  }
});

test('负面词按词边界匹配，不吃掉 Internal / Secretaryship 之外的词', () => {
  // \bintern\b 不应命中 Internal —— 否则整个法务内部岗都被误杀
  assert.equal(kept('Internal Audit Paralegal'), true);
  assert.deepEqual(tracksOf('Internal Audit Paralegal'), ['paralegal']);
});

test('没有 track 命中的标题同时给出原因', () => {
  assert.equal(classify('Legal Assistant').reason, 'no-track');
  assert.equal(classify('Paralegal / Legal Secretary').reason, 'negative');
  assert.equal(classify('Paralegal').reason, null);
});

test('requireTrack 关闭时，无 track 的标题也保留（但 tracks 仍为空）', () => {
  const lax = createClassifier({ ...CONFIG, titleFilter: { ...CONFIG.titleFilter, requireTrack: false } });
  assert.equal(lax('Legal Assistant').keep, true);
  assert.deepEqual(lax('Legal Assistant').tracks, []);
  // 负面词照旧生效
  assert.equal(lax('Litigation Secretary').keep, false);
});

test('空白标题安全丢弃', () => {
  for (const t of ['', '   ', null, undefined]) {
    assert.equal(classify(t).keep, false, String(t));
  }
});

test('关键词语义来自 config，而非硬编码在代码里', () => {
  const custom = createClassifier({
    tracks: { notary: { label: 'Notary', searchKeywords: 'notary', titlePatterns: ['\\bnotar'] } },
    titleFilter: { requireTrack: true, negative: [] },
  });
  assert.deepEqual(custom('Public Notary').tracks, ['notary']);
  assert.equal(custom('Paralegal').keep, false, 'tracks 由 config 定义，默认的两条不参与');
});
