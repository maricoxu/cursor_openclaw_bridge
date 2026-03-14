#!/usr/bin/env node
/**
 * 直接调用 cursor-agent 一次（与桥相同参数），收集原始 stdout（NDJSON），
 * 提取「助理回复」类文本并检查是否出现重复。用于排查「两遍」来自 Agent 还是上游。
 *
 * 用法：在 cursor-bridge 根目录执行
 *   node scripts/check-agent-raw-output.mjs
 *
 * 会写入 .cursor-agent-raw-stdout.txt，并打印是否在原始输出中发现重复。
 */

import { spawn } from 'child_process';
import { createReadStream, writeFileSync } from 'fs';
import { createInterface } from 'readline';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
dotenv.config({ path: path.join(root, '.env') });

const WORKSPACE = process.env.CURSOR_WORKSPACE || root;
const BIN = process.env.CURSOR_AGENT_BIN || 'cursor-agent';
const MODEL = process.env.CURSOR_AGENT_MODEL || '';
const EXTRA_ARGS = process.env.CURSOR_AGENT_EXTRA_ARGS || '--trust';
const TIMEOUT_MS = 60_000;

/** 从单行 JSON 提取「助理回复」文本（与 stream-parser 逻辑一致，不包含 thinking） */
function extractReplyText(obj) {
  if (!obj || typeof obj !== 'object') return '';
  const t = (obj.type || '').toString().toLowerCase();
  if (t === 'thinking' || t === 'reasoning' || t === 'thought') return '';

  if (obj.type === 'assistant' && obj.message) {
    const content = obj.message.content;
    if (typeof content === 'string' && content.trim()) return content;
    if (Array.isArray(content)) {
      const parts = content
        .filter((c) => ((c && (c.type || '').toString().toLowerCase()) || '') !== 'thinking' && ((c && (c.type || '').toString().toLowerCase()) || '') !== 'reasoning')
        .map((c) => (c && typeof c.text === 'string' ? c.text : (c && typeof c.content === 'string' ? c.content : '')) || '');
      return parts.join('').trim();
    }
  }
  if (obj.type === 'result') {
    const r = obj.result ?? obj.output ?? obj.content ?? obj.text;
    if (typeof r === 'string' && r.trim()) return r;
    if (r && typeof r === 'object' && !Array.isArray(r) && (r.text != null || r.content != null))
      return String(r.text ?? r.content ?? '').trim();
  }
  if (obj.type === 'message' && String((obj.role || obj.message?.role) || '').toLowerCase() === 'assistant') {
    const content = obj.content ?? obj.message?.content ?? obj.text;
    if (typeof content === 'string' && content.trim()) return content;
    if (Array.isArray(content)) {
      const parts = content
        .filter((c) => ((c && (c.type || '').toString().toLowerCase()) || '') !== 'thinking' && ((c && (c.type || '').toString().toLowerCase()) || '') !== 'reasoning')
        .map((c) => (c && typeof c.text === 'string' ? c.text : (c && typeof c.content === 'string' ? c.content : '')) || '');
      return parts.join('').trim();
    }
  }
  const top = obj.output ?? obj.content ?? obj.text;
  if (typeof top === 'string' && top.trim()) return top;
  if (top && typeof top === 'object' && !Array.isArray(top) && (top.text != null || top.content != null))
    return String(top.text ?? top.content ?? '').trim();
  return '';
}

/** 检测拼接后的回复是否包含「同一段话出现两遍」 */
function hasDuplicateParagraph(text, minLen = 40) {
  if (!text || text.length < minLen * 2) return false;
  const half = Math.floor(text.length / 2);
  if (text.slice(0, half) === text.slice(half)) return true;
  const trimmed = text.trim();
  const h = Math.floor(trimmed.length / 2);
  if (trimmed.slice(0, h) === trimmed.slice(h)) return true;
  for (let len = minLen; len <= Math.floor(text.length / 2); len++) {
    const sub = text.slice(0, len);
    const second = text.indexOf(sub, len);
    if (second !== -1 && second + len <= text.length && text.slice(second, second + len) === sub) return true;
  }
  return false;
}

const prompt = `[User]
你是什么模型`;

const args = [
  prompt,
  '--print',
  '--trust',
  '--output-format',
  'stream-json',
  '--stream-partial-output',
  '--workspace',
  WORKSPACE,
];
if (MODEL && MODEL.trim()) args.push('--model', MODEL.trim());
if (EXTRA_ARGS && EXTRA_ARGS.trim()) args.push(...EXTRA_ARGS.trim().split(/\s+/));

console.log('[check-agent] 调用 cursor-agent，prompt 首行:', prompt.split('\n')[0]);
console.log('[check-agent] workspace:', WORKSPACE);
console.log('[check-agent] 等待 stdout（最多 %d 秒）...', TIMEOUT_MS / 1000);

const proc = spawn(BIN, args, {
  cwd: WORKSPACE,
  shell: false,
  env: { ...process.env, PATH: process.env.PATH || '' },
});

let rawLines = [];
const timeout = setTimeout(() => {
  try { proc.kill('SIGKILL'); } catch (_) {}
  console.log('[check-agent] 已超时，使用已收集的输出做检查');
}, TIMEOUT_MS);

const rl = createInterface({ input: proc.stdout, crlfDelay: Infinity });
rl.on('line', (line) => rawLines.push(line));
rl.on('close', () => {
  clearTimeout(timeout);
  const raw = rawLines.join('\n');
  const outPath = path.join(root, '.cursor-agent-raw-stdout.txt');
  writeFileSync(outPath, raw, 'utf8');
  console.log('[check-agent] 原始 stdout 已写入:', outPath);

  let replyText = '';
  for (const line of rawLines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed);
      replyText += extractReplyText(obj);
    } catch (_) {}
  }

  const dup = hasDuplicateParagraph(replyText);
  console.log('[check-agent] 提取的回复长度:', replyText.length, '字符');
  console.log('[check-agent] 原始 stdout 中「回复」是否出现同一段两遍:', dup ? '是' : '否');
  if (dup) {
    console.log('[check-agent] 结论: 重复来自 Cursor Agent 侧，需从 Agent/模型或工作区配置排查');
  } else {
    console.log('[check-agent] 结论: 原始输出无重复，重复更可能来自：请求里 messages 重复，或 OpenClaw 发了两次请求');
  }
  if (replyText.length > 0) {
    console.log('[check-agent] 回复预览:', replyText.slice(0, 120) + (replyText.length > 120 ? '...' : ''));
  }
  process.exit(proc.exitCode ?? 0);
});

proc.stderr.on('data', (d) => process.stderr.write(d));
proc.on('error', (err) => {
  clearTimeout(timeout);
  console.error('[check-agent] 启动 cursor-agent 失败:', err.message);
  process.exit(1);
});
