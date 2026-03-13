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

/**
 * 创建一个 Transform 流：输入为 NDJSON 行（Buffer/string），输出为 SSE 格式的字符串（data: {...}\n\n）。
 * @param {object} meta { id, created, model }
 * @returns {Transform}
 */
export function createStreamParser(meta) {
  let buffer = '';

  return new Transform({
    objectMode: false,
    transform(chunk, encoding, callback) {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const data = parseNdjsonLine(line.trim(), meta);
        if (data) {
          this.push(`data: ${data}\n\n`);
        }
      }
      callback();
    },
    flush(callback) {
      if (buffer.trim()) {
        const data = parseNdjsonLine(buffer.trim(), meta);
        if (data) this.push(`data: ${data}\n\n`);
      }
      callback();
    },
  });
}
