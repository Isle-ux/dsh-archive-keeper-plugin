#!/usr/bin/env node
/**
 * extract.cjs — 从 DSH 会话文件 (session.v4.jsonl.zstd) 中抽取可读对话脉络。
 *
 * 关键事实（本机实测）：
 *  - 会话文件是「多个 zstd 帧顺序拼接」，不是单个帧；Node 的
 *    zstdDecompressSync 只解第一帧（只得到 243 字节的 session 头）。
 *  - 因此必须按 magic number (28 B5 2F FD) 切分帧，逐帧解压再合并。
 *  - 帧内是 JSONL 事件流，事件类型见下 KEEP_TYPES。
 *
 * 用法:
 *   node extract.cjs <session.v4.jsonl.zstd> [--json]
 *   node extract.cjs --all [--json]        # 扫描全部会话
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/** 对提炼有用的高价值事件类型。 */
const KEEP_TYPES = new Set([
  'session',
  'session/title',
  'user/message',
  'assistant/message',
  'tool/call',
  'deliverables/presented',
  'goal/created',
  'goal/updated',
]);

/** 注入型系统提示，不算用户真实发言。 */
function isInjectedContext(text) {
  if (typeof text !== 'string') return true;
  const t = text.trimStart();
  return (
    t.startsWith('<system-reminder>') ||
    t.startsWith('Current runtime context.') ||
    t.startsWith('MNEMON RUNTIME MEMORY SNAPSHOT') ||
    t.startsWith('[MNEMON]') ||
    t.startsWith('Contents of USER.md') ||
    t.startsWith('This is an automatically generated checkpoint') ||
    t.startsWith('Bounded completed checkpoint') ||
    t.startsWith('background job pwsh-') // 工具通知，非用户发言
  );
}

/** 把 content 数组压平成纯文本。 */
function flattenContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const c of content) {
    if (!c) continue;
    if (typeof c === 'string') parts.push(c);
    else if (c.type === 'text' && typeof c.text === 'string') parts.push(c.text);
    else if (c.type === 'reasoning') continue; // 思维链不进摘要
  }
  return parts.join('\n').trim();
}

/** 按 magic 边界切帧并逐帧解压，返回事件数组。 */
function readEvents(file) {
  const buf = fs.readFileSync(file);
  const events = [];
  let start = 0;
  let guard = 0;
  while (start < buf.length && guard++ < 500000) {
    const next = buf.indexOf(ZSTD_MAGIC, start + 1);
    const slice = buf.subarray(start, next < 0 ? buf.length : next);
    try {
      const text = zlib.zstdDecompressSync(slice).toString('utf8');
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try {
          events.push(JSON.parse(line));
        } catch {
          /* 跳过坏行 */
        }
      }
    } catch {
      /* 跳过坏帧 */
    }
    if (next < 0) break;
    start = next;
  }
  return events;
}

/** 从事件流构造结构化摘要素材。 */
function summarize(events) {
  const head = events.find((e) => e.type === 'session') || {};
  const titleEv = events.find((e) => e.type === 'session/title');

  const userTurns = [];
  const assistantTurns = [];
  const deliverables = [];

  for (const e of events) {
    if (!KEEP_TYPES.has(e.type)) continue;
    const d = e.data || {};
    if (e.type === 'user/message') {
      const text = flattenContent(d.content);
      if (!text || isInjectedContext(text)) continue;
      if (d.source && d.source.kind && d.source.kind !== 'user') continue;
      userTurns.push({ seq: e.seq, time: e.time, text });
    } else if (e.type === 'assistant/message') {
      const m = d.message || {};
      const text = flattenContent(m.content);
      if (!text) continue;
      assistantTurns.push({ seq: e.seq, time: e.time, text });
    } else if (e.type === 'deliverables/presented') {
      const files = d.files || d.deliverables || [];
      for (const f of files) {
        deliverables.push(typeof f === 'string' ? f : f.path || JSON.stringify(f));
      }
    }
  }

  return {
    // 注意：这里**不能**引用 `file` —— 它是 readEvents() 的形参，不在本函数作用域里。
    // 原先写成 `head.id || path.basename(path.dirname(file))`，一旦 head.id 缺失
    // （会话文件损坏、或 session 事件被截断），就会抛
    // `ReferenceError: file is not defined`，整个会话白跑一趟并被记成 error。
    // 真实的 session 事件把 id 放在顶层（已核实），所以这条回退路径平时不会走到。
    // 2026-10-03 修：改用 events 里已知的可用信息，缺失时返回 null。
    id: head.id || head.sessionId || null,
    createdAt: head.createdAt || null,
    cwd: head.cwd || null,
    title: (titleEv && (titleEv.data ? titleEv.data.title : titleEv.title)) || null,
    eventCount: events.length,
    userTurns,
    assistantTurns,
    deliverables: [...new Set(deliverables)],
  };
}

/** 生成给人/LLM 读的精简文本。 */
function toDigestText(s) {
  const out = [];
  out.push('# 会话原始脉络（自动抽取，供提炼用）');
  out.push('');
  out.push(`- 会话 ID: ${s.id}`);
  out.push(`- 标题: ${s.title || '(无)'}`);
  out.push(`- 创建时间: ${s.createdAt ? new Date(s.createdAt).toISOString() : '?'}`);
  out.push(`- 事件总数: ${s.eventCount}`);
  out.push(`- 用户真实发言数: ${s.userTurns.length}`);
  out.push('');
  out.push('## 用户发言（按时间顺序）');
  if (!s.userTurns.length) out.push('(无)');
  for (const t of s.userTurns) {
    const one = t.text.replace(/\s+/g, ' ').trim();
    out.push(`- [${t.seq}] ${one.length > 500 ? one.slice(0, 500) + '…' : one}`);
  }
  out.push('');
  out.push('## 助手回复（仅尾部 12 条，去掉思维链）');
  const tail = s.assistantTurns.slice(-12);
  if (!tail.length) out.push('(无)');
  for (const t of tail) {
    const one = t.text.replace(/\s+/g, ' ').trim();
    out.push(`- [${t.seq}] ${one.length > 700 ? one.slice(0, 700) + '…' : one}`);
  }
  if (s.deliverables.length) {
    out.push('');
    out.push('## 交付物');
    for (const d of s.deliverables) out.push(`- ${d}`);
  }
  return out.join('\n');
}

function main() {
  const args = process.argv.slice(2);
  const asJson = args.includes('--json');
  const files = args.filter((a) => !a.startsWith('--'));

  if (!files.length) {
    console.error('usage: node extract.cjs <session.v4.jsonl.zstd> [--json]');
    process.exit(2);
  }

  const results = files.map((f) => {
    try {
      return summarize(readEvents(f));
    } catch (err) {
      return { id: path.basename(path.dirname(f)), error: String(err && err.message) };
    }
  });

  if (asJson) {
    process.stdout.write(JSON.stringify(results.length === 1 ? results[0] : results, null, 2));
  } else {
    for (const r of results) {
      if (r.error) {
        console.log(`!! ${r.id}: ${r.error}`);
        continue;
      }
      console.log(toDigestText(r));
      console.log('\n' + '='.repeat(60) + '\n');
    }
  }
}

if (require.main === module) main();

module.exports = { readEvents, summarize, toDigestText, flattenContent, isInjectedContext };
