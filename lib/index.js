/**
 * dsh-archive-keeper — 宿主半边。
 *
 * 职责：
 *   1. 监听 DSH 归档列表（workspace.json 的 global.archivedSessionIds）的变化；
 *      一旦出现新归档的会话，就在后台调起 archive-keeper 的提炼流程。
 *   2. 通过 webServer 暴露同源 HTTP 路由，把摘要与「去留」选择能力交给对话头部面板。
 *
 * 选项模型（两选项）：
 *   keepBoth    —— 保留原文：什么都不删。归入「已保留·原文在」。
 *   keepSummary —— 只留摘要：保留摘要，原文移入 trash/（可恢复）。
 *                  归入「已保留·已精简」，可随时「恢复原文」。
 *
 * 设计约束（与 dsh-web-search-tavily 同源经验）：
 *   - 不 import 任何 @deepseek-ai/*：profile 装的插件其 node_modules 里没有这些包，
 *     import 会直接失败导致插件静默不激活。
 *   - webServer 走 `inject`（硬依赖）。
 *   - 删除是危险动作：只接受面板的显式 POST，且一律先移入可恢复的 trash/；
 *     清空回收站是不可逆真删，必须带 confirm 字段。
 *
 * @module dsh-archive-keeper
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

export const name = 'archive-keeper';
export const inject = ['webServer'];

const BASE = '/archive-keeper';

/** archive-keeper 工作区根目录（可被 config.root 覆盖）。 */
const DEFAULT_ROOT = path.join(
  os.homedir(),
  'Documents',
  'deepseek-harness',
  'archive-keeper',
);

/**
 * 本插件自带的 CJS 模块（与本文件同目录），刻意做成「纯 CJS、无 @deepseek-ai 依赖」，
 * 这样宿主与命令行都能复用同一份逻辑。
 *
 * 注意：这些模块随插件包一起发布，所以从**插件自己的 lib/** 加载，
 * 而不是从用户数据目录 ROOT 加载 —— 否则全新安装会找不到文件。
 */
const SELF_LIB = path.dirname(fileURLToPath(import.meta.url));

function loadSelf(name) {
  const req = createRequire(import.meta.url);
  return req(path.join(SELF_LIB, name));
}

function loadDecisions() {
  return loadSelf('decisions.cjs');
}

/** 自定义价值规则（标签 / 筛选规则）；缺文件时静默降级，不影响主功能。 */
function loadTags() {
  try {
    return loadSelf('tags.cjs');
  } catch {
    return null;
  }
}

