/**
 * 将 cursor-agent stream-json 的 NDJSON 行解析为 OpenAI 风格的 SSE 事件内容。
 * 支持 type: assistant | result | message 及顶层 output/content/text，与 agent-runner 解析逻辑对齐。
 */

import { Transform } from 'stream';

/** 从单行 JSON 对象中抽出要作为 delta.content 的文本，与 agent-runner 的提取逻辑一致 */
function extractTextFromStreamLine(obj) {
  if (!obj || typeof obj !== 'object') return '';

  // type === 'assistant'：message.content 数组或字符串
  if (obj.type === 'assistant' && obj.message) {
    const content = obj.message.content;
    if (typeof content === 'string' && content.trim()) return content;
    if (Array.isArray(content)) {
      const parts = content.map((c) => (c && typeof c.text === 'string' ? c.text : (c && typeof c.content === 'string' ? c.content : '')) || '');
      const s = parts.join('').trim();
      if (s) return s;
    }
  }

  // type === 'result'：result 或 output/content/text
  if (obj.type === 'result') {
    const r = obj.result ?? obj.output ?? obj.content ?? obj.text;
    if (typeof r === 'string' && r.trim()) return r;
    if (r && typeof r === 'object' && !Array.isArray(r) && (r.text != null || r.content != null)) {
      const s = String(r.text ?? r.content ?? '').trim();
      if (s) return s;
    }
  }

  // type === 'message' 且 role 为 assistant
  if (obj.type === 'message' && String((obj.role || obj.message?.role) || '').toLowerCase() === 'assistant') {
    const content = obj.content ?? obj.message?.content ?? obj.text;
    if (typeof content === 'string' && content.trim()) return content;
    if (Array.isArray(content)) {
      const parts = content.map((c) => (c && typeof c.text === 'string' ? c.text : (c && typeof c.content === 'string' ? c.content : '')) || '');
      const s = parts.join('').trim();
      if (s) return s;
    }
  }

  // 顶层 output / content / text（cursor-agent 可能直接输出）
  const top = obj.output ?? obj.content ?? obj.text;
  if (typeof top === 'string' && top.trim()) return top;
  if (top && typeof top === 'object' && !Array.isArray(top) && (top.text != null || top.content != null)) {
    const s = String(top.text ?? top.content ?? '').trim();
    if (s) return s;
  }

  return '';
}

/**
 * 将 NDJSON 行转成 OpenAI chat completion chunk 的 data 行（不含 "data: " 前缀，不含 \n\n）。
 * @param {string} line
 * @param {object} meta { id, created, model }
 * @returns {string | null} 若无需发送则返回 null
 */
export function parseNdjsonLine(line, meta) {
  let obj;
  try {
    obj = JSON.parse(line);
  } catch (_) {
    return null;
  }

  const text = extractTextFromStreamLine(obj);
  if (!text) return null;

  const chunk = {
    id: meta.id,
    object: 'chat.completion.chunk',
    created: meta.created,
    model: meta.model,
    choices: [
      {
        index: 0,
        delta: { role: 'assistant', content: text },
        finish_reason: null,
      },
    ],
  };
  return JSON.stringify(chunk);
}

/** 若 accumulated + newText 形成「完全相同两段」，返回 false 表示不要转发 newText（并之后都不要再转发） */
function wouldBeDuplicated(accumulated, newText) {
  const next = accumulated + newText;
  if (next.length < 2) return false;
  const half = Math.floor(next.length / 2);
  return next.slice(0, half) === next.slice(half);
}

/**
 * 创建一个 Transform 流：输入为 NDJSON 行（Buffer/string），输出为 SSE 格式的字符串（data: {...}\n\n）。
 * 会做「整段重复」检测：若已转发的文本与即将转发的拼接后是 A+A，则不再转发后续内容（避免界面出现两遍相同回复）。
 * @param {object} meta { id, created, model }
 * @returns {Transform}
 */
export function createStreamParser(meta) {
  let buffer = '';
  let accumulatedText = '';
  let dedupeStopped = false;

  return new Transform({
    objectMode: false,
    transform(chunk, encoding, callback) {
      if (dedupeStopped) {
        callback();
        return;
      }
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const data = parseNdjsonLine(line.trim(), meta);
        if (data) {
          let text = '';
          try {
            const payload = JSON.parse(data);
            text = payload.choices?.[0]?.delta?.content ?? '';
          } catch (_) {}
          if (text && wouldBeDuplicated(accumulatedText, text)) {
            const next = accumulatedText + text;
            const half = Math.floor(next.length / 2);
            const toSend = half - accumulatedText.length;
            if (toSend > 0) {
              const partial = JSON.stringify({
                id: meta.id,
                object: 'chat.completion.chunk',
                created: meta.created,
                model: meta.model,
                choices: [{ index: 0, delta: { role: 'assistant', content: text.slice(0, toSend) }, finish_reason: null }],
              });
              this.push(`data: ${partial}\n\n`);
            }
            dedupeStopped = true;
            break;
          }
          if (text) accumulatedText += text;
          this.push(`data: ${data}\n\n`);
        }
      }
      callback();
    },
    flush(callback) {
      if (dedupeStopped) {
        callback();
        return;
      }
      if (buffer.trim() && !dedupeStopped) {
        const data = parseNdjsonLine(buffer.trim(), meta);
        if (data) {
          let text = '';
          try {
            const payload = JSON.parse(data);
            text = payload.choices?.[0]?.delta?.content ?? '';
          } catch (_) {}
          if (text && wouldBeDuplicated(accumulatedText, text)) {
            const next = accumulatedText + text;
            const half = Math.floor(next.length / 2);
            const toSend = half - accumulatedText.length;
            if (toSend > 0) {
              const partial = JSON.stringify({
                id: meta.id,
                object: 'chat.completion.chunk',
                created: meta.created,
                model: meta.model,
                choices: [{ index: 0, delta: { role: 'assistant', content: text.slice(0, toSend) }, finish_reason: null }],
              });
              this.push(`data: ${partial}\n\n`);
            }
          } else {
            this.push(`data: ${data}\n\n`);
          }
        }
      }
      callback();
    },
  });
}
