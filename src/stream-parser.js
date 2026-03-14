/**
 * 将 cursor-agent stream-json 的 NDJSON 行解析为 OpenAI 风格的 SSE 事件内容。
 * 支持 type: assistant | result | message 及顶层 output/content/text，与 agent-runner 解析逻辑对齐。
 * 过滤「思考/心跳指令」类内容，不展示给用户；可通过 CURSOR_STREAM_SHOW_THINKING=1 打开 thinking/reasoning 显示。
 * 对 Cursor 的 stream-json 语义做消费修正：stream-partial-output 下，partial assistant 已流出后，
 * 若后面又补发完整 assistant / result，不再重复转发，避免界面出现两遍相同回复。
 */

import { Transform } from 'stream';

/** 为 1 或 true 时，流式输出中保留 thinking/reasoning 内容（默认不保留） */
const SHOW_THINKING = process.env.CURSOR_STREAM_SHOW_THINKING === '1' || process.env.CURSOR_STREAM_SHOW_THINKING === 'true';

/** 仅心跳相关：始终过滤，不展示给用户 */
function isLikelyHeartbeat(text) {
  if (!text || typeof text !== 'string') return true;
  const t = text.trim();
  if (!t) return true;
  if (t.includes('Read HEARTBEAT.md') || t.includes('read HEARTBEAT.md')) return true;
  if (t.includes('Follow it strictly')) return true;
  if (t.includes('Current time:') && t.length < 120) return true;
  if (t.includes('Do not infer or repeat old tasks from prior chats')) return true;
  if (t.includes('use workspace file') && t.includes('HEARTBEAT.md')) return true;
  return false;
}

/** 模型内部思考类文案（仅当未开启 SHOW_THINKING 时过滤） */
function isLikelyThinkingOnly(text) {
  if (!text || typeof text !== 'string') return true;
  const t = text.trim();
  if (!t) return true;
  const lower = t.toLowerCase();
  if (lower.startsWith('the user is asking') || lower.startsWith('the user is sending')) return true;
  if (t.includes('from the openclaw-control-ui') && (t.includes('message') || t.includes('test') || t.includes('I should respond') || t.includes('persona'))) return true;
  if (t.includes('I should respond') || t.includes('as the Xiao Li persona') || t.includes("they're just saying")) return true;
  if (t.includes('There\'s no heartbeat instruction') || t.includes('I\'ll keep it short and natural')) return true;
  if (t.length > 80 && (lower.includes('this is a simple') || lower.includes('acknowledging the test'))) return true;
  return false;
}

/** 判断是否应过滤不展示：心跳始终过滤；thinking 仅在未开启 CURSOR_STREAM_SHOW_THINKING 时过滤 */
function isLikelyThinkingOrHeartbeat(text) {
  if (isLikelyHeartbeat(text)) return true;
  if (!SHOW_THINKING && isLikelyThinkingOnly(text)) return true;
  return false;
}