function readJsonSafe(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export function apply(ctx, config = {}) {
  const ROOT = config.root || DEFAULT_ROOT;
  const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  const WORKSPACE_JSON = path.join(DSH_HOME, 'storages', 'workspace.json');
  // keeper.cjs 随包发布在**插件自己的 lib/** 下，正常用法直接从这里起。
  // 但沙盒验证会把 ROOT 指到临时数据目录，此时 keeper 代码仍留在插件目录里，
  // 所以允许用 ARCHIVE_KEEPER_BIN 显式指定（与 loadSelf 的 SELF_LIB 回退并存）。
  const KEEPER = process.env.ARCHIVE_KEEPER_BIN || path.join(SELF_LIB, 'keeper.cjs');
  const POLL_MS = Number(config.pollMs) || 30000;
  // 一条会话最多自动重试几次。超过后不再算「有活可干」，避免把「永远失败」
  // 的会话当成待办、让后台无限重跑（用户要的是全自动，不是无限空转）。
  const MAX_RETRY_ATTEMPTS = Number(config.maxRetryAttempts) || 3;

  // 把数据根目录传给随包发布的 CJS 模块（它们在 require 时读取这个变量）。
  // 必须在下面的 loadDecisions()/loadTags() 之前设好。
  process.env.ARCHIVE_KEEPER_ROOT = ROOT;

  const log = (msg) => {
    try {
      ctx.logger?.info?.(`[archive-keeper] ${msg}`);
    } catch {
      /* ignore */
    }
  };

  let decisions = null;
  try {
    decisions = loadDecisions();
  } catch (err) {
    log(`decisions.cjs 加载失败，删除/恢复能力禁用: ${err?.message || err}`);
  }

  let tags = null;
  try {
    tags = loadTags();
  } catch (err) {
    log(`tags.cjs 加载失败，自定义价值规则禁用: ${err?.message || err}`);
  }

  // ── 1. 归档监听：新归档出现就自动提炼 ───────────────────────────────────
  let lastArchivedKey = '';
  let running = false;
  let timer = null;

  const readArchivedIds = () => {
    const j = readJsonSafe(WORKSPACE_JSON, null);
    if (!j?.global || !Array.isArray(j.global.archivedSessionIds)) return [];
    return j.global.archivedSessionIds;
  };

  /**
   * 数一下归档列表里有多少会话已经「尘埃落定」。
   *
   * 落定 = 提炼成功（state=ok）**或** 放弃重试（error 且已超过重试上限）。
   * 它们都不再需要后台做事；返回值和 ids.length 相等就说明没有活可干了。
   *
   * 注意「已提炼」的判据与 /list 一致：state=ok 即算成功，**不能**只看摘要
   * 文件在不在 —— 「只留摘要」的会话摘要被清掉后，文件没了但状态仍是 ok。
   */
  const countSettled = (ids) => {
    const sessions = loadKeeperState();
    return ids.filter((id) => {
      const s = sessions[id];
      if (!s) return false; // 从没处理过 → 还没落定
      if (s.status === 'ok') return true; // 提炼成功
      if (s.status === 'missing') return true; // 原文没了，keeper 会清掉它
      if (s.status === 'error') return (s.attempts || 0) >= MAX_RETRY_ATTEMPTS;
      return false;
    }).length;
  };

  /**
   * 启动一次提炼子进程。
   * @returns {boolean} 真的启动了返回 true；已在运行 / 启动失败返回 false。
   * 返回值让调用方（/run 路由）能如实回复前端，避免「假装成功」造成界面假死。
   */
  const runKeeper = (args) => {
    if (running) {
      log('提炼已在进行中，跳过本次触发');
      return false;
    }
    running = true;
    log(`启动提炼: ${args.join(' ') || '(增量)'}`);
    let child;
    try {
      child = spawn(process.execPath, [KEEPER, ...args], {
        cwd: ROOT,
        windowsHide: true,
        // 子进程自己会把完整的 stdout/stderr 追加到 state/keeper.log（见 keeper.cjs
        // 的 createLogger）。这里额外捕获一份，用于在进程异常退出时把尾部错误
        // 回写到宿主日志，避免 stdio:'ignore' 时代「只看到没反应、查不到原因」。
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: false,
      });
    } catch (err) {
      running = false;
      log(`启动失败: ${err?.message || err}`);
      return false;
    }
    let tail = '';
    const keepTail = (buf) => {
      tail = (tail + String(buf)).slice(-2000);
    };
    child.stdout?.on('data', keepTail);
    child.stderr?.on('data', keepTail);
    child.on('exit', (code) => {
      running = false;
      if (code !== 0) {
        log(`提炼进程异常退出 (exit=${code})，尾部输出: ${tail.trim().split('\n').slice(-6).join(' | ')}`);
      } else {
        log(`提炼结束 (exit=${code})`);
      }
    });
    child.on('error', (err) => {
      running = false;
      log(`提炼进程错误: ${err?.message || err}`);
    });
    return true;
  };

  const tick = () => {
    try {
      const ids = readArchivedIds();
      const key = [...ids].sort().join('|');
      if (key !== lastArchivedKey) {
        lastArchivedKey = key;

        // ── 有变化就跑一次增量提炼 ──────────────────────────────────────
        // 原先只在「归档列表变长」时才触发（key.length > lastArchivedKey.length），
        // 于是取消归档、删除、恢复等**长度不变或变短**的变化都不会触发；
        // 而且失败（error）不加 --retry-failed 就不会重来。现在：
        //   · 列表只要有任何变化（增/减/换）就触发一次；
        //   · 增量跑本身会处理所有「该做还没做」的会话；
        //   · 失败的重试次数由 keeper 自己按次数上限控制，不会无限死循环，
        //     所以这里可以直接带上 --retry-failed。
        log(`检测到归档列表变化（共 ${ids.length} 个），自动触发提炼`);
        runKeeper(['--retry-failed']);
        return;
      }

      // ── 列表没变，但可能还有「该提炼却没提炼」的会话 ──────────────────
      // 例如：上次触发时正好有别的提炼在跑（runKeeper 被跳过）、
      // 或提炼失败后配额恢复。这里按固定间隔兜底补跑，保证最终自动收敛，
      // 用户永远不需要手动点。
      if (!running) {
        const ids2 = readArchivedIds();
        const settled = countSettled(ids2);
        if (settled < ids2.length) {
          log(`还有 ${ids2.length - settled} 个会话未处理，自动补跑`);
          runKeeper(['--retry-failed']);
        }
      }
    } catch (err) {
      log(`监听出错: ${err?.message || err}`);
    }
  };

  tick();
  timer = setInterval(tick, POLL_MS);
  ctx.on?.('dispose', () => {
    try {
      clearInterval(timer);
    } catch {
      /* ignore */
    }
  });

  // ── 2. HTTP 路由：供对话头部面板读写 ───────────────────────────────────
  const webServer = ctx.webServer;
  if (!webServer || typeof webServer.register !== 'function') {
    log('webServer 不可用，仅保留后台提炼能力');
    return;
  }

  const sendJson = (res, code, obj) => {
    res.statusCode = code;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify(obj));
  };

  const readBody = (req) =>
    new Promise((resolve) => {
      let raw = '';
      req.on('data', (c) => {
        raw += c;
        if (raw.length > 1e6) raw = raw.slice(0, 1e6);
      });
      req.on('end', () => resolve(raw));
      req.on('error', () => resolve(''));
    });

  const listDigests = () => {
    const dir = path.join(ROOT, 'digests');
    let files = [];
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
    } catch {
      return [];
    }
    return files
      .map((f) => readJsonSafe(path.join(dir, f), null))
      .filter(Boolean)
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  };

  /**
   * 只列出摘要文件的 **会话 id**，不解析内容。
   * 用于实时计数：比 listDigests() 轻得多（避免每次 /list 都读几百个 JSON）。
   */
  const listDigestIds = () => {
    const dir = path.join(ROOT, 'digests');
    try {
      return fs
        .readdirSync(dir)
        .filter((f) => f.endsWith('.json'))
        .map((f) => f.slice(0, -'.json'.length));
    } catch {
      return [];
    }
  };

  /**
   * 读取 keeper 的处理状态（state/state.json）。
   *
   * 用来识别「无法提炼」的会话：原文已被用户删除（missing）或提炼失败（error）。
   * 这类会话不再计入「待提炼」，也不再被自动重试 —— 否则界面上的待提炼数字
   * 永远降不到 0，看起来像卡住（2026-10-03 修）。
   */
  const loadKeeperState = () => {
    const j = readJsonSafe(path.join(ROOT, 'state', 'state.json'), null);
    return j && typeof j === 'object' && j.sessions ? j.sessions : {};
  };

  /** 该会话是否为「终态」——再跑也不会成功。 */
  const isUnprocessable = (rec) => !!rec && (rec.status === 'missing' || rec.status === 'error');

  /**
   * 按会话 id 找它磁盘上的 session.v4.jsonl.zstd 绝对路径；找不到返回 null。
   * 与 keeper 侧 state.cjs 的同名逻辑保持一致（会话可能落在任意工作区目录下）。
   */
  const findSessionFileSync = (sessionId) => {
    const base = path.join(DSH_HOME, 'sessions');
    let ws = [];
    try {
      ws = fs.readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory());
    } catch {
      return null;
    }
    for (const d of ws) {
      const f = path.join(base, d.name, sessionId, 'session.v4.jsonl.zstd');
      try {
        if (fs.existsSync(f)) return f;
      } catch {
        /* 单个目录读不到就跳过 */
      }
    }
    return null;
  };

  const statSize = (file) => {
    try {
      return fs.statSync(file).size;
    } catch {
      return 0;
    }
  };

  // GET /archive-keeper/list —— 全部摘要 + 选择状态 + 原文/回收站情况
  webServer.register({
    kind: 'exact',
    path: `${BASE}/list`,
    handler: async (req, res) => {
      try {
        const raw = decisions ? decisions.load() : { items: {} };
        const digests = listDigests();
        const trash = decisions ? decisions.listTrash() : [];
        // 回收站按 id 聚合：原文副本与摘要副本分开看
        const fileById = new Map();
        const digestById = new Map();
        for (const t of trash) {
          const m = t.kind === 'digest' ? digestById : fileById;
          const cur = m.get(t.id);
          if (!cur || (t.at || '') > (cur.at || '')) m.set(t.id, t);
        }

        const build = (d) => {
          const rec = raw.items?.[d.id] || {};
          const decision = decisions ? decisions.normalize(rec.decision) : 'keepBoth';
          const filePath = d.filePath || '';
          const exists = filePath ? fs.existsSync(filePath) : false;
          const trashedFile = fileById.get(d.id) || null;
          const trashedDigest = digestById.get(d.id) || null;
          const digestPresent = decisions ? decisions.digestExists(d.id) : true;

          // ── 自定义价值（首要判断） ──
          // 已有标签（手工） + 自动规则打上的标签；命中收纳规则 = 优先纳入「值得留存」。
          const manual = tags ? tags.getLabels(d.id) : [];
          const ev = tags
            ? tags.evaluate(d, manual)
            : { labels: manual, customKeep: false, ruleHit: [], autoHit: [], hasCustom: false };
          const customKeep = ev.customKeep;
          const defaultKeep = d.reusable === true;
          // 收纳口径：有自定义规则时，规则是首要判断；否则完全按默认。
          const wantKeep = ev.hasCustom ? customKeep || defaultKeep : defaultKeep;

          // 「已保留·已精简」：原文在回收站，可以恢复原文
          const canRestore = decision === 'keepSummary' && !!trashedFile;
          // 「已删除」：摘要（和/或原文）在回收站里，可以按被删前的状态恢复
          const canRestoreDeleted = decision === 'deleted' && (!!trashedDigest || !!trashedFile);

          return {
            id: d.id,
            title: d.title || '(无标题)',
            summary: d.summary || '',
            category: d.category || 'trivial',
            reusable: d.reusable,
            // 自定义价值
            labels: ev.labels || [],
            customKeep,
            defaultKeep,
            wantKeep,
            ruleHit: ev.ruleHit || [],
            autoHit: ev.autoHit || [],
            hasCustom: !!ev.hasCustom,
            createdAt: d.createdAt || null,
            generatedAt: d.generatedAt || null,
            keyPoints: d.keyPoints || [],
            decisions: d.decisions || [],
            facts: d.facts || [],
            deliverables: d.deliverables || [],
            openThreads: d.openThreads || [],
            obsolete: d.obsolete || [],
            userTurnCount: d.userTurnCount || 0,
            filePath,
            fileExists: exists,
            fileSize: exists ? statSize(filePath) : d.fileSize || 0,
            decision,
            decidedAt: rec.decidedAt || null,
            deletedAt: rec.deletedAt || null,
            prevDecision: rec.prevDecision || null,
            // 恢复相关
            canRestore,
            canRestoreDeleted,
            digestPresent,
            digestTrashed: !!trashedDigest,
            trashedAt: trashedFile?.at || null,
            trashedBytes: trashedFile?.bytes || 0,
            trashPath: trashedFile?.to || null,
            // 「原文不在了、但回收站也没有」= 数据已彻底失去
            lost: !exists && !trashedFile && decision === 'keepSummary',
          };
        };

        // 摘要还在的会话
        const liveItems = digests.map(build);

        // 已删除的会话：摘要文件已经不在 digests/ 了，靠决策记录 + 回收站兜出来，
        // 否则「已删除」列表会是空的。
        const liveIds = new Set(digests.map((d) => d.id));
        const deletedItems = [];
        for (const [id, rec] of Object.entries(raw.items || {})) {
          if (decisions.normalize(rec.decision) !== 'deleted') continue;
          if (liveIds.has(id)) continue; // 理论上不该同时存在，双保险
          const trashedFile = fileById.get(id) || null;
          const trashedDigest = digestById.get(id) || null;
          const manualD = tags ? tags.getLabels(id) : [];
          deletedItems.push({
            id,
            title: rec.title || `(已删除 ${id.slice(0, 12)}…)`,
            summary: '',
            category: rec.category || 'trivial',
            reusable: null,
            labels: manualD,
            customKeep: false,
            defaultKeep: false,
            wantKeep: false,
            ruleHit: [],
            autoHit: [],
            hasCustom: false,
            createdAt: rec.createdAt || null,
            generatedAt: null,
            keyPoints: [],
            decisions: [],
            facts: [],
            deliverables: [],
            openThreads: [],
            obsolete: [],
            userTurnCount: 0,
            filePath: rec.filePath || '',
            fileExists: false,
            fileSize: 0,
            decision: 'deleted',
            decidedAt: rec.decidedAt || null,
            deletedAt: rec.deletedAt || null,
            prevDecision: rec.prevDecision || 'keepBoth',
            canRestore: false,
            canRestoreDeleted: !!(trashedDigest || trashedFile),
            digestPresent: false,
            digestTrashed: !!trashedDigest,
            trashedAt: trashedFile?.at || null,
            trashedBytes: trashedFile?.bytes || 0,
            trashPath: trashedFile?.to || null,
            lost: false,
          });
        }

        // ── 提炼失败的会话（error）────────────────────────────────────────
        // error 的会话也要出现在插件里，让用户自己决定去留。
        //
        // 这些会话**没有摘要文件**（提炼没成功），所以既不在 liveItems 里
        // （那是从 digests/ 推出来的），也不在 deletedItems 里（那是决策=deleted）。
        // 必须单独兜出来，否则它们在界面上完全不可见 —— 用户就无从处理。
        //
        // 注意：只兜 error，不兜 missing —— missing 的原文已经没了，
        // keeper 会自动把它们的归档记录清掉。
        //
        // 只在**自动重试已用尽**时才兜出来。还有重试机会的 error 视为
        // 「待提炼」（后台马上会重试），不该在界面上提前报失败打扰用户。
        const archivedIdsForErr = readArchivedIds();
        const keeperSessionsForErr = loadKeeperState();
        // 注意：这里**不能**引用下面才声明的 items —— 用已算好的两个数组建已知集合。
        const knownIds = new Set([...liveItems, ...deletedItems].map((it) => it.id));
        const errorItems = [];
        for (const id of archivedIdsForErr) {
          if (knownIds.has(id)) continue; // 已有摘要 → 当正常条目处理
          const rec = keeperSessionsForErr[id];
          if (!rec || rec.status !== 'error') continue;
          if ((rec.attempts || 0) < MAX_RETRY_ATTEMPTS) continue; // 还能自动重试，先不报失败
          const filePath = findSessionFileSync(id) || '';
          errorItems.push({
            id,
            title: rec.title || `(提炼失败 ${id.slice(0, 12)}…)`,
            summary: '',
            category: rec.category || 'trivial',
            reusable: rec.reusable ?? null,
            labels: [],
            customKeep: false,
            defaultKeep: false,
            wantKeep: false,
            ruleHit: [],
            autoHit: [],
            hasCustom: false,
            createdAt: rec.processedAt || null,
            generatedAt: null,
            keyPoints: [],
            decisions: [],
            facts: [],
            deliverables: [],
            openThreads: [],
            obsolete: [],
            userTurnCount: 0,
            filePath,
            fileExists: !!filePath,
            fileSize: filePath ? statSize(filePath) : 0,
            decision: decisions ? decisions.normalize(raw.items?.[id]?.decision) : 'keepBoth',
            decidedAt: raw.items?.[id]?.decidedAt || null,
            deletedAt: null,
            prevDecision: raw.items?.[id]?.prevDecision || null,
            canRestore: false,
            canRestoreDeleted: false,
            digestPresent: false,
            digestTrashed: false,
            trashedAt: null,
            trashedBytes: 0,
            trashPath: null,
            lost: false,
            // ── 给前端的提炼失败标记 ──
            failed: true,
            failureReason: rec.error || '提炼失败',
            failedAt: rec.processedAt || null,
          });
        }

        const items = [...liveItems, ...deletedItems, ...errorItems];

        const stateSessions = readJsonSafe(path.join(ROOT, 'state', 'state.json'), { sessions: {} });

        // ── 实时计数（不再只报历史累计）────────────────────────────────────
        // 口径：一律以**当前归档列表**为准，跟着「还有哪些归档会话」走。
        //   archivedTotal  归档总数 = 当前归档列表里的会话数（取消归档/删除后立刻减少）
        //   processedTotal 已提炼   = 归档列表中已生成摘要的数量（摘要被删掉也会跟着降）
        //   pendingTotal   待提炼   = 归档总数 - 已提炼
        // 三者恒自洽（archived = processed + pending）。
        //
        // 注意：不能拿 items.length 当归档总数 —— items 是由摘要文件推导出来的，
        // 一个「刚归档、还没来得及提炼」的会话不在 items 里，但它确实已归档。
        const archivedIdsNow = readArchivedIds();
        const digestIdsNow = new Set(listDigestIds()); // 只读一次目录，避免逐个 stat
        const archivedTotalNow = archivedIdsNow.length;
        // keeper 的状态记录（{id: {status, ...}}）。必须在 isProcessed 之前取，
        // 否则下面引用它会踩 TDZ。
        const keeperSessions = loadKeeperState();

        // ── 「已提炼」的判据 ────────────────────────────────────────────
        // 原先只看「摘要文件在不在」，于是「只留摘要」的会话被清掉原文后，
        // 摘要文件也一并被移除，就被算成「没提炼过」→ 永远挂在「待提炼」里降不到 0。
        //
        // 正确判据是 **keeper 的状态记录说了算**：
        //   status === 'ok'    → 提炼完成过（无论摘要后来是否被清理）→ 计入「已提炼」
        //   有摘要文件          → 同样计入（兜底：老记录缺 state 时靠它不丢数）
        // 只有既没有 state 记录、也没有摘要文件的，才是真的还没提炼。
        const isProcessed = (id) => keeperSessions[id]?.status === 'ok' || digestIdsNow.has(id);
        const processedTotalNow = archivedIdsNow.filter(isProcessed).length;
        // ── 「提炼失败」与「无法提炼」是两个不同的数 ──────────────────────
        //   failedTotal      提炼失败 = error **且已自动重试到上限**，
        //                    原文还在但一直失败，需要用户自己处置（删除）
        //   unprocessableTotal 无法提炼 = missing，原文已没了、注定提炼不了
        //
        // 提炼改为全自动后，error 还有重试机会时**不该**算失败 ——
        // 否则后台还在重试，界面已经报「提炼失败」，用户会以为要自己动手。
        // 只有重试次数用光（attempts >= MAX_RETRY_ATTEMPTS）才是真正的「失败」。
        // 在此之前它算「待提炼」——后台马上会重试它。
        //
        // 二者都从「待提炼」里扣除，否则数字永远降不到 0，看起来像卡住。
        const isExhaustedError = (id) => {
          const s = keeperSessions[id];
          return (
            !isProcessed(id) &&
            s?.status === 'error' &&
            (s.attempts || 0) >= MAX_RETRY_ATTEMPTS
          );
        };
        const failedIdsNow = archivedIdsNow.filter(isExhaustedError);
        const failedTotalNow = failedIdsNow.length;
        const unprocessableIdsNow = archivedIdsNow.filter(
          (id) => !isProcessed(id) && keeperSessions[id]?.status === 'missing',
        );
        const unprocessableTotalNow = unprocessableIdsNow.length;
        // 待提炼的总数用「总数 - 已落定的」算，保证和 countSettled 的口径一致，
        // 四个数字恒自洽（archived = processed + pending + failed + unprocessable）。
        const pendingTotalNow = Math.max(
          0,
          archivedTotalNow - processedTotalNow - unprocessableTotalNow - failedTotalNow,
        );

        sendJson(res, 200, {
          ok: true,
          root: ROOT,
          // 实时口径（新）：三个数字自洽，且随归档/取消归档/删除同步变化
          archivedTotal: archivedTotalNow,
          processedTotal: processedTotalNow,
          pendingTotal: pendingTotalNow,
          // 提炼失败（error）：原文还在，用户可自选「彻底删除」
          failedTotal: failedTotalNow,
          // 无法提炼（missing）：原文已删，keeper 会自动清掉，一般为 0
          unprocessableTotal: unprocessableTotalNow,
          // 历史累计（保留供参考，界面上不作为主指标）
          historyArchivedTotal: archivedIdsNow.length,
          historyProcessedTotal: Object.keys(stateSessions.sessions || {}).length,
          running,
          items,
          trash: {
            count: trash.length,
            bytes: trash.reduce((a, b) => a + (b.bytes || 0), 0),
            items: trash.map((t) => ({ id: t.id, kind: t.kind, at: t.at, bytes: t.bytes })),
          },
          // 自定义价值规则：齿轮面板用
          customization: tags
            ? {
                available: true,
                hasCustom: tags.hasCustomization(),
                tags: tags.load().tags,
                auto: tags.load().auto,
                rules: tags.load().rules,
                presets: { tags: tags.PRESET_TAGS, categories: tags.PRESET_CATEGORIES },
              }
            : { available: false, hasCustom: false, tags: [], auto: [], rules: [], presets: { tags: [], categories: [] } },
        });
      } catch (err) {
        sendJson(res, 500, { ok: false, error: String(err?.message || err) });
      }
    },
  });

  // ══ 自定义价值规则（「值得留存」的齿轮）══════════════════════════════
  // GET /archive-keeper/customize —— 读全部标签与规则
  webServer.register({
    kind: 'exact',
    path: `${BASE}/customize`,
    handler: async (req, res) => {
      try {
        if (!tags) return sendJson(res, 500, { ok: false, error: 'tags.cjs 未加载' });
        const d = tags.load();
        return sendJson(res, 200, {
          ok: true,
          tags: d.tags,
          labels: d.labels,
          auto: d.auto,
          rules: d.rules,
          hasCustom: tags.hasCustomization(),
          presets: { tags: tags.PRESET_TAGS, categories: tags.PRESET_CATEGORIES },
        });
      } catch (err) {
        return sendJson(res, 500, { ok: false, error: String(err?.message || err) });
      }
    },
  });

  // POST /archive-keeper/tag —— 标签集合的增删 + 给会话打/取消标签
  //   { action:'add',    name, color?, note? }
  //   { action:'remove', name }
  //   { action:'label',  id, name, on }
  webServer.register({
    kind: 'exact',
    path: `${BASE}/tag`,
    handler: async (req, res) => {
      try {
        if (!tags) return sendJson(res, 500, { ok: false, error: 'tags.cjs 未加载' });
        const body = JSON.parse((await readBody(req)) || '{}');
        const { action } = body;
        if (action === 'add') {
          if (!body.name || !String(body.name).trim()) {
            return sendJson(res, 400, { ok: false, error: '需要标签名 name' });
          }
          const t = tags.addTag(body.name, body.color, body.note);
          return sendJson(res, 200, { ok: true, tag: t });
        }
        if (action === 'remove') {
          if (!body.name) return sendJson(res, 400, { ok: false, error: '需要标签名 name' });
          tags.removeTag(body.name);
          return sendJson(res, 200, { ok: true });
        }
        if (action === 'label') {
          if (!body.id || !body.name) {
            return sendJson(res, 400, { ok: false, error: '需要 id 与 name' });
          }
          // 打标签前必须确认这个标签存在，避免出现孤儿标签
          const known = tags.load().tags.some((t) => t.name === body.name);
          if (!known) return sendJson(res, 400, { ok: false, error: `标签「${body.name}」不存在，请先添加` });
          const labels = tags.setLabel(body.id, body.name, !!body.on);
          return sendJson(res, 200, { ok: true, labels });
        }
        return sendJson(res, 400, { ok: false, error: 'action 需要是 add | remove | label' });
      } catch (err) {
        return sendJson(res, 500, { ok: false, error: String(err?.message || err) });
      }
    },
  });

  // POST /archive-keeper/rule —— 收纳规则 / 自动打标签规则的增删改
  //   { action:'add',    kind:'auto'|'rules', rule:{ tag?, note?, match } }
  //   { action:'update', id, patch:{ enabled?, tag?, note?, match? } }
  //   { action:'remove', id }
  webServer.register({
    kind: 'exact',
    path: `${BASE}/rule`,
    handler: async (req, res) => {
      try {
        if (!tags) return sendJson(res, 500, { ok: false, error: 'tags.cjs 未加载' });
        const body = JSON.parse((await readBody(req)) || '{}');
        if (body.action === 'add') {
          const kind = body.kind === 'auto' ? 'auto' : 'rules';
          const rec = tags.addRule(kind, body.rule || {});
          return sendJson(res, 200, { ok: true, rule: rec });
        }
        if (body.action === 'update') {
          if (!body.id) return sendJson(res, 400, { ok: false, error: '需要规则 id' });
          const rec = tags.updateRule(body.id, body.patch || {});
          return sendJson(res, 200, { ok: true, rule: rec });
        }
        if (body.action === 'remove') {
          if (!body.id) return sendJson(res, 400, { ok: false, error: '需要规则 id' });
          return sendJson(res, 200, { ok: true, ...tags.removeRule(body.id) });
        }
        return sendJson(res, 400, { ok: false, error: 'action 需要是 add | update | remove' });
      } catch (err) {
        return sendJson(res, 500, { ok: false, error: String(err?.message || err) });
      }
    },
  });

  // POST /archive-keeper/decide —— 记录「保留原文 / 只留摘要」，并按需执行删除
  webServer.register({
    kind: 'exact',
    path: `${BASE}/decide`,
    handler: async (req, res) => {
      try {
        const bodyRaw = await readBody(req);
        const body = JSON.parse(bodyRaw || '{}');
        const { id, decision } = body;
        if (!id || !['keepBoth', 'keepSummary'].includes(decision)) {
          return sendJson(res, 400, {
            ok: false,
            error: '参数不合法：需要 id 与 keepBoth|keepSummary',
          });
        }
        if (!decisions) {
          return sendJson(res, 500, { ok: false, error: 'decisions 模块未加载' });
        }

        if (decision === 'keepBoth') {
          // 不删任何东西，只标记。
          decisions.setDecision(id, 'keepBoth');
          return sendJson(res, 200, { ok: true, decision, note: '原文未改动' });
        }

        // decision === 'keepSummary'：先移入回收站，再记录。
        let purgeResult = { status: 'skipped' };
        try {
          purgeResult = decisions.purge(id);
        } catch (err) {
          return sendJson(res, 500, { ok: false, error: `移入回收站失败: ${err?.message || err}` });
        }
        decisions.setDecision(id, 'keepSummary', purgeResult.status);
        return sendJson(res, 200, {
          ok: true,
          decision,
          purge: purgeResult,
          restorable: purgeResult.status === 'purged' || purgeResult.status === 'already-purged',
        });
      } catch (err) {
        sendJson(res, 500, { ok: false, error: String(err?.message || err) });
      }
    },
  });

  // POST /archive-keeper/restore —— 从回收站恢复原文
  webServer.register({
    kind: 'exact',
    path: `${BASE}/restore`,
    handler: async (req, res) => {
      try {
        const bodyRaw = await readBody(req);
        const body = JSON.parse(bodyRaw || '{}');
        const { id } = body;
        if (!id) return sendJson(res, 400, { ok: false, error: '缺少 id' });
        if (!decisions) return sendJson(res, 500, { ok: false, error: 'decisions 模块未加载' });

        let result;
        try {
          result = decisions.restore(id);
        } catch (err) {
          return sendJson(res, 500, { ok: false, error: `恢复失败: ${err?.message || err}` });
        }
        if (result.status === 'restored') {
          decisions.setDecision(id, 'keepBoth', 'restored');
          return sendJson(res, 200, { ok: true, ...result });
        }
        return sendJson(res, 200, {
          ok: false,
          ...result,
          error:
            result.status === 'no-backup'
              ? '回收站里已没有这份原文，无法恢复'
              : result.status === 'occupied'
                ? '原位置已被占用，未做覆盖'
                : '未知状态',
        });
      } catch (err) {
        sendJson(res, 500, { ok: false, error: String(err?.message || err) });
      }
    },
  });

  // POST /archive-keeper/hard-delete —— 彻底删除：原文 + 摘要都进回收站，进入「已删除」
  webServer.register({
    kind: 'exact',
    path: `${BASE}/hard-delete`,
    handler: async (req, res) => {
      try {
        const bodyRaw = await readBody(req);
        const body = JSON.parse(bodyRaw || '{}');
        const { id } = body;
        if (!id) return sendJson(res, 400, { ok: false, error: '缺少 id' });
        if (!decisions) return sendJson(res, 500, { ok: false, error: 'decisions 模块未加载' });

        let result;
        try {
          result = decisions.hardDelete(id);
        } catch (err) {
          return sendJson(res, 500, { ok: false, error: `彻底删除失败: ${err?.message || err}` });
        }
        if (result.status === 'error') return sendJson(res, 500, { ok: false, ...result });
        return sendJson(res, 200, { ok: true, ...result, restorable: true });
      } catch (err) {
        sendJson(res, 500, { ok: false, error: String(err?.message || err) });
      }
    },
  });

  // POST /archive-keeper/restore-deleted —— 从「已删除」恢复，回到被删前的状态
  webServer.register({
    kind: 'exact',
    path: `${BASE}/restore-deleted`,
    handler: async (req, res) => {
      try {
        const bodyRaw = await readBody(req);
        const body = JSON.parse(bodyRaw || '{}');
        const { id } = body;
        if (!id) return sendJson(res, 400, { ok: false, error: '缺少 id' });
        if (!decisions) return sendJson(res, 500, { ok: false, error: 'decisions 模块未加载' });

        let result;
        try {
          result = decisions.restoreDeleted(id);
        } catch (err) {
          return sendJson(res, 500, { ok: false, error: `恢复失败: ${err?.message || err}` });
        }
        return sendJson(res, 200, { ok: true, ...result });
      } catch (err) {
        sendJson(res, 500, { ok: false, error: String(err?.message || err) });
      }
    },
  });

  // GET /archive-keeper/trash —— 回收站清单（供「清空」前确认）
  webServer.register({
    kind: 'exact',
    path: `${BASE}/trash`,
    handler: async (req, res) => {
      try {
        const items = decisions ? decisions.listTrash() : [];
        sendJson(res, 200, {
          ok: true,
          count: items.length,
          bytes: items.reduce((a, b) => a + (b.bytes || 0), 0),
          items,
        });
      } catch (err) {
        sendJson(res, 500, { ok: false, error: String(err?.message || err) });
      }
    },
  });

  // POST /archive-keeper/empty-trash —— 真删回收站（不可逆，需 confirm:true）
  webServer.register({
    kind: 'exact',
    path: `${BASE}/empty-trash`,
    handler: async (req, res) => {
      try {
        const bodyRaw = await readBody(req);
        const body = JSON.parse(bodyRaw || '{}');
        if (body.confirm !== true) {
          return sendJson(res, 400, {
            ok: false,
            error: '这是不可逆删除，必须显式 confirm: true',
          });
        }
        if (!decisions) return sendJson(res, 500, { ok: false, error: 'decisions 模块未加载' });
        const result = decisions.emptyTrash(body.ids);
        return sendJson(res, 200, { ok: true, ...result });
      } catch (err) {
        sendJson(res, 500, { ok: false, error: String(err?.message || err) });
      }
    },
  });

  // ── 「立即重新提炼」(/run) 与「单条重试」(/retry) 路由已移除 ─────────
  // 提炼改为全自动，不要手动按钮：
  //   · /run   —— 原先给面板上的「立即重新提炼」按钮用，按钮已删；
  //   · /retry —— 原先给「提炼失败」卡片上的「重新提炼」按钮用，
  //               该按钮已删，重试改由后台自动完成（tick 里按变化 / 未落定自动补跑）。
  // 保留它们等于留了一个没有调用方、却仍能启动提炼的入口，徒增风险，故一并删掉。
  // 需要人工干预时删掉「提炼失败」条目即可（/drop-failed，仍在下文注册）。

  // POST /archive-keeper/drop-failed —— 把「提炼失败」的会话彻底删掉
  //
  // 提炼失败的会话，用户也能选择直接删除。
  //
  // 与「彻底删除」条目的语义不同：这里删的是一个**从来没提炼成功过**的归档会话，
  // 它没有摘要可删。所以做两件事：
  //   1) 从 DSH 归档列表移除该 id（复用 keeper 的清理逻辑，会先备份 workspace.json）
  //   2) 抹掉 keeper 状态里那条 error 记录
  //
  // 注意：它**不走 decisions 的回收站**。回收站存的是「原文/摘要的副本」，
  // 而这儿的会话原文并不归插件管（DSH 自己的会话数据）。
  webServer.register({
    kind: 'exact',
    path: `${BASE}/drop-failed`,
    handler: async (req, res) => {
      try {
        const bodyRaw = await readBody(req);
        const body = JSON.parse(bodyRaw || '{}');
        const { id } = body;
        if (!id) return sendJson(res, 400, { ok: false, error: '缺少 id' });
        if (!/^session-[A-Za-z0-9-]+$/.test(id)) {
          return sendJson(res, 400, { ok: false, error: 'id 格式不合法' });
        }
        const archivedNow = readArchivedIds();
        if (!archivedNow.includes(id)) {
          return sendJson(res, 400, { ok: false, error: '该会话不在归档列表里' });
        }
        const recBefore = loadKeeperState()[id];
        if (!recBefore || recBefore.status !== 'error') {
          return sendJson(res, 400, { ok: false, error: '该会话当前不是「提炼失败」状态' });
        }
        // 与界面口径保持一致 —— 还能自动重试的 error 不算「失败」，
        // 不该给用户「删掉它」的选择（后台马上会重试它，删了就白删）。
        if ((recBefore.attempts || 0) < MAX_RETRY_ATTEMPTS) {
          return sendJson(res, 400, {
            ok: false,
            error: `该会话还在自动重试中（已试 ${recBefore.attempts || 0} 次），暂不能删除`,
          });
        }

        // 调 keeper 的清理入口：只删这一条，且只删 error 状态的那条
        const out = spawnSync(
          process.execPath,
          [KEEPER, '--drop-failed', id],
          { encoding: 'utf8', timeout: 60000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
        );
        const okOut = out.status === 0 && /已删除/.test(out.stdout || '');
        if (!okOut) {
          return sendJson(res, 500, {
            ok: false,
            error: `删除失败: ${(out.stderr || out.stdout || '').slice(0, 300) || '未知原因'}`,
          });
        }
        // 立刻回报新的剩余数量，前端好更新
        const remain = readArchivedIds().filter((x) => loadKeeperState()[x]?.status === 'error');
        sendJson(res, 200, { ok: true, id, failedTotal: remain.length });
      } catch (err) {
        sendJson(res, 500, { ok: false, error: String(err?.message || err) });
      }
    },
  });

  log(`路由已挂载于 ${BASE}（工作区 ${ROOT}）`);
}

export default { name, inject, apply };
