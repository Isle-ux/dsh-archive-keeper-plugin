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
 * 绝不自动删除任何东西。删除只在用户显式同意后、由 prune.cjs 执行。
 *
 * 用法:
 *   node keeper.cjs              # 增量处理新归档的会话
 *   node keeper.cjs --all        # 重跑全部归档会话的提炼
 *   node keeper.cjs --no-llm     # 只抽取不调模型（离线自检用）
 *   node keeper.cjs --force <id> # 强制重跑某一个会话
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

/** 该会话是否还需要（自动）处理。 */
const needsWork = (s) => {
  if (!s) return true; // 从未处理过
  if (isTerminal(s)) return false; // 终态：不再自动重试
  return s.status !== 'ok';
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
  const prompt = [
    '你是归档整理员。下面是一段已归档的 DSH 会话脉络。',
    '请把它精炼成结构化要点，只保留「以后还可能用得上」的信息。',
    '严格只输出一个 JSON 对象，不要任何解释、不要 markdown 代码围栏。',
    '',
    'JSON 结构：',
    '{',
    '  "summary": "一句话概括这个会话在做什么（不超过60字）",',
    '  "category": "decision|preference|fact|lesson|deliverable|todo|trivial 之一",',
    '  "keyPoints": ["要点，每条独立可读，最多8条"],',
    '  "decisions": ["明确做出的决定/选择"],',
    '  "facts": ["关于本机环境、用户偏好、项目约定的稳定事实"],',
    '  "deliverables": ["产出或修改的文件绝对路径"],',
    '  "openThreads": ["未完成、以后可能要接着做的事"],',
    '  "obsolete": ["已过时/已作废、明确可以不要的内容"],',
    '  "reusable": true 或 false  // 是否值得长期留存',
    '}',
    '',
    '判断标准：',
    '- 纯寒暄、纯问答无结论、一次性排错且已解决的 → reusable=false, category="trivial"。',
    '- 含环境事实、用户偏好、可复用教训、或未完成事项的 → reusable=true。',
    '- 不要编造脉络里没有的信息。没有的字段给空数组。',
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
      targets = archived.filter((id) => {
        const s = state.sessions[id];
        return !s || (s.status !== 'ok' && !(s.status === 'missing' && !s.error));
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
      if (errs) parts.push(`${errs} 个提炼失败`);
      log.log(`已跳过 ${skippedTerminal.length} 个无法提炼的会话（${parts.join('、')}），不再自动重试`);
    }

    const results = [];
    let i = 0;
    for (const id of targets) {
      i++;
      log.progress(`(${i}/${targets.length}) ${id} … `);
      const rec = processOne(id, opts);
      results.push(rec);
      state.sessions[id] = {
        status: rec.status,
        error: rec.error || null,
        processedAt: new Date().toISOString(),
        reusable: rec.reusable,
        category: rec.category || null,
        title: rec.title || null,
      };
      st.saveState(state);
      log.log(rec.status === 'ok' ? `ok [${rec.category || '-'}]` : `${rec.status}: ${rec.error || ''}`);
    }

    // 写一份汇总给插件读
    const digests = st.listDigests();
    const report = {
      generatedAt: new Date().toISOString(),
      archivedTotal: archived.length,
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
