#!/usr/bin/env node
/**
 * keeper.cjs — 归档守护主流程。
 *
 * 阶段：
 *   1. 扫描：对比 DSH 归档列表 vs 本地已处理记录，找出「待处理」的新归档。
 *   2. 抽取：解压会话文件，拉出可读对话脉络（lib/extract.cjs）。
 *   3. 提炼：调用 dsh headless 让模型把脉络压成结构化要点，落盘到 digests/。
 *   4. 报告：写 state/latest.json 供侧边栏插件读取。
 *
 * 绝不自动删除任何「有用的」东西：
 *   · 会话原文、摘要、用户决策记录，一律不动。
 *   · 唯一会自动清理的是「原文已不存在、永远提炼不了」的归档记录
 *     （见 main() 里的自动清理段，可用 --no-purge 关闭）。
 *   · 删除摘要原文等操作仍只在用户显式同意后执行。
 *
 * 用法:
 *   node keeper.cjs              # 增量处理新归档的会话
 *   node keeper.cjs --all        # 重跑全部归档会话的提炼
 *   node keeper.cjs --no-llm     # 只抽取不调模型（离线自检用）
 *   node keeper.cjs --force <id> # 强制重跑某一个会话
 *   node keeper.cjs --no-purge   # 不自动清理「原文已删」的归档记录
 */
'use strict';

// 抑制 Node 对 shell:true 的 DEP0190 弃用告警。这里无法避免 shell：
// Windows 上 `dsh` 只有 .ps1/.cmd 包装脚本，spawnSync 需要 shell 才能解析；
// 而告警文字走 stderr，会被调用方（插件/计划任务）误当成失败。
process.removeAllListeners('warning');
process.on('warning', () => {});

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const st = require('./state.cjs');
const ex = require('./extract.cjs');

const HEADLESS_PROFILE = process.env.ARCHIVE_KEEPER_PROFILE || 'headless';

/**
 * 把若干会话 id 从 DSH 的归档列表里移除，让它们**彻底不再出现在插件里**。
 *
 * 用户要求（2026-10-03）：「无法提炼的直接删除，不用出现在插件里」。
 *
 * 安全设计（这是全项目唯一的不可逆写入，必须极度保守）：
 *   · 只动 `global.archivedSessionIds`，其他字段原样保留、整体读改写；
 *   · 写入前先备份一份 `workspace.json.bak-archive-keeper`（§2 留退路）；
 *   · 先写临时文件再 rename，避免半个 JSON 落盘把 DSH 配置写坏；
 *   · 只删传入的 id，任何不在集合里的一律不动；
 *   · 出任何错都返回 0，绝不让清理失败影响提炼主流程。
 *
 * @returns {number} 实际移除的条数
 */
function removeFromArchiveList(idsToRemove) {
  // 安全闸：只有在「数据根 = 真实数据根」时才允许改 DSH 的归档列表。
  //
  // 沙盒测试会设 ARCHIVE_KEEPER_ROOT 指向临时目录；此时若还去写真实的
  // workspace.json，就会在用户真实配置上做试验（2026-10-03 事故的根因之一）。
  // 所以：一旦 ARCHIVE_KEEPER_ROOT 被设过，就默认不碰真实归档列表；
  // 沙盒要验证这个行为，需显式设 ARCHIVE_KEEPER_ALLOW_ARCHIVE_WRITE=1
  // （沙盒同时会设假的 DSH_HOME，所以写的是假文件）。
  if (process.env.ARCHIVE_KEEPER_ROOT && process.env.ARCHIVE_KEEPER_ALLOW_ARCHIVE_WRITE !== '1') {
    return 0;
  }

  const file = path.join(
    process.env.DSH_HOME || path.join(process.env.USERPROFILE || '', '.dsh'),
    'storages',
    'workspace.json',
  );
  try {
    if (!fs.existsSync(file)) return 0;
    const raw = fs.readFileSync(file, 'utf8');
    const j = JSON.parse(raw);
    if (!j?.global || !Array.isArray(j.global.archivedSessionIds)) return 0;

    const before = j.global.archivedSessionIds;
    const after = before.filter((id) => !idsToRemove.has(id));
    const removed = before.length - after.length;
    if (removed === 0) return 0;

    // 留退路：备份原文件（不覆盖已有备份，避免把好备份盖成坏的）
    const bak = file + '.bak-archive-keeper';
    if (!fs.existsSync(bak)) fs.writeFileSync(bak, raw, 'utf8');

    j.global.archivedSessionIds = after;
    const tmp = file + '.tmp-archive-keeper';
    fs.writeFileSync(tmp, JSON.stringify(j, null, 2), 'utf8');
    fs.renameSync(tmp, file);
    return removed;
  } catch {
    return 0;
  }
}

