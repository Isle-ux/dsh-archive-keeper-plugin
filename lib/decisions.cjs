#!/usr/bin/env node
/**
 * decisions.cjs — 记录用户对每个归档会话的「去留」选择，并执行可恢复的删除/恢复。
 *
 * 选项模型（两选项，2026-10-03 收敛）：
 *   keepBoth    —— 保留原文：什么都不删，只标记为「已保留·原文在」。
 *   keepSummary —— 只留摘要：保留摘要，原文移入 trash/（可恢复）。
 *
 * 「已保留」是个**状态**而不是选择：上面两个选项都算已保留，区别只在于
 * 原文还在不在磁盘上。因此恢复语义是：
 *   - keepBoth    的会话可以「只留摘要」（把原文移入回收站）
 *   - keepSummary 的会话可以「恢复原文」（把原文从回收站搬回原位）
 *   只要回收站没被清空，恢复就一直可用。
 *
 * 安全约束（遵守用户级 AGENTS.md）：
 *   - 任何删除都必须先有用户明确点选；
 *   - 删除一律先移动到 archive-keeper/trash/，不是真删；
 *   - 清空回收站（真删）必须带 --yes，且由 UI 二次确认。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const st = require('./state.cjs');

const DECISIONS_FILE = path.join(st.ROOT, 'state', 'decisions.json');
const PURGE_LOG = path.join(st.ROOT, 'state', 'purge-log.json');
/** 被删除的摘要单独存一份进回收站，以便「恢复」时搬回来。 */
const DIGEST_TRASH_DIR = path.join(st.TRASH_DIR, '_digests');

/**
 * 合法选择：
 *   keepBoth    —— 保留原文
 *   keepSummary —— 只留摘要
 *   deleted     —— 已删除（原文与摘要都进了回收站）
 */
const DECISIONS = ['keepBoth', 'keepSummary', 'deleted'];

/** 把历史决策值归一化到当前模型。 */
function normalize(decision) {
  if (DECISIONS.includes(decision)) return decision;
  if (decision === 'purge') return 'keepSummary'; // 历史：删原文 → 只留摘要
  if (decision === 'forget') return 'keepBoth'; // 历史：只留摘要(旧义) → 保守按保留原文
  return 'keepBoth';
}

function load() {
  return st.readJsonSafe(DECISIONS_FILE, { version: 2, items: {} });
}

function save(d) {
  fs.mkdirSync(path.dirname(DECISIONS_FILE), { recursive: true });
  const tmp = DECISIONS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(d, null, 2), 'utf8');
  fs.renameSync(tmp, DECISIONS_FILE);
}

function setDecision(sessionId, decision, note) {
  if (!DECISIONS.includes(decision)) throw new Error(`非法选择: ${decision}`);
  const d = load();
  d.version = 2;
  d.items = d.items || {};
  d.items[sessionId] = {
    ...(d.items[sessionId] || {}),
    decision,
    note: note || null,
    decidedAt: new Date().toISOString(),
  };
  save(d);
  return d.items[sessionId];
}

function getDecision(sessionId) {
  const d = load();
  const raw = d.items[sessionId];
  if (!raw) return { decision: 'keepBoth', note: null, decidedAt: null };
  return { ...raw, decision: normalize(raw.decision) };
}

/** 读取回收站里该会话的最新一条可恢复记录；没有则返回 null。 */
function findTrashed(sessionId) {
  const log = st.readJsonSafe(PURGE_LOG, []);
  // 兼容旧格式：早期记录没有 status 字段，只要 to 存在就视为已回收。
  const hits = log.filter((r) => r.id === sessionId && r.status !== 'missing' && r.to);
  if (!hits.length) return null;
  // 取最新一条且目录仍然存在、尚未被恢复的
  const live = hits.filter((r) => !r.restoredAt && fs.existsSync(r.to));
  if (!live.length) return null;
  return live[live.length - 1];
}

/**
 * 执行「只留摘要」——把原文移入 trash/，可恢复。返回明细。
 * opts.permanent=false 时绝不真删。
 */
