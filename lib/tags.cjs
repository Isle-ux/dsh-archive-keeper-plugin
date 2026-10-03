#!/usr/bin/env node
/**
 * tags.cjs — 「值得留存」的自定义价值规则（个性化收纳）。
 *
 * 用户语义（2026-10-03）：
 *   「自定义价值定义为这个选项收纳的首要价值判断；未自定义的话按默认价值收纳。」
 *   即：命中自定义规则的会话**优先**纳入「值得留存」；没命中任何规则的，
 *   再回落到 keeper 提炼出来的默认判断（reusable === true）。
 *
 * 两类规则（可同时存在）：
 *   1) 标签（tag）—— 给会话打上自定义标签。常见标签有预设可选，也能自建。
 *      规则形如：命中关键词/keyword、命中分类/category、轮数 ≥ minTurns 的会话，
 *      自动打上某标签。
 *   2) 筛选规则（filter）—— 纯条件式，不一定要打标签，只用来决定收纳。
 *
 * 规则结构（存 state/tags.json）：
 *   {
 *     version: 1,
 *     tags: [ { name, color, note, createdAt } ],          // 可用标签集合
 *     labels: { [sessionId]: [tagName, ...] },             // 会话 -> 标签（手工 + 自动）
 *     auto: [ { id, enabled, tag, match: {...}, createdAt } ], // 自动打标签规则
 *     rules: [ { id, enabled, note, match: {...}, createdAt } ], // 收纳规则（首要价值）
 *   }
 *
 * match 支持字段（全部可选，多个条件为「且」）：
 *   keywords: string[]   标题/摘要/要点里出现任一即命中（不区分大小写）
 *   categories: string[] 分类命中其一
 *   minTurns / maxTurns: number  用户轮数区间
 *   reusable: boolean    默认价值判断是否必须为 true
 *   anyOf: 'tag'|null    只要已有任何标签就命中
 */
'use strict';

const fs = require('fs');
const path = require('path');
const st = require('./state.cjs');

const TAGS_FILE = path.join(st.ROOT, 'state', 'tags.json');

/** 预设常见标签，供 UI 一键选用。 */
const PRESET_TAGS = [
  { name: '重要', color: '#e5484d', note: '关键结论或不可丢失的内容' },
  { name: '环境事实', color: '#0b7fab', note: '本机 / 环境相关的可复用事实' },
  { name: '用户偏好', color: '#8e4ec6', note: '我的习惯、口味、明确要求' },
  { name: '教训', color: '#d97706', note: '踩过的坑与纠正' },
  { name: '待跟进', color: '#0f9d58', note: '还没做完、以后要继续' },
  { name: '可复用', color: '#3b82f6', note: '方法论 / 配置 / 脚本，之后还要用' },
  { name: '项目', color: '#6b7280', note: '某个项目的专门记录' },
  { name: '灵感', color: '#db2777', note: '想法、脑洞、以后可能做' },
];

/** 预设的分类名，与 keeper 的 category 对齐。 */
const PRESET_CATEGORIES = ['decision', 'preference', 'fact', 'lesson', 'deliverable', 'todo', 'trivial'];

const EMPTY = { version: 1, tags: [], labels: {}, auto: [], rules: [] };

function load() {
  const raw = st.readJsonSafe(TAGS_FILE, null);
  if (!raw || typeof raw !== 'object') return { ...EMPTY, tags: [], labels: {}, auto: [], rules: [] };
  return {
    version: 1,
    tags: Array.isArray(raw.tags) ? raw.tags : [],
    labels: raw.labels && typeof raw.labels === 'object' ? raw.labels : {},
    auto: Array.isArray(raw.auto) ? raw.auto : [],
    rules: Array.isArray(raw.rules) ? raw.rules : [],
  };
}

function save(d) {
  fs.mkdirSync(path.dirname(TAGS_FILE), { recursive: true });
  const tmp = TAGS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(d, null, 2), 'utf8');
  fs.renameSync(tmp, TAGS_FILE);
  return d;
}

// ── 标签集合 ────────────────────────────────────────────────────────────

function addTag(name, color, note) {
  const n = String(name || '').trim();
  if (!n) throw new Error('标签名不能为空');
  if (n.length > 24) throw new Error('标签名过长（最多 24 字）');
  const d = load();
  if (d.tags.some((t) => t.name === n)) throw new Error(`标签「${n}」已存在`);
  d.tags.push({ name: n, color: color || '#6b7280', note: note || '', createdAt: new Date().toISOString() });
  save(d);
  return d.tags[d.tags.length - 1];
}