/**
 * 终态：这些会话**再也无法提炼**，不该被反复重试。
 *
 * 背景（2026-10-03 修）：原先「待处理」的判据是 `s.status !== 'ok'`，而：
 *   - `missing`：会话原文已被用户删除（在插件里彻底删除 / 清空回收站）→ 读不到文件；
 *   - `error`  ：提炼失败（如模型输出被截断）。
 * 两者都满足 `!== 'ok'`，于是**每次**跑 keeper 都会重新尝试、再次失败、再记一次同样的
 * 状态 —— 死循环。表现是界面「待提炼 N」永远降不到 0，点「重新提炼」像是卡住了
 * （实际是 keeper 起来后立刻发现全是注定失败的活，秒退）。
 *
 * 现在把这两类记为终态：默认不再自动重试，但**用户仍可用 `--force <id>` 手动单条重试**
 * （例如模型输出截断是一次性故障，值得再试一次）。
 */
const TERMINAL_STATUSES = ['missing', 'error'];
const isTerminal = (s) => !!s && TERMINAL_STATUSES.includes(s.status);

/**
 * 一条会话最多自动重试几次（2026-10-04）。
 *
 * 背景：提炼改为全自动后，宿主会在归档列表变化 / 有未落定会话时自动补跑。
 * 一条「永远失败」的会话（比如模型额度彻底用尽）如果不封顶，后台就会无限
 * 重跑 —— 既浪费额度也刷日志。到达上限后它仍留在「提炼失败」分组里等用户
 * 处置（删除），只是不再被自动重试。
 */
const MAX_ATTEMPTS = Number(process.env.ARCHIVE_KEEPER_MAX_ATTEMPTS) || 3;

/** 该会话是否还需要（自动）处理。 */
const needsWork = (s) => {
  if (!s) return true; // 从未处理过
  if (s.status === 'ok') return false; // 已成功
  if (s.status === 'missing') return false; // 原文没了，注定提炼不了
  if (s.status === 'error') return (s.attempts || 0) < MAX_ATTEMPTS; // 失败但还有重试机会
  return true;
};

/**
 * keeper 的日志出口。
 *
 * 背景（2026-10-03 修）：子进程原先用 `stdio:'ignore'` 启动，崩溃 / 报错信息全部丢弃，
 * 界面那边只能看到「没反应」，排查全靠手动重跑。现在把 stdout+stderr 追加到
 * `state/keeper.log`（同时保留控制台输出），出错时有据可查。
 */
