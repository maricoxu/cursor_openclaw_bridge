/**
 * 将 cursor-agent stream-json 的 NDJSON 行解析为 OpenAI 风格的 SSE 事件内容。
 * 仅用于流式响应（客户端 stream: true 时）；非流式走 agent-runner 聚合 stdout，不经本模块。
 * 策略：不转发 assistant/message；只推送 type=result 整段作为最终输出。若开启 CURSOR_STREAM_SHOW_THINKING，
 * 则 type=thinking/reasoning/thought 会作为「前期输出」先推（可配前缀），result 再作为诊断/最终输出，体感更连贯。
 */

import { Transform } from 'stream';

/** 为 1 或 true 时，流式输出中保留 thinking/reasoning 内容（默认不保留），并作为「前期输出」先推，result 再作为最终输出 */
const SHOW_THINKING = process.env.CURSOR_STREAM_SHOW_THINKING === '1' || process.env.CURSOR_STREAM_SHOW_THINKING === 'true';
/** thinking 块前加的前缀，便于和最终 result 区分；空则不加 */
const THINKING_PREFIX = typeof process.env.CURSOR_STREAM_THINKING_PREFIX === 'string' ? process.env.CURSOR_STREAM_THINKING_PREFIX : '思考：';

/** 为 1 或 true 时，打印每行 type/长度，便于排查 */
const STREAM_DEBUG = /^(1|true|yes)$/i.test(process.env.CURSOR_BRIDGE_DEBUG || '');

/** 超时未收到 result/thinking 时先推的提示：毫秒数，0 或未设则关闭 */
const WAITING_MSG_AFTER_MS = Math.max(0, parseInt(process.env.CURSOR_STREAM_WAITING_MSG_AFTER_MS || '0', 10) || 0);
/** 超时提示文案，可被 CURSOR_STREAM_WAITING_MSG_TEXT 覆盖 */
const WAITING_MSG_TEXT = typeof process.env.CURSOR_STREAM_WAITING_MSG_TEXT === 'string'
  ? process.env.CURSOR_STREAM_WAITING_MSG_TEXT
  : '处理时间较长，请稍候。';

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

  if (obj.type === 'result') {
    const r = obj.result;
    if (typeof r === 'string' && r.trim()) return r;
    if (r && typeof r === 'object' && !Array.isArray(r) && (r.text != null || r.content != null)) {
      const s = String(r.text ?? r.content ?? '').trim();
      if (s) return s;
    }
  }

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

  if (t === 'thinking' || t === 'reasoning' || t === 'thought') {
    const c = obj.content ?? obj.text ?? '';
    return (typeof c === 'string' ? c : '').trim();
  }

  return '';
}

/** 拼出 OpenAI chunk 字符串 */
function buildChunkWithContent(meta, content) {
  const chunk = {
    id: meta.id,
    object: 'chat.completion.chunk',
    created: meta.created,
    model: meta.model,
    choices: [
      { index: 0, delta: { role: 'assistant', content }, finish_reason: null },
    ],
  };
  return JSON.stringify(chunk);
}

/**
 * 将 NDJSON 行转成 OpenAI chat completion chunk 的 data 行（供 parseNdjsonLine 等非流式用）。
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
  if (isLikelyThinkingOrHeartbeat(text)) return null;

  const chunk = {
    id: meta.id,
    object: 'chat.completion.chunk',
    created: meta.created,
    model: meta.model,
    choices: [
      { index: 0, delta: { role: 'assistant', content: text }, finish_reason: null },
    ],
  };
  return JSON.stringify(chunk);
}

const FALLBACK_PARSE_ERROR = '输出解析异常，未得到可展示内容。';
const FALLBACK_NO_CONTENT = '无可展示内容（可能仅为 heartbeat/thinking），请重试或检查 Cursor Agent。';

/**
 * 创建 Transform 流：只转发 type=result 的整段正文，不转发 assistant/message。
 * 无去重逻辑；若始终没有 result，在 flush 时推兜底文案。
 * 可选：CURSOR_STREAM_WAITING_MSG_AFTER_MS > 0 时，超时未收到任何可展示内容则先推「处理时间较长，请稍候」类提示。
 */