/** 从单行 JSON 对象中抽出要作为 delta.content 的文本。未开启 CURSOR_STREAM_SHOW_THINKING 时不抽取 thinking/reasoning 类。 */
function extractTextFromStreamLine(obj) {
  if (!obj || typeof obj !== 'object') return '';
  const t = (obj.type || '').toString().toLowerCase();
  if (!SHOW_THINKING && (t === 'thinking' || t === 'reasoning' || t === 'thought')) return '';

  // type === 'assistant'：message.content 数组或字符串
  if (obj.type === 'assistant' && obj.message) {
    const content = obj.message.content;
    if (typeof content === 'string' && content.trim()) return content;
    if (Array.isArray(content)) {
      const parts = content
        .filter((c) => { if (SHOW_THINKING) return true; const typ = (c && (c.type || '').toString().toLowerCase()) || ''; return typ !== 'thinking' && typ !== 'reasoning'; })
        .map((c) => (c && typeof c.text === 'string' ? c.text : (c && typeof c.content === 'string' ? c.content : '')) || '');
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
      const parts = content
        .filter((c) => { if (SHOW_THINKING) return true; const typ = (c && (c.type || '').toString().toLowerCase()) || ''; return typ !== 'thinking' && typ !== 'reasoning'; })
        .map((c) => (c && typeof c.text === 'string' ? c.text : (c && typeof c.content === 'string' ? c.content : '')) || '');
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

function normalizeForCompare(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

/** 若单块内容本身是 A+A（前半段与后半段相同或 trim 后相同），只保留一段，避免如天气回复整段重复两遍 */
function dedupeSelfRepeated(text) {
  if (!text || text.length < 2) return text;
  // 先尝试按 \n\n 拆成两段（整段+换行+整段）
  const parts = text.split(/\n\s*\n/);
  if (parts.length === 2) {
    const a = parts[0].trim();
    const b = parts[1].trim();
    if (a.length >= 20 && a === b) return a;
  }
  const half = Math.floor(text.length / 2);
  if (text.slice(0, half) === text.slice(half)) return text.slice(0, half);
  const left = text.slice(0, half).trim();
  const right = text.slice(half).trim();
  if (left.length >= 20 && left === right) return left;
  return text;
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

  let text = extractTextFromStreamLine(obj);
  if (!text) return null;
  if (isLikelyThinkingOrHeartbeat(text)) return null;
  text = dedupeSelfRepeated(text);

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
 * 不做去重，原样转发 cursor-agent 的输出（仅过滤 thinking/心跳）。
 * @param {object} meta { id, created, model }
 * @returns {Transform}
 */
export function createStreamParser(meta) {
  let buffer = '';
  let streamedAssistantText = '';

  return new Transform({
    objectMode: false,
    transform(chunk, encoding, callback) {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.trim()) continue;
        let obj;
        try {
          obj = JSON.parse(line.trim());
        } catch (_) {
          continue;
        }

        const text = extractTextFromStreamLine(obj);
        if (!text) continue;
        if (isLikelyThinkingOrHeartbeat(text)) continue;

        const kind = String(obj.type || '').toLowerCase();
        const normalizedText = normalizeForCompare(text);
        const normalizedAccumulated = normalizeForCompare(streamedAssistantText);

        // Cursor 在 --stream-partial-output 下会先发 partial assistant，再补发一次完整 assistant，
        // 最后 result 再给一遍完整文本。partial 已转发后，后两者应视为收尾事件而非正文。
        if ((kind === 'assistant' || kind === 'result') && normalizedAccumulated) {
          if (normalizedText === normalizedAccumulated || normalizedText.startsWith(normalizedAccumulated)) {
            continue;
          }
        }
        if (kind === 'result' && normalizedAccumulated) continue;

        const data = parseNdjsonLine(line.trim(), meta);
        if (!data) continue;

        if (kind === 'assistant') streamedAssistantText += text;
        if (kind === 'result' && !streamedAssistantText) streamedAssistantText = text;
        this.push(`data: ${data}\n\n`);
      }
      callback();
    },
    flush(callback) {
      if (buffer.trim()) {
        let obj;
        try {
          obj = JSON.parse(buffer.trim());
        } catch (_) {
          obj = null;
        }
        if (obj) {
          const text = extractTextFromStreamLine(obj);
          if (text && !isLikelyThinkingOrHeartbeat(text)) {
            const kind = String(obj.type || '').toLowerCase();
            const normalizedText = normalizeForCompare(text);
            const normalizedAccumulated = normalizeForCompare(streamedAssistantText);
            const isCompletionEcho =
              normalizedAccumulated &&
              (kind === 'assistant' || kind === 'result') &&
              (normalizedText === normalizedAccumulated || normalizedText.startsWith(normalizedAccumulated));
            if (!isCompletionEcho && !(kind === 'result' && normalizedAccumulated)) {
              const data = parseNdjsonLine(buffer.trim(), meta);
              if (data) this.push(`data: ${data}\n\n`);
            }
          }
        }
      }
      callback();
    },
  });
}