function createLogger(enabled) {
  const file = path.join(st.ROOT, 'state', 'keeper.log');
  let stream = null;
  if (enabled) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      // 日志轮转：超过 1 MB 就留最后 2000 行重写，避免无限增长。
      try {
        const sz = fs.statSync(file).size;
        if (sz > 1024 * 1024) {
          const lines = fs.readFileSync(file, 'utf8').split('\n');
          fs.writeFileSync(file, lines.slice(-2000).join('\n'), 'utf8');
        }
      } catch {
        /* 文件不存在或读不了：忽略 */
      }
      // 必须显式指定 utf8：Windows 上不指定会按 latin1 落盘，中文全变乱码
      // （2026-10-03 实测：日志里「归档总数」写成了「褰掓。鎬绘暟」）。
      stream = fs.createWriteStream(file, { flags: 'a', encoding: 'utf8' });
      stream.on('error', () => {
        stream = null; // 日志写不了也不能影响主流程
      });
    } catch {
      stream = null;
    }
  }
  const stamp = () => new Date().toISOString();
  const write = (line) => {
    const text = String(line);
    if (stream) {
      try {
        stream.write(text + '\n');
      } catch {
        /* ignore */
      }
    }
    process.stdout.write(text + '\n');
  };
  return {
    open: () => write(`\n===== keeper 启动于 ${stamp()} pid=${process.pid} args=${process.argv.slice(2).join(' ') || '(增量)'} =====`),
    log: (m) => write(`[keeper] ${m}`),
    /** 顶行输出，用于「(1/5) xxx … ok」这种不换行的进度。 */
    progress: (m) => {
      if (stream) {
        try {
          stream.write(`[keeper] ${m}`);
        } catch {
          /* ignore */
        }
      }
      process.stdout.write(`[keeper] ${m}`);
    },
    close: () => {
      if (stream) {
        try {
          stream.end();
        } catch {
          /* ignore */
        }
        stream = null;
      }
    },
  };
}

