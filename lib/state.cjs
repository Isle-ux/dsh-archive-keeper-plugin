#!/usr/bin/env node
/**
 * state.cjs — 归档守护的状态机与事实源。
 *
 * 设计要点：
 *  - 事实源是 DSH 自己的 workspace.json 的 global.archivedSessionIds。
 *  - 本文件只记录「我们处理到哪了」，绝不反过来去改 DSH 的归档列表。
 *  - 删除原始会话文件是「可选、需用户显式同意」的动作，默认关闭。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const os = require('os');

/**
 * 用户数据根目录（摘要 / 选择 / 回收站都写在这里），**不是**插件安装目录。
 *
 * 优先级：
 *   1. 环境变量 ARCHIVE_KEEPER_ROOT（宿主 apply() 会按 config.root 设好）
 *   2. 默认 <用户目录>/Documents/deepseek-harness/archive-keeper
 *
 * 说明：这里刻意不再用 __dirname/'..' —— 那样在插件被装进 node_modules 之后，
 * 用户数据会被写进插件安装目录里，既污染包体、又会在更新/卸载时丢失。
 */
function defaultRoot() {
  const home = os.homedir() || process.env.USERPROFILE || '.';
  return path.join(home, 'Documents', 'deepseek-harness', 'archive-keeper');
}

const ROOT = process.env.ARCHIVE_KEEPER_ROOT
  ? path.resolve(process.env.ARCHIVE_KEEPER_ROOT)
  : defaultRoot();
const STATE_FILE = path.join(ROOT, 'state', 'state.json');
const DIGEST_DIR = path.join(ROOT, 'digests');
const TRASH_DIR = path.join(ROOT, 'trash');

const DSH_HOME = process.env.DSH_HOME || path.join(process.env.USERPROFILE || '', '.dsh');
const WORKSPACE_JSON = path.join(DSH_HOME, 'storages', 'workspace.json');

function readJsonSafe(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/** 读取 DSH 归档会话 id 列表（唯一事实源）。 */
function readArchivedIds() {
  const j = readJsonSafe(WORKSPACE_JSON, null);
  if (!j || !j.global || !Array.isArray(j.global.archivedSessionIds)) return [];
  return j.global.archivedSessionIds;
}

/** 定位某个会话的 session.v4.jsonl.zstd 绝对路径；找不到返回 null。 */
function findSessionFile(sessionId) {
  const base = path.join(DSH_HOME, 'sessions');
  let workspaces = [];
  try {
    workspaces = fs.readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    return null;
  }
  for (const ws of workspaces) {
    const f = path.join(base, ws.name, sessionId, 'session.v4.jsonl.zstd');
    if (fs.existsSync(f)) return f;
  }
  return null;
}

function loadState() {
  const s = readJsonSafe(STATE_FILE, null);
  return s && typeof s === 'object' && s.sessions ? s : { version: 1, sessions: {} };
}

function saveState(state) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  const tmp = STATE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
  fs.renameSync(tmp, STATE_FILE);
}

/** 简单的排他锁，避免定时任务与插件触发并发重入。
 *  带陈旧锁回收：进程崩溃/被杀时锁文件会残留，超过 staleMs 且 PID 已不存在就抢占。 */
function withLock(fn, staleMs = 30 * 60 * 1000) {
  const lock = path.join(ROOT, 'state', '.lock');
  fs.mkdirSync(path.dirname(lock), { recursive: true });

  const tryAcquire = () => {
    const fd = fs.openSync(lock, 'wx');
    fs.writeSync(fd, String(process.pid));
    fs.closeSync(fd);
  };

  try {
    tryAcquire();
  } catch {
    // 已有锁：判断是否陈旧（进程不在 or 太老）
    let stale = false;
    try {
      const st2 = fs.statSync(lock);
      const pid = Number(fs.readFileSync(lock, 'utf8').trim());
      const age = Date.now() - st2.mtimeMs;
      let alive = false;
      if (Number.isFinite(pid) && pid > 0) {
        try {
          process.kill(pid, 0);
          alive = true;
        } catch {
          alive = false;
        }
      }
      stale = !alive || age > staleMs;
    } catch {
      stale = true;
    }
    if (!stale) return { skipped: true, reason: '另一个归档处理进程正在运行' };
    try {
      fs.unlinkSync(lock);
    } catch {
      /* ignore */
    }
    try {
      tryAcquire();
    } catch {
      return { skipped: true, reason: '无法获取锁（并发竞争）' };
    }
  }

  try {
    return fn();
  } finally {
    try {
      fs.unlinkSync(lock);
    } catch {
      /* ignore */
    }
  }
}

const CATEGORIES = ['decision', 'preference', 'fact', 'lesson', 'deliverable', 'todo', 'trivial'];

function digestPath(sessionId) {
  return path.join(DIGEST_DIR, sessionId + '.json');
}

function writeDigest(sessionId, data) {
  fs.mkdirSync(DIGEST_DIR, { recursive: true });
  const p = digestPath(sessionId);
  fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf8');
  return p;
}

function readDigest(sessionId) {
  return readJsonSafe(digestPath(sessionId), null);
}

function listDigests() {
  try {
    return fs
      .readdirSync(DIGEST_DIR)
      .filter((f) => f.endsWith('.json'))
      .map((f) => readJsonSafe(path.join(DIGEST_DIR, f), null))
      .filter(Boolean);
  } catch {
    return [];
  }
}

module.exports = {
  ROOT,
  STATE_FILE,
  DIGEST_DIR,
  TRASH_DIR,
  DSH_HOME,
  WORKSPACE_JSON,
  CATEGORIES,
  readArchivedIds,
  findSessionFile,
  loadState,
  saveState,
  withLock,
  digestPath,
  writeDigest,
  readDigest,
  listDigests,
  readJsonSafe,
};
