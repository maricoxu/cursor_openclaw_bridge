/**
 * 将 OpenAI 风格的 messages 数组拼成单条 prompt 字符串，供 cursor-agent 使用。
 * cursor-agent 只接受一条 prompt，不认 messages 数组。
 */

const SEP = '\n---\n';

/**
 * @param {Array<{ role: string; content: string }>} messages
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
    const content = typeof msg.content === 'string' ? msg.content : (msg.content || '');

    if (role === 'system') {
      systemContent = content.trim();
      continue;
    }
    if (role === 'user' || role === 'assistant') {
      turns.push({ role, content: content.trim() });
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