/** 调用 dsh headless 做一次提炼，返回解析后的 JSON 或抛出错误。 */
function refineWithLLM(digestText, meta) {
  // ── 提示词（2026-10-04 重写，目标是「提炼效果」）──────────────────────
  // 相比旧版的改动意图：
  //   1. 给**判断标准 + 正反例**，而不只是字段说明 —— 模型在「什么算要点」
  //      上的自由度太大，是输出质量不稳的主因。
  //   2. 明确要求**自足**：每条要点单独拿出来也能看懂（不写「上面那个文件」这种
  //      依赖上下文的指代），因为摘要是脱离对话被单独阅读的。
  //   3. 明确要求**可执行**：保留具体的路径、命令、参数、数字、报错原文，
  //      不要把这些「压缩」成抽象概括 —— 这是归档摘要最大的价值所在。
  //   4. 明确**抓用户意图与偏好**（用户说了什么、纠正了什么、明确不要什么），
  //      这类信息最值得跨会话复用。
  //   5. 显式禁止套话（「讨论了…」「进行了…」）和无信息量的空话。
  const prompt = [
    '你是一个会话归档整理员。下面给你一段已经归档的 DSH（DeepSeek Harness）会话脉络。',
    '你的任务：把它压缩成一份**自足、可操作、未来能直接复用**的结构化要点。',
    '这份要点将来会被单独拿出来读（看不到原对话），所以要写得让人一眼看懂、拿来就能用。',
    '',
    '【写作要求】',
    '1. 自足：每条要点单独拿出来也能读懂。不要写「上述文件」「那个方案」这类依赖上下文的指代，',
    '   要写清是哪个文件、哪个方案。',
    '2. 具体：保留关键路径、命令、参数、版本号、数字、报错原文。',
    '   宁可留一个具体的文件名，也不要写「修改了相关配置」这种空话。',
    '3. 有用：只写「以后可能用得上」的信息。凡是看过就忘、对将来没有任何帮助的，一律丢掉。',
    '4. 不编造：只根据脉络里真实出现过的内容写。不确定的宁可不写。',
    '5. 不写套话：禁止「讨论了…」「进行了…」「用户询问了…」这类零信息量的句子。',
    '   要写就写结论本身。',
    '',
    '【特别注意抓这几类信息】',
    '- 用户明确表达的偏好 / 习惯 / 禁忌（例如「不要 XX」「我更喜欢 YY」）——最值得跨会话复用。',
    '- 用户做过的纠正或不满（说明之前哪里做错了，避免以后再犯）。',
    '- 本机环境事实（路径、版本、端口、账号归属等稳定事实）。',
    '- 明确做出的技术决策，以及**为什么**这么定。',
    '- 产出/改动过的文件的绝对路径。',
    '- 踩过的坑与解法（报错原文 + 最终怎么解决的）。',
    '- 没做完、以后要接着做的事。',
    '',
    '【输出格式】',
    '严格只输出一个 JSON 对象。不要任何解释文字，不要 markdown 代码围栏，不要在 JSON 前后加任何东西。',
    '',
    '{',
    '  "summary": "一句话说清这段会话到底在做什么、结论是什么（60字以内，要具体，不要「讨论了XX」）",',
    '  "category": "decision|preference|fact|lesson|deliverable|todo|trivial 七选一",',
    '  "keyPoints": ["核心要点，每条独立可读、自足。最多8条，按重要性排序"],',
    '  "decisions": ["明确做出的决定/选择，带上理由"],',
    '  "facts": ["关于本机环境、用户偏好、项目约定的稳定事实"],',
    '  "deliverables": ["产出或修改的文件的绝对路径"],',
    '  "openThreads": ["未完成、以后可能要接着做的事"],',
    '  "obsolete": ["已过时/已作废、明确可以不要的内容"],',
    '  "reusable": true 或 false',
    '}',
    '',
    '【reusable 怎么判断】',
    '- false（不值得留存）：纯寒暄、纯问答没有结论、一次性排错且已彻底解决且没什么可复用的、',
    '  内容完全是重复的闲聊。这类同时把 category 设为 "trivial"。',
    '- true（值得留存）：含环境事实、用户偏好、可复用教训、明确决策、未完成事项、产出文件路径的。',
    '',
    '【category 怎么选】',
    '  decision  = 做了技术/方案决策        preference = 反映了用户偏好或习惯',
    '  fact      = 记录了一个稳定的事实      lesson     = 踩坑与教训，可复用',
    '  deliverable = 产出了文件或成果        todo        = 有未完成的事项',
    '  trivial   = 没什么留存价值',
    '',
    '【示例】',
    '差（套话、无信息量）：{"summary":"讨论了插件安装问题","keyPoints":["排查了报错","进行了修复"]}',
    '好（具体、可复用）：{"summary":"修复 DSH 客户端插件缺少 inject 导出导致前端启动失败的问题",',
    '  "keyPoints":["lib/client.js 必须同时导出 apply 和 inject（inject 是数组），不能导出 default",',
    '    "缺少 inject 时 apply 会在 ctx.slots 未就绪时被调用，前端报 web boot: entry did not activate"]}',
    '',
    '没有内容的字段给空数组 []，不要编造。reusable 必须是 true 或 false 的布尔值。',
    '',
    '=== 会话脉络 ===',
    digestText,
  ].join('\n');

  const tmp = path.join(st.ROOT, 'state', '.prompt.txt');
  fs.mkdirSync(path.dirname(tmp), { recursive: true });
  fs.writeFileSync(tmp, prompt, 'utf8');

  // 注意：本机 dsh 是 .ps1/.cmd 包装脚本，必须经 shell 启动；但 shell:true 会让
  // 参数里的中文被 cmd.exe 的代码页破坏（实测乱码）。因此提示词一律走 stdin，
  // 命令行只留纯 ASCII 的 '-'。stdin 传输不受 shell 代码页影响。
  // 另外把 stderr 合并进 stdout：否则 Node 的 DEP0190 弃用告警会污染 stderr，
  // 让调用方误判为失败（退出码看起来正常但管道上有红色输出）。
  const r = spawnSync('dsh', ['--profile', HEADLESS_PROFILE, '-'], {
    input: prompt,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    shell: true,
    timeout: 15 * 60 * 1000,
    windowsHide: true,
    env: { ...process.env, NODE_NO_WARNINGS: '1' },
  });

  const out = (r.stdout || '').trim();
  if (!out) {
    throw new Error(`headless 无输出 (status=${r.status}) ${(r.stderr || '').slice(0, 400)}`);
  }

  // 容忍模型包了代码围栏
  let body = out;
  const fence = body.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) body = fence[1];
  const first = body.indexOf('{');
  const last = body.lastIndexOf('}');
  if (first >= 0 && last > first) body = body.slice(first, last + 1);

  try {
    return JSON.parse(body);
  } catch (err) {
    // 模型输出被 maxBuffer / 长度上限截断是常见故障（2026-10-03 实测一次），
    // 直接判失败会让整个会话白跑一趟。这里尝试抢救：把末尾不完整的部分补全后重新解析。
    const salvaged = trySalvageJson(body);
    if (salvaged) return salvaged;
    throw new Error(`提炼结果不是合法 JSON: ${body.slice(0, 400)}`);
  }
}

