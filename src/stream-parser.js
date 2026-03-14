/**
 * 将 cursor-agent stream-json 的 NDJSON 行解析为 OpenAI 风格的 SSE 事件内容。
 * 只关心 type === "assistant" 的 message.content[].text，拼成 delta.content。
 */

import { Transform } from 'stream';

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

  if (obj.type !== 'assistant') return null;

  const content = obj.message?.content;
  if (!content) return null;

  let text = '';
  if (Array.isArray(content)) {
    for (const c of content) {
      if (c && typeof c.text === 'string') text += c.text;
    }
  } else if (typeof content === 'string') {
    text = content;
  }

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
