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
    throw new Error(`提炼结果不是合法 JSON: ${body.slice(0, 400)}`);
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

  const result = st.withLock(() => {
    const state = st.loadState();
    const archived = st.readArchivedIds();

    let targets;
    if (forceId) {
      targets = [forceId];
    } else if (opts.all) {
      targets = archived;
    } else {
      targets = archived.filter((id) => {
        const s = state.sessions[id];
        return !s || s.status !== 'ok';
      });
    }

    console.log(`[keeper] 归档总数=${archived.length} 待处理=${targets.length}`);
    const results = [];
    let i = 0;
    for (const id of targets) {
      i++;
      process.stdout.write(`[keeper] (${i}/${targets.length}) ${id} … `);
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
      console.log(rec.status === 'ok' ? `ok [${rec.category || '-'}]` : `${rec.status}: ${rec.error || ''}`);
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
    console.log(`[keeper] 跳过：${result.reason}`);
    return;
  }
  console.log(`[keeper] 完成，摘要总数=${result.digests.length}`);
}

if (require.main === module) main();
