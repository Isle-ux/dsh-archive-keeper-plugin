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
import { spawn } from 'node:child_process';
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
  const KEEPER = path.join(SELF_LIB, 'keeper.cjs');
  const POLL_MS = Number(config.pollMs) || 30000;

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

  const runKeeper = (args) => {
    if (running) {
      log('提炼已在进行中，跳过本次触发');
      return;
    }
    running = true;
    log(`启动提炼: ${args.join(' ') || '(增量)'}`);
    let child;
    try {
      child = spawn(process.execPath, [KEEPER, ...args], {
        cwd: ROOT,
        windowsHide: true,
        stdio: 'ignore',
        detached: false,
      });
    } catch (err) {
      running = false;
      log(`启动失败: ${err?.message || err}`);
      return;
    }
    child.on('exit', (code) => {
      running = false;
      log(`提炼结束 (exit=${code})`);
    });
    child.on('error', (err) => {
      running = false;
      log(`提炼进程错误: ${err?.message || err}`);
    });
  };

  const tick = () => {
    try {
      const ids = readArchivedIds();
      const key = [...ids].sort().join('|');
      if (key !== lastArchivedKey) {
        const grew = lastArchivedKey !== '' && key.length > lastArchivedKey.length;
        lastArchivedKey = key;
        if (grew) {
          log(`检测到新归档（共 ${ids.length} 个），开始自动提炼`);
          runKeeper([]);
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

        const items = [...liveItems, ...deletedItems];

        const stateSessions = readJsonSafe(path.join(ROOT, 'state', 'state.json'), { sessions: {} });
        sendJson(res, 200, {
          ok: true,
          root: ROOT,
          archivedTotal: readArchivedIds().length,
          processedTotal: Object.keys(stateSessions.sessions || {}).length,
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

  // POST /archive-keeper/run —— 面板上的「立即重新提炼」
  webServer.register({
    kind: 'exact',
    path: `${BASE}/run`,
    handler: async (req, res) => {
      try {
        const bodyRaw = await readBody(req);
        const body = JSON.parse(bodyRaw || '{}');
        runKeeper(body.all ? ['--all'] : []);
        sendJson(res, 200, { ok: true, started: true, running });
      } catch (err) {
        sendJson(res, 500, { ok: false, error: String(err?.message || err) });
      }
    },
  });

  log(`路由已挂载于 ${BASE}（工作区 ${ROOT}）`);
}

export default { name, inject, apply };