/**
 * 抢救被截断的 JSON。
 *
 * 思路：从字符串流的角度扫描，跟踪「是否在字符串里 / 是否被转义 / 括号栈」，
 * 丢弃最后一个不完整的成员，然后把仍然打开的括号按栈补全。
 * 例如 `{"summary":"a","keyPoints":["x","y` → 丢弃残缺的 `"y` 并补成合法对象。
 */
function trySalvageJson(body) {
  const s = body;
  if (!s || s[0] !== '{') return null;

  const stack = [];
  let inStr = false;
  let esc = false;
  let lastSafe = -1; // 最后一个「后面可以安全截断」的位置（逗号或完整的 } / ]）

  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') {
        inStr = false;
        // 字符串刚闭合，若处于「键值对值」位置，这里也可能是安全截断点
        lastSafe = i + 1;
      }
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{' || c === '[') stack.push(c === '{' ? '}' : ']');
    else if (c === '}' || c === ']') {
      stack.pop();
      lastSafe = i + 1;
      if (!stack.length) return safeParse(s.slice(0, i + 1));
    } else if (c === ',') lastSafe = i; // 逗号本身不保留
  }

  if (lastSafe <= 0) return null;
  // 截到最后一个安全点，再去掉尾部悬空的逗号或「有键无值」的半个成员。
  // 注意两种形态都要处理：
  //   `...,"category":`  → lastSafe 落在引号后，会剩下 `...,"category"`（无冒号）
  //   `...,"category"`   → 同上
  let cut = s.slice(0, lastSafe).replace(/[,\s]+$/, '');
  cut = cut.replace(/,\s*"(?:[^"\\]|\\.)*"\s*:?\s*$/, '');
  if (/^\{\s*"(?:[^"\\]|\\.)*"\s*:?\s*$/.test(cut)) return null; // 只剩下一个空壳键
  // 重新计算此刻仍未闭合的括号
  const st2 = [];
  let inStr2 = false;
  let esc2 = false;
  for (const c of cut) {
    if (inStr2) {
      if (esc2) esc2 = false;
      else if (c === '\\') esc2 = true;
      else if (c === '"') inStr2 = false;
      continue;
    }
    if (c === '"') inStr2 = true;
    else if (c === '{') st2.push('}');
    else if (c === '[') st2.push(']');
    else if (c === '}' || c === ']') st2.pop();
  }
  if (inStr2) return null;
  cut += st2.reverse().join('');
  return safeParse(cut);
}

function safeParse(text) {
  try {
    const j = JSON.parse(text);
    return j && typeof j === 'object' && !Array.isArray(j) ? j : null;
  } catch {
    return null;
  }
}

