/**
 * Phase 3 Memory：请求结束后将本次交互追加到 daily note（memory/YYYY-MM-DD.md）。
 * 支持限频（同一进程内 N 分钟内只写一次），写失败仅打日志不抛错。
 */

import fs from 'fs';
import path from 'path';

const BRIDGE_DEBUG = /^(1|true|yes)$/i.test(process.env.CURSOR_BRIDGE_DEBUG || '');

/** 限频：上次写回时间戳；写回前若间隔 < throttleMin 分钟则跳过 */
let _lastWriteAt = 0;
const DEFAULT_THROTTLE_MIN = 5;

function dateString(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** 截断到最多 N 字符，避免单条过长 */
function truncate(s, max) {
  if (typeof s !== 'string') return '';
  if (max <= 0 || s.length <= max) return s.trim();
  return s.trim().slice(0, max) + '…';
}

/**
 * 将本次对话的一条记录追加到 daily note。
 * 写回路径为 notesRoot 下的 memory/YYYY-MM-DD.md（与 DESIGN 约定一致：写回笔记库根下的 daily）。
 * @param {string} notesRoot - 笔记库根（用于写 memory/ 目录）
 * @param {string} reqId - 请求 id
 * @param {string} lastUserContent - 最后一条 user 内容（可截断）
 * @param {string} assistantSummary - assistant 回复摘要或全文（可截断）
 * @param {{ agentId?: string; throttleMin?: number; maxUserChars?: number; maxAssistantChars?: number }} [options]
 * @returns {boolean} 是否实际写入了（被限频或失败则 false）
 */
export function appendDailyNote(notesRoot, reqId, lastUserContent, assistantSummary, options = {}) {
  if (!notesRoot || !reqId) return false;

  const throttleMin = options.throttleMin ?? DEFAULT_THROTTLE_MIN;
  const now = Date.now();
  if (throttleMin > 0 && _lastWriteAt > 0 && now - _lastWriteAt < throttleMin * 60 * 1000) {
    if (BRIDGE_DEBUG) console.log('[bridge] daily 写回限频跳过，距上次 %d 分钟', throttleMin);
    return false;
  }

  const today = dateString();
  const memoryDir = path.join(notesRoot, 'memory');
  const filePath = path.join(memoryDir, `${today}.md`);

  const maxUser = options.maxUserChars ?? 500;
  const maxAssistant = options.maxAssistantChars ?? 800;
  const userText = truncate(lastUserContent || '', maxUser);
  const assistantText = truncate(assistantSummary || '', maxAssistant);
  const agentLabel = options.agentId || 'bridge';
  const timeStr = new Date().toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });

  const block = `
### ${timeStr} - ${agentLabel}
- **问题**: ${userText || '(无)'}
- **要点**: ${assistantText || '(流式回复)'}
- **请求 id**: ${reqId}
`;

  try {
    if (!fs.existsSync(memoryDir)) {
      fs.mkdirSync(memoryDir, { recursive: true });
    }
    let existing = '';
    if (fs.existsSync(filePath)) {
      existing = fs.readFileSync(filePath, 'utf8');
    }
    const needsHeader = !existing.includes('## AI交互记录');
    const toAppend = (needsHeader && existing.trim() ? '\n\n## AI交互记录\n' : needsHeader ? '## AI交互记录\n' : '') + block.trim() + '\n';
    fs.appendFileSync(filePath, toAppend, 'utf8');
    _lastWriteAt = now;
    if (BRIDGE_DEBUG) console.log('[bridge] daily 已写回:', filePath);
    return true;
  } catch (err) {
    console.warn('[bridge] daily 写回失败:', filePath, err.message);
    return false;
  }
}

/**
 * 重置限频状态（仅用于单测）
 */
export function _resetDailyThrottle() {
  _lastWriteAt = 0;
}