function removeTag(name) {
  const d = load();
  d.tags = d.tags.filter((t) => t.name !== name);
  for (const id of Object.keys(d.labels)) {
    d.labels[id] = d.labels[id].filter((x) => x !== name);
    if (!d.labels[id].length) delete d.labels[id];
  }
  for (const r of [...d.auto, ...d.rules]) if (r.tag === name) r.tag = null;
  save(d);
  return d;
}

/** 给某会话手工打 / 取消标签。 */
function setLabel(sessionId, tagName, on) {
  const d = load();
  const cur = new Set(d.labels[sessionId] || []);
  if (on) cur.add(tagName);
  else cur.delete(tagName);
  if (cur.size) d.labels[sessionId] = [...cur];
  else delete d.labels[sessionId];
  save(d);
  return d.labels[sessionId] || [];
}

function getLabels(sessionId) {
  return load().labels[sessionId] || [];
}

// ── 规则匹配 ────────────────────────────────────────────────────────────

/** 把一条摘要 + 已有标签 折成可匹配的文本与事实。 */
function factsOf(item, labels) {
  const hay = [
    item.title || '',
    item.summary || '',
    ...(Array.isArray(item.keyPoints) ? item.keyPoints : []),
    ...(Array.isArray(item.decisions) ? item.decisions : []),
    ...(Array.isArray(item.facts) ? item.facts : []),
  ]
    .join('\n')
    .toLowerCase();
  return {
    hay,
    category: item.category || '',
    turns: Number(item.userTurnCount) || 0,
    reusable: item.reusable === true,
    hasLabel: Array.isArray(labels) ? labels.length > 0 : false,
  };
}

/** 判断一条 match 是否命中给定事实。空 match 视为不命中（避免误纳全部）。 */
function matchOne(match, f) {
  if (!match || typeof match !== 'object') return false;
  let any = false;

  if (Array.isArray(match.keywords) && match.keywords.length) {
    any = true;
    const hit = match.keywords.some((k) => {
      const s = String(k || '').trim().toLowerCase();
      return s && f.hay.includes(s);
    });
    if (!hit) return false;
  }
  if (Array.isArray(match.categories) && match.categories.length) {
    any = true;
    if (!match.categories.includes(f.category)) return false;
  }
  if (typeof match.minTurns === 'number') {
    any = true;
    if (f.turns < match.minTurns) return false;
  }
  if (typeof match.maxTurns === 'number') {
    any = true;
    if (f.turns > match.maxTurns) return false;
  }
  if (typeof match.reusable === 'boolean') {
    any = true;
    if (f.reusable !== match.reusable) return false;
  }
  if (match.anyOf === 'tag') {
    any = true;
    if (!f.hasLabel) return false;
  }
  return any;
}

/**
 * 评估一个会话：
 *   labels     —— 自动规则新打上的标签（并入已有）
 *   customKeep —— 是否被自定义规则判定为「值得留存」（首要价值）
 *   ruleIds    —— 命中的规则 id
 */
function evaluate(item, existingLabels) {
  const d = load();
  const f = factsOf(item, existingLabels);
  const labels = new Set(existingLabels || []);
  const autoHit = [];

  for (const r of d.auto) {
    if (r.enabled === false) continue;
    if (!r.tag) continue;
    if (matchOne(r.match, f)) {
      labels.add(r.tag);
      autoHit.push(r.id);
    }
  }

  const ruleHit = [];
  for (const r of d.rules) {
    if (r.enabled === false) continue;
    if (matchOne(r.match, f) || (r.tag && labels.has(r.tag))) {
      ruleHit.push(r.id);
      if (r.tag) labels.add(r.tag);
    }
  }

  // hasCustom 必须与 hasCustomization() 口径一致：只要有「启用中」的规则才算配过。
  // 否则全部停用时，界面会说「没自定义」但收纳却仍按「已配过」处理，两边打架。
  const hasCustom = d.rules.some((r) => r.enabled !== false) || d.auto.some((r) => r.enabled !== false);

  return {
    labels: [...labels],
    autoHit,
    ruleHit,
    customKeep: ruleHit.length > 0,
    hasCustom,
  };
}

/** 是否配置过任何自定义（没有任何自定义时，「值得留存」完全按默认判断）。 */
function hasCustomization() {
  const d = load();
  return d.rules.some((r) => r.enabled !== false) || d.auto.some((r) => r.enabled !== false);
}