function purge(sessionId, opts = {}) {
  const file = st.findSessionFile(sessionId);
  if (!file) {
    // 原文已经不在磁盘上（可能之前就清理过）。检查回收站里是否已有副本。
    const existing = findTrashed(sessionId);
    if (existing) {
      return { id: sessionId, status: 'already-purged', to: existing.to, bytes: existing.bytes || 0 };
    }
    return { id: sessionId, status: 'missing' };
  }

  const sessionDir = path.dirname(file);
  const size = fs.statSync(file).size;
  fs.mkdirSync(st.TRASH_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(st.TRASH_DIR, `${sessionId}__${stamp}`);
  fs.mkdirSync(dest, { recursive: true });

  // 搬整个会话目录（含 session.v4.jsonl.zstd 及其它附属文件），保留可恢复性
  fs.renameSync(sessionDir, path.join(dest, path.basename(sessionDir)));

  const rec = {
    id: sessionId,
    status: 'purged',
    at: new Date().toISOString(),
    from: sessionDir,
    to: dest,
    bytes: size,
    restoredAt: null,
  };
  const log = st.readJsonSafe(PURGE_LOG, []);
  log.push(rec);
  fs.writeFileSync(PURGE_LOG, JSON.stringify(log, null, 2), 'utf8');
  return rec;
}

// ── 摘要的删除 / 恢复（摘要也走回收站，保证可恢复）──────────────────────

/** 定位该会话的摘要文件（archive-keeper/digests/<id>.json）。 */
function digestPath(sessionId) {
  return path.join(st.DIGEST_DIR, `${sessionId}.json`);
}

/** 摘要是否还在原位。 */
function digestExists(sessionId) {
  return fs.existsSync(digestPath(sessionId));
}

/** 把摘要移入回收站的 _digests/，返回记录；本来就不在则返回 null。 */
function purgeDigest(sessionId) {
  const src = digestPath(sessionId);
  if (!fs.existsSync(src)) return null;
  fs.mkdirSync(DIGEST_TRASH_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(DIGEST_TRASH_DIR, `${sessionId}__${stamp}.json`);
  fs.renameSync(src, dest);

  const log = st.readJsonSafe(PURGE_LOG, []);
  const rec = {
    id: sessionId,
    kind: 'digest',
    status: 'purged',
    at: new Date().toISOString(),
    from: src,
    to: dest,
    bytes: 0,
    restoredAt: null,
  };
  try {
    rec.bytes = fs.statSync(dest).size;
  } catch {
    /* ignore */
  }
  log.push(rec);
  fs.writeFileSync(PURGE_LOG, JSON.stringify(log, null, 2), 'utf8');
  return rec;
}

/** 找出回收站里该会话最新的、未被恢复的摘要记录。 */
function findTrashedDigest(sessionId) {
  const log = st.readJsonSafe(PURGE_LOG, []);
  const live = log.filter(
    (r) => r.id === sessionId && r.kind === 'digest' && !r.restoredAt && r.to && fs.existsSync(r.to),
  );
  return live.length ? live[live.length - 1] : null;
}

/** 把摘要从回收站搬回原位；原位置已被占用则不覆盖。 */
function restoreDigest(sessionId) {
  const rec = findTrashedDigest(sessionId);
  if (!rec) return { status: 'no-backup' };
  if (fs.existsSync(rec.from)) return { status: 'occupied' };
  fs.mkdirSync(path.dirname(rec.from), { recursive: true });
  fs.renameSync(rec.to, rec.from);

  const log = st.readJsonSafe(PURGE_LOG, []);
  for (const r of log) if (r.to === rec.to && r.kind === 'digest') r.restoredAt = new Date().toISOString();
  fs.writeFileSync(PURGE_LOG, JSON.stringify(log, null, 2), 'utf8');
  return { status: 'restored', to: rec.from };
}

// ── 彻底删除 / 从已删除恢复 ─────────────────────────────────────────────

/**
 * 「彻底删除」：无论当前什么状态，原文和摘要都必定被删除（都进回收站）。
 * 因此调用后必定进入「已删除」。
 *
 *   原文在(keepBoth)    → 删原文 + 删摘要
 *   已精简(keepSummary) → 原文已在回收站，只删摘要
 *
 * 返回 { prevDecision, file, digest, status }。
 */
function hardDelete(sessionId) {
  const prev = getDecision(sessionId);
  const prevDecision = prev.decision === 'deleted' ? prev.prevDecision || 'keepBoth' : prev.decision;

  // 1) 原文：先尝试移入回收站；若原本就是 keepSummary，原文早已在回收站。
  let fileResult = { status: 'already-in-trash' };
  const existingFile = findTrashed(sessionId);
  if (st.findSessionFile(sessionId)) {
    fileResult = purge(sessionId);
  } else if (!existingFile) {
    fileResult = { status: 'missing' };
  }

  // 2) 摘要：移入回收站（如果还在的话）。
  let digestResult = null;
  try {
    digestResult = purgeDigest(sessionId);
  } catch (err) {
    return { id: sessionId, status: 'error', error: `删除摘要失败: ${err?.message || err}`, prevDecision };
  }

  const rec = setDecision(sessionId, 'deleted', 'hard-delete');
  // 记下「被删前是什么状态」，恢复时据此回到原状态。
  const d = load();
  d.items[sessionId] = {
    ...d.items[sessionId],
    prevDecision,
    deletedAt: new Date().toISOString(),
    fileTrashedTo: (fileResult && fileResult.to) || (existingFile && existingFile.to) || null,
    digestTrashedTo: (digestResult && digestResult.to) || null,
  };
  save(d);

  return {
    id: sessionId,
    status: 'deleted',
    prevDecision,
    file: fileResult,
    digest: digestResult ? { status: 'purged', to: digestResult.to } : { status: 'missing' },
    decision: rec,
  };
}

/**
 * 「已删除」里点恢复：只恢复上次彻底删除拿走的那些，回到被删前的状态。
 *   原本 keepBoth    → 恢复原文 + 摘要 → keepBoth
 *   原本 keepSummary → 只恢复摘要（原文继续留在回收站）→ keepSummary
 */
function restoreDeleted(sessionId) {
  const cur = getDecision(sessionId);
  const prevDecision = cur.prevDecision || 'keepBoth';

  const digestRes = restoreDigest(sessionId);
  let fileRes = { status: 'not-applicable' };

  // 只有当被删前是「保留原文」时，原文才该跟着回来。
  if (prevDecision === 'keepBoth') {
    fileRes = restore(sessionId);
  }

  // 恢复目标状态
  const target = prevDecision === 'keepSummary' ? 'keepSummary' : 'keepBoth';
  const d = load();
  d.items[sessionId] = {
    ...d.items[sessionId],
    decision: target,
    note: 'restored-from-deleted',
    decidedAt: new Date().toISOString(),
    restoredAt: new Date().toISOString(),
  };
  save(d);

  return {
    id: sessionId,
    status: 'restored',
    toDecision: target,
    digest: digestRes,
    file: fileRes,
  };
}

/**
 * 执行「恢复原文」——把会话目录从 trash/ 搬回原来的位置。
 * 只有当回收站里还留着副本时才可能成功。
 */
function restore(sessionId) {
  const rec = findTrashed(sessionId);
  if (!rec) return { id: sessionId, status: 'no-backup' };

  const inner = path.join(rec.to, path.basename(rec.from));
  if (!fs.existsSync(inner)) return { id: sessionId, status: 'no-backup' };

  // 原位置必须不存在才恢复，避免覆盖现在正在用的会话目录
  if (fs.existsSync(rec.from)) {
    return { id: sessionId, status: 'occupied', from: rec.from };
  }

  fs.mkdirSync(path.dirname(rec.from), { recursive: true });
  fs.renameSync(inner, rec.from);

  // 回收站目录空了就顺手删掉这个空壳（不是删用户内容）
  try {
    const rest = fs.readdirSync(rec.to);
    if (!rest.length) fs.rmdirSync(rec.to);
  } catch {
    /* ignore */
  }

  const log = st.readJsonSafe(PURGE_LOG, []);
  for (const r of log) {
    if (r.to === rec.to && r.id === sessionId) r.restoredAt = new Date().toISOString();
  }
  fs.writeFileSync(PURGE_LOG, JSON.stringify(log, null, 2), 'utf8');

  return { id: sessionId, status: 'restored', to: rec.from, bytes: rec.bytes || 0 };
}

/** 列出回收站里可恢复的条目（供面板展示与清空确认）。
 *  kind 为 'session'（原文）或 'digest'（摘要）。 */
function listTrash() {
  const log = st.readJsonSafe(PURGE_LOG, []);
  const out = [];
  for (const r of log) {
    if (r.status === 'missing' || r.restoredAt) continue;
    if (!r.id || !r.to || !fs.existsSync(r.to)) continue;
    const kind = r.kind === 'digest' ? 'digest' : 'session';
    let size = r.bytes || 0;
    if (kind === 'session') {
      try {
        size = 0;
        const walk = (dir) => {
          for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const p = path.join(dir, e.name);
            if (e.isDirectory()) walk(p);
            else size += fs.statSync(p).size;
          }
        };
        walk(r.to);
      } catch {
        /* keep logged bytes */
      }
    }
    out.push({ id: r.id, kind, at: r.at, to: r.to, bytes: size });
  }
  return out;
}

/** 真删回收站内容（不可逆）。只有 UI 二次确认后才会调到这里。
 *  清空后，「已删除」列表同步清空：副本没了，就不该再显示为可恢复。 */
function emptyTrash(ids) {
  const items = listTrash();
  const targets = Array.isArray(ids) && ids.length ? items.filter((i) => ids.includes(i.id)) : items;
  const removed = [];
  for (const t of targets) {
    try {
      if (t.kind === 'digest') fs.rmSync(t.to, { force: true });
      else fs.rmSync(t.to, { recursive: true, force: true });
      removed.push({ id: t.id, kind: t.kind, to: t.to, bytes: t.bytes });
    } catch (err) {
      removed.push({ id: t.id, kind: t.kind, to: t.to, error: String(err?.message || err) });
    }
  }

  // 同步清除「已删除」状态：这些会话的副本已经真删了，不能再留在已删除列表里当可恢复项。
  const clearedIds = [];
  const d = load();
  d.items = d.items || {};
  for (const [id, rec] of Object.entries(d.items)) {
    if (normalize(rec.decision) !== 'deleted') continue;
    // 该会话在回收站里还有任何活着的副本吗？
    const stillHas = listTrash().some((t) => t.id === id);
    if (stillHas) continue;
    delete d.items[id];
    clearedIds.push(id);
  }
  if (clearedIds.length) save(d);

  const log = st.readJsonSafe(PURGE_LOG, []);
  for (const r of log) {
    if (removed.some((x) => x.to === r.to && !x.error)) r.hardDeletedAt = new Date().toISOString();
  }
  fs.writeFileSync(PURGE_LOG, JSON.stringify(log, null, 2), 'utf8');
  return {
    removed,
    bytes: removed.reduce((a, b) => a + (b.bytes || 0), 0),
    // 这些会话因为副本被真删，已经从「已删除」列表里同步移除了。
    clearedIds,
  };
}

function main() {
  const [cmd, sessionId, ...rest] = process.argv.slice(2);
  if (cmd === 'set' && sessionId && rest[0]) {
    console.log(JSON.stringify(setDecision(sessionId, rest[0], rest[1]), null, 2));
  } else if (cmd === 'get' && sessionId) {
    console.log(JSON.stringify(getDecision(sessionId), null, 2));
  } else if (cmd === 'list') {
    console.log(JSON.stringify(load(), null, 2));
  } else if (cmd === 'trash') {
    console.log(JSON.stringify(listTrash(), null, 2));
  } else if (cmd === 'purge' && sessionId) {
    if (!rest.includes('--yes')) {
      const f = st.findSessionFile(sessionId);
      const size = f ? fs.statSync(f).size : 0;
      console.log(`[dry-run] 将把会话 ${sessionId} 的原始文件移入 trash/`);
      console.log(`  路径: ${f || '(未找到)'}`);
      console.log(`  大小: ${(size / 1024).toFixed(1)} KB`);
      console.log('  确认请加 --yes');
      return;
    }
    console.log(JSON.stringify(purge(sessionId), null, 2));
  } else if (cmd === 'restore' && sessionId) {
    console.log(JSON.stringify(restore(sessionId), null, 2));
  } else if (cmd === 'hard-delete' && sessionId) {
    if (!rest.includes('--yes')) {
      const f = st.findSessionFile(sessionId);
      const size = f ? fs.statSync(f).size : 0;
      const dg = digestExists(sessionId) ? '有' : '无';
      const cur = getDecision(sessionId).decision;
      console.log(`[dry-run] 彻底删除 ${sessionId}（当前状态: ${cur}）`);
      console.log(`  原文: ${f || '(已在回收站)'}${f ? `  ${(size / 1024).toFixed(1)} KB` : ''}`);
      console.log(`  摘要: ${dg}`);
      console.log('  两者都会移入回收站，之后可从「已删除」恢复');
      console.log('  确认请加 --yes');
      return;
    }
    console.log(JSON.stringify(hardDelete(sessionId), null, 2));
  } else if (cmd === 'restore-deleted' && sessionId) {
    console.log(JSON.stringify(restoreDeleted(sessionId), null, 2));
  } else {
    console.log('usage: decisions.cjs set <id> <keepBoth|keepSummary|deleted> [note]');
    console.log('       decisions.cjs get <id>');
    console.log('       decisions.cjs list');
    console.log('       decisions.cjs trash');
    console.log('       decisions.cjs purge <id> [--yes]');
    console.log('       decisions.cjs restore <id>');
    console.log('       decisions.cjs hard-delete <id> [--yes]');
    console.log('       decisions.cjs restore-deleted <id>');
  }
}

if (require.main === module) main();
module.exports = {
  load,
  save,
  setDecision,
  getDecision,
  normalize,
  purge,
  restore,
  findTrashed,
  listTrash,
  emptyTrash,
  // 新增：摘要删除/恢复 + 彻底删除/从已删除恢复
  digestPath,
  digestExists,
  purgeDigest,
  findTrashedDigest,
  restoreDigest,
  hardDelete,
  restoreDeleted,
  DECISIONS,
  DECISIONS_FILE,
  DIGEST_TRASH_DIR,
};