function processOne(sessionId, opts) {
  const file = st.findSessionFile(sessionId);
  if (!file) {
    return { id: sessionId, status: 'missing', error: '会话文件不在磁盘上' };
  }

  let digestText;
  let raw;
  try {
    const events = ex.readEvents(file);
    if (!events.length) return { id: sessionId, status: 'error', error: '解压后无事件' };
    raw = ex.summarize(events);
    digestText = ex.toDigestText(raw);
  } catch (err) {
    return { id: sessionId, status: 'error', error: `抽取失败: ${err.message}` };
  }

  // 无真实用户发言 → 空会话，不值得调模型
  if (raw.userTurns.length === 0) {
    const rec = {
      id: sessionId,
      status: 'ok',
      generatedAt: new Date().toISOString(),
      title: raw.title,
      createdAt: raw.createdAt,
      fileSize: fs.statSync(file).size,
      filePath: file,
      summary: '（空会话：没有真实用户发言）',
      category: 'trivial',
      keyPoints: [],
      decisions: [],
      facts: [],
      deliverables: [],
      openThreads: [],
      obsolete: [],
      reusable: false,
      userTurnCount: 0,
      skippedLLM: true,
    };
    st.writeDigest(sessionId, rec);
    return rec;
  }

  if (opts.noLLM) {
    const rec = {
      id: sessionId,
      status: 'ok',
      generatedAt: new Date().toISOString(),
      title: raw.title,
      createdAt: raw.createdAt,
      fileSize: fs.statSync(file).size,
      filePath: file,
      summary: '(未调用模型)',
      category: 'trivial',
      keyPoints: [],
      decisions: [],
      facts: [],
      deliverables: raw.deliverables,
      openThreads: [],
      obsolete: [],
      reusable: null,
      userTurnCount: raw.userTurns.length,
      skippedLLM: true,
      rawText: digestText,
    };
    st.writeDigest(sessionId, rec);
    return rec;
  }

  let refined;
  try {
    refined = refineWithLLM(digestText, raw);
  } catch (err) {
    return { id: sessionId, status: 'error', error: err.message, title: raw.title };
  }

  const rec = {
    id: sessionId,
    status: 'ok',
    generatedAt: new Date().toISOString(),
    title: raw.title,
    createdAt: raw.createdAt,
    fileSize: fs.statSync(file).size,
    filePath: file,
    summary: refined.summary || '',
    category: st.CATEGORIES.includes(refined.category) ? refined.category : 'trivial',
    keyPoints: refined.keyPoints || [],
    decisions: refined.decisions || [],
    facts: refined.facts || [],
    deliverables: refined.deliverables || raw.deliverables || [],
    openThreads: refined.openThreads || [],
    obsolete: refined.obsolete || [],
    reusable: refined.reusable === true,
    userTurnCount: raw.userTurns.length,
  };
  st.writeDigest(sessionId, rec);
  return rec;
}

