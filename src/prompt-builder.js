/**
 * 将 OpenAI 风格的 messages 数组拼成单条 prompt 字符串，供 cursor-agent 使用。
 * cursor-agent 只接受一条 prompt，不认 messages 数组。
 */

const SEP = '\n---\n';

/** 从 content（可能是 string / 数组 / 对象）里抽出纯文本，避免 [object Object] */
function getTextFromContent(raw) {
  if (typeof raw === 'string') return raw;
  if (raw == null) return '';
  if (Array.isArray(raw)) {
    let out = '';
    for (const part of raw) {
      if (!part || typeof part !== 'object') continue;
      if (part.text != null) out += String(part.text);
      else if (part.content != null) out += String(part.content);
      else if (part.input_text?.text != null) out += String(part.input_text.text);
    }
    return out;
  }
  if (typeof raw === 'object') {
    if (raw.text != null) return String(raw.text);
    if (raw.content != null) return String(raw.content);
    if (raw.input_text?.text != null) return String(raw.input_text.text);
  }
  return String(raw);
}

/**
 * @param {Array<{ role: string; content: string|object|array }>} messages
 * @returns {string}
 */
export function buildPrompt(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return '';
  }

  const parts = [];
  let systemContent = '';
  const turns = [];

  for (const msg of messages) {
    const role = (msg.role || '').toLowerCase();
    const content = getTextFromContent(msg.content).trim();

    if (role === 'system') {
      systemContent = content;
      continue;
    }
    if (role === 'user' || role === 'assistant') {
      turns.push({ role, content });
    }
  }

  if (systemContent) {
    parts.push(`[System]\n${systemContent}`);
    parts.push('');
  }

  for (const { role, content } of turns) {
    const label = role === 'user' ? 'User' : 'Assistant';
    parts.push(`[${label}]\n${content}`);
  }

  return parts.join(SEP);
}