export function createStreamParser(meta) {
  let buffer = '';
  let sawNonEmptyLine = false;
  let sawParseError = false;
  let pushedAnyContent = false;
  let waitingTimer = null;

  function clearWaitingTimer() {
    if (waitingTimer != null) {
      clearTimeout(waitingTimer);
      waitingTimer = null;
    }
  }

  function maybeStartWaitingTimer(transform) {
    if (WAITING_MSG_AFTER_MS <= 0 || waitingTimer != null || pushedAnyContent) return;
    waitingTimer = setTimeout(() => {
      waitingTimer = null;
      if (pushedAnyContent) return;
      const msg = (WAITING_MSG_TEXT && WAITING_MSG_TEXT.trim()) ? WAITING_MSG_TEXT.trim() : '处理时间较长，请稍候。';
      transform.push(`data: ${buildChunkWithContent(meta, msg)}\n\n`);
      pushedAnyContent = true;
    }, WAITING_MSG_AFTER_MS);
  }

  return new Transform({
    objectMode: false,
    transform(chunk, encoding, callback) {
      maybeStartWaitingTimer(this);
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.trim()) continue;
        sawNonEmptyLine = true;
        let obj;
        try {
          obj = JSON.parse(line.trim());
        } catch (_) {
          sawParseError = true;
          continue;
        }
        const kind = String(obj.type || '').toLowerCase();
        const text = extractTextFromStreamLine(obj);
        const isThinking = kind === 'thinking' || kind === 'reasoning' || kind === 'thought';
        if (STREAM_DEBUG && (kind === 'assistant' || kind === 'result' || kind === 'message' || isThinking)) {
          const snippet = text ? text.replace(/\s+/g, ' ').trim().slice(0, 55) + (text.length > 55 ? '…' : '') : '-';
          console.log('[stream-raw] type=%s textLen=%d snippet=%s', kind, text?.length ?? 0, snippet);
        }
        if (!text || isLikelyThinkingOrHeartbeat(text)) continue;

        if (kind === 'result') {
          clearWaitingTimer();
          this.push(`data: ${buildChunkWithContent(meta, text)}\n\n`);
          pushedAnyContent = true;
          continue;
        }
        if (SHOW_THINKING && isThinking) {
          clearWaitingTimer();
          const display = THINKING_PREFIX ? THINKING_PREFIX + text : text;
          this.push(`data: ${buildChunkWithContent(meta, display)}\n\n`);
          pushedAnyContent = true;
        }
      }
      callback();
    },
    flush(callback) {
      clearWaitingTimer();
      if (buffer.trim()) {
        sawNonEmptyLine = true;
        let obj;
        try {
          obj = JSON.parse(buffer.trim());
        } catch (_) {
          sawParseError = true;
          obj = null;
        }
        if (obj) {
          const kind = String(obj.type || '').toLowerCase();
          const text = extractTextFromStreamLine(obj);
          const isThinking = kind === 'thinking' || kind === 'reasoning' || kind === 'thought';
          if (STREAM_DEBUG && (kind === 'assistant' || kind === 'result' || kind === 'message' || isThinking))
            console.log('[stream-raw] flush type=%s textLen=%d', kind, text?.length ?? 0);
          if (text && !isLikelyThinkingOrHeartbeat(text)) {
            if (kind === 'result') {
              this.push(`data: ${buildChunkWithContent(meta, text)}\n\n`);
              pushedAnyContent = true;
            } else if (SHOW_THINKING && isThinking) {
              const display = THINKING_PREFIX ? THINKING_PREFIX + text : text;
              this.push(`data: ${buildChunkWithContent(meta, display)}\n\n`);
              pushedAnyContent = true;
            }
          }
        }
      }
      if (!pushedAnyContent && sawNonEmptyLine) {
        const fallback = sawParseError ? FALLBACK_PARSE_ERROR : FALLBACK_NO_CONTENT;
        this.push(`data: ${buildChunkWithContent(meta, fallback)}\n\n`);
      }
      callback();
    },
  });
}