function main() {
  const args = process.argv.slice(2);

  // ── --drop-failed <id>：把一条「提炼失败」的归档会话彻底删掉 ─────────────
  // 用户要求（2026-10-03）：提炼失败的会话，用户也能选择直接删除。
  // 这是给插件 /drop-failed 路由用的专用入口，只处理 error 状态、只删一条。
  const dropIdx = args.indexOf('--drop-failed');
  if (dropIdx >= 0) {
    const id = args[dropIdx + 1];
    if (!id) {
      console.error('[keeper] --drop-failed 需要指定会话 id');
      process.exitCode = 1;
      return;
    }
    const done = st.withLock(() => {
      const state = st.loadState();
      const rec = state.sessions[id];
      // 安全闸：只允许删「提炼失败」的。ok / missing / 不存在一律拒绝，
      // 避免这个入口被误用成任意删除。
      if (!rec || rec.status !== 'error') {
        return { ok: false, reason: `会话 ${id} 当前不是「提炼失败」状态，拒绝删除` };
      }
      const removed = removeFromArchiveList(new Set([id]));
      if (!removed) return { ok: false, reason: '从归档列表移除失败（可能已不在列表里）' };
      delete state.sessions[id];
      st.saveState(state);
      return { ok: true };
    });
    if (!done || !done.ok) {
      console.error(`[keeper] ${done ? done.reason : '删除失败'}`);
      process.exitCode = 1;
      return;
    }
    console.log(`[keeper] 已删除提炼失败的归档会话 ${id}`);
    return;
  }

  const opts = {
    all: args.includes('--all'),
    noLLM: args.includes('--no-llm'),
  };
  const forceIdx = args.indexOf('--force');
  const forceId = forceIdx >= 0 ? args[forceIdx + 1] : null;
  // --retry-failed：把终态（missing / error）也纳入自动重试。
  // 默认不重试，避免「无法提炼的会话」被无限重试导致待提炼数字永远降不下去。
  opts.retryFailed = args.includes('--retry-failed');

  // 始终落盘：默认增量运行正是「点了重新提炼没反应」时最需要查的那种场景，
  // 只在 --all 时记日志等于把最需要证据的路径排除在外（2026-10-03 修）。
  // 想临时不写日志可用 --no-log。
  const log = createLogger(!args.includes('--no-log'));
  log.open();

  const result = st.withLock(() => {
    const state = st.loadState();
    const archived = st.readArchivedIds();

    let targets;
    if (forceId) {
      targets = [forceId];
    } else if (opts.all) {
      targets = archived;
    } else if (opts.retryFailed) {
      // 全自动模式（宿主默认带这个参数）：把「还能再试一次」的都纳入。
      // 成功过的不重跑；missing 不重跑；error 要在重试上限内才重跑。
      targets = archived.filter((id) => {
        const s = state.sessions[id];
        if (!s) return true; // 从没处理过 → 该做
        if (s.status === 'ok') return false; // 已成功
        if (s.status === 'missing') return false; // 原文没了，注定失败
        if (s.status === 'error') return (s.attempts || 0) < MAX_ATTEMPTS; // 失败但还有重试机会
        return true;
      });
    } else {
      // 默认：跳过终态（missing / error），否则每次都会重试注定失败的会话 → 死循环。
      targets = archived.filter((id) => needsWork(state.sessions[id]));
    }

    log.log(`归档总数=${archived.length} 待处理=${targets.length}`);

    // 无论本次有没有活干，都把「被跳过的无法提炼会话」说清楚 ——
    // 否则用户看到「待提炼 3 却永远不动」时会以为卡住了（2026-10-03 修）。
    const skippedTerminal = archived.filter((id) => isTerminal(state.sessions[id]));
    if (skippedTerminal.length) {
      const miss = skippedTerminal.filter((id) => state.sessions[id].status === 'missing').length;
      const errs = skippedTerminal.length - miss;
      const parts = [];
      if (miss) parts.push(`${miss} 个原文已删除`);
      if (errs) parts.push(`${errs} 个提炼失败（可重试）`);
      log.log(`已跳过 ${skippedTerminal.length} 个无法提炼的会话（${parts.join('、')}），不再自动重试`);
    }

    const results = [];
    let i = 0;
    for (const id of targets) {
      i++;
      log.progress(`(${i}/${targets.length}) ${id} … `);
      const rec = processOne(id, opts);
      results.push(rec);
      // ── 重试次数（2026-10-04）─────────────────────────────────────────
      // 全自动提炼后，失败会被后台自动重试。必须记次数并封顶，否则一条
      // 「永远失败」的会话会让后台无限空转。
      // 成功时清零；失败时累加，到达 MAX_ATTEMPTS 后宿主不再把它算成待办。
      const prev = state.sessions[id] || {};
      const attempts = rec.status === 'ok' ? 0 : (prev.attempts || 0) + 1;
      state.sessions[id] = {
        status: rec.status,
        error: rec.error || null,
        processedAt: new Date().toISOString(),
        reusable: rec.reusable,
        category: rec.category || null,
        title: rec.title || null,
        attempts,
      };
      st.saveState(state);
      log.log(
        rec.status === 'ok'
          ? `ok [${rec.category || '-'}]`
          : `${rec.status}: ${rec.error || ''}${
              attempts >= MAX_ATTEMPTS ? `（已重试 ${attempts} 次，不再自动重试）` : `（第 ${attempts} 次尝试）`
            }`,
      );
    }

    // ── 自动清理：原文已不在磁盘上的归档记录 ─────────────────────────────
    // 用户要求（2026-10-03）：无法提炼的直接删掉，不要出现在插件里。
    //
    // 必须放在处理循环**之后**：本次运行才刚发现「原文已删」的会话
    // （状态在循环里才写进 state），放在循环前会晚一轮才清理（2026-10-03 修）。
    //
    // 「无法提炼」有两种，只在**确实没救**时才动手：
    //   · missing（原文文件已不存在）→ 永远提炼不了，删掉归档记录 + 残留状态
    //   · error（模型报错）→ 可能是网络超时 / 额度用尽等**临时**故障，
    //                        删了就真没了，所以保留、仍可重试
    //
    // 二次确认：即使 state 里写着 missing，也再跑一次 findSessionFile。
    // 只有「状态说没了」且「现在确实还找不到」才删 —— 避免状态过期误删。
    // 用 --no-purge 可完全关闭这个行为。
    const purged = [];
    if (!args.includes('--no-purge')) {
      // 以最新的归档列表为准（前面可能已写过 state）
      const archivedNow = st.readArchivedIds();
      const purgedIds = [];
      let corrected = false;
      for (const id of archivedNow) {
        const rec = state.sessions[id];
        if (!rec || rec.status !== 'missing') continue;
        if (st.findSessionFile(id)) {
          // 文件其实还在 → 状态过期了，纠正它并重新排队，绝不删。
          log.log(`注意：${id} 状态标记为 missing，但会话文件仍在磁盘上 —— 已纠正，不删除`);
          rec.status = 'error';
          rec.error = '状态曾误标为 missing，实际文件仍在；已重新排队';
          corrected = true;
          continue;
        }
        purgedIds.push(id);
      }

      // 纠正结果也必须落盘，否则下次又看到同一条过期状态（2026-10-03 修）
      if (corrected && !purgedIds.length) st.saveState(state);

      if (purgedIds.length) {
        const set = new Set(purgedIds);
        // 1) 从 DSH 归档列表移除 —— 这是「不再出现在插件里」的关键一步
        const removedFromArchive = removeFromArchiveList(set);
        // 2) 抹掉 keeper 自己的状态记录
        for (const id of purgedIds) {
          delete state.sessions[id];
          purged.push(id);
        }
        // 状态清理必须落盘，否则下次运行又看到这些 missing 记录（2026-10-03 修）
        st.saveState(state);
        log.log(
          `已清理 ${purgedIds.length} 个原文已删除的归档记录` +
            `（归档列表移除 ${removedFromArchive} 个），这些会话不再出现在插件里`,
        );
      }
    }

    // 写一份汇总给插件读
    const digests = st.listDigests();
    // 清理后再读一次归档列表：否则 report.archivedTotal 会报清理前的旧值
    const archivedFinal = st.readArchivedIds();
    const report = {
      generatedAt: new Date().toISOString(),
      archivedTotal: archivedFinal.length,
      processedTotal: Object.keys(state.sessions).length,
      digests: digests.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)),
      errors: results.filter((r) => r.status !== 'ok'),
    };
    fs.mkdirSync(path.join(st.ROOT, 'state'), { recursive: true });
    fs.writeFileSync(path.join(st.ROOT, 'state', 'latest.json'), JSON.stringify(report, null, 2), 'utf8');
    return report;
  });

  if (result && result.skipped) {
    log.log(`跳过：${result.reason}`);
    log.close();
    return;
  }
  log.log(`完成，摘要总数=${result.digests.length}`);
  log.close();
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    // 顶层异常也落盘：否则 stdio:'ignore' 下用户完全看不到失败原因。
    try {
      const f = path.join(st.ROOT, 'state', 'keeper.log');
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.appendFileSync(f, `[keeper] 顶层异常: ${err && err.stack ? err.stack : err}\n`, 'utf8');
    } catch {
      /* ignore */
    }
    console.error('[keeper] 顶层异常:', err && err.stack ? err.stack : err);
    process.exitCode = 1;
  }
}