// ── 规则增删改 ──────────────────────────────────────────────────────────

function addRule(kind, rule) {
  const d = load();
  if (kind !== 'auto' && kind !== 'rules') throw new Error(`非法规则类型: ${kind}`);
  if (!rule || !rule.match || typeof rule.match !== 'object') throw new Error('规则缺少 match 条件');
  // 至少得有一个实际条件，否则会把所有会话都纳进来
  const m = rule.match;
  const meaningful =
    (Array.isArray(m.keywords) && m.keywords.length) ||
    (Array.isArray(m.categories) && m.categories.length) ||
    typeof m.minTurns === 'number' ||
    typeof m.maxTurns === 'number' ||
    typeof m.reusable === 'boolean' ||
    m.anyOf === 'tag' ||
    !!rule.tag;
  if (!meaningful) throw new Error('规则至少要有一个条件（关键词 / 分类 / 轮数），否则会命中全部会话');

  const rec = {
    id: `${kind === 'auto' ? 'a' : 'r'}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    enabled: rule.enabled !== false,
    tag: rule.tag || null,
    note: rule.note || '',
    match: m,
    createdAt: new Date().toISOString(),
  };
  d[kind].push(rec);
  save(d);
  return rec;
}

function updateRule(id, patch) {
  const d = load();
  let found = null;
  for (const kind of ['auto', 'rules']) {
    const r = d[kind].find((x) => x.id === id);
    if (r) {
      found = r;
      if (patch.enabled !== undefined) r.enabled = !!patch.enabled;
      if (patch.tag !== undefined) r.tag = patch.tag;
      if (patch.note !== undefined) r.note = patch.note;
      if (patch.match !== undefined) r.match = patch.match;
    }
  }
  if (!found) throw new Error(`规则不存在: ${id}`);
  save(d);
  return found;
}

function removeRule(id) {
  const d = load();
  const before = d.auto.length + d.rules.length;
  d.auto = d.auto.filter((r) => r.id !== id);
  d.rules = d.rules.filter((r) => r.id !== id);
  save(d);
  return { removed: before - (d.auto.length + d.rules.length) };
}

/** 规则的中文可读描述（客户端也用，保证说法一致）。 */
function describeMatch(match) {
  const m = match || {};
  const parts = [];
  if (Array.isArray(m.keywords) && m.keywords.length) parts.push(`关键词：${m.keywords.join(' / ')}`);
  if (Array.isArray(m.categories) && m.categories.length) parts.push(`分类：${m.categories.join(' / ')}`);
  if (typeof m.minTurns === 'number') parts.push(`≥ ${m.minTurns} 轮`);
  if (typeof m.maxTurns === 'number') parts.push(`≤ ${m.maxTurns} 轮`);
  if (typeof m.reusable === 'boolean') parts.push(m.reusable ? '默认判断为值得留存' : '默认判断为不值得留存');
  if (m.anyOf === 'tag') parts.push('已打任意标签');
  return parts.length ? parts.join('，') : '（无条件）';
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === 'show') {
    console.log(JSON.stringify(load(), null, 2));
  } else if (cmd === 'presets') {
    console.log(JSON.stringify({ tags: PRESET_TAGS, categories: PRESET_CATEGORIES }, null, 2));
  } else if (cmd === 'add-tag' && rest[0]) {
    console.log(JSON.stringify(addTag(rest[0], rest[1], rest[2]), null, 2));
  } else if (cmd === 'rm-tag' && rest[0]) {
    console.log(JSON.stringify(removeTag(rest[0]), null, 2));
  } else if (cmd === 'label' && rest[0] && rest[1]) {
    console.log(JSON.stringify(setLabel(rest[0], rest[1], rest[2] !== 'off'), null, 2));
  } else {
    console.log('usage: tags.cjs show | presets');
    console.log('       tags.cjs add-tag <名称> [颜色] [说明]');
    console.log('       tags.cjs rm-tag <名称>');
    console.log('       tags.cjs label <会话id> <标签名> [off]');
  }
}

if (require.main === module) main();
module.exports = {
  load,
  save,
  addTag,
  removeTag,
  setLabel,
  getLabels,
  evaluate,
  hasCustomization,
  matchOne,
  factsOf,
  addRule,
  updateRule,
  removeRule,
  describeMatch,
  PRESET_TAGS,
  PRESET_CATEGORIES,
  TAGS_FILE,
};
