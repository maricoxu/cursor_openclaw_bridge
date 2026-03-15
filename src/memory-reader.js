/**
 * Phase 3 Memory：按「近 / 远 / 他 Agent」分层读取并拼接记忆上下文。
 *
 * 设计要点：
 * - 近 = 查得快（主要作用）：优先注入、限额高，模型先看这里，响应快。
 * - 远 = 索引更少、整体更快，但查能查全；任务突然需要远端 memory 时也能查到，只是多花点时间回想。
 * - 他 Agent = 同上，需要时能查全。默认不设字符限额；若需控 token 或做数据分析，可在调用方传 max*Chars 或通过 env 配置。
 */

import fs from 'fs';
import path from 'path';

const TRUNCATE_SUFFIX = '\n\n… [已截断]';

/** maxChars <= 0 或未传时表示不限额，读全文 */
function safeRead(pathname, maxChars) {
  if (!pathname) return '';
  try {
    const raw = fs.readFileSync(pathname, 'utf8');
    const s = (raw || '').trim();
    if (maxChars == null || maxChars <= 0) return s;
    if (s.length <= maxChars) return s;
    return s.slice(0, maxChars) + TRUNCATE_SUFFIX;
  } catch (_) {
    return '';
  }
}

/**
 * 获取从 today 往前 N 天的 daily 路径（不含今天、昨天；那部分在 near）。
 * @param {string} notesRoot
 * @param {Date} now
 * @param {number} farDays - 远层包含几天（如 3 表示 2～4 天前，即 3 个文件）
 */
function getFarDailyPaths(notesRoot, now, farDays) {
  if (farDays <= 0) return [];
  const memoryDir = path.join(notesRoot, 'memory');
  const list = [];
  for (let i = 2; i < 2 + farDays; i++) {
    const y = now.getFullYear();
    const m = now.getMonth();
    const d = now.getDate() - i;
    const t = new Date(y, m, d);
    const ys = t.getFullYear();
    const ms = String(t.getMonth() + 1).padStart(2, '0');
    const ds = String(t.getDate()).padStart(2, '0');
    list.push(path.join(memoryDir, `${ys}-${ms}-${ds}.md`));
  }
  return list;
}

/**
 * 按分层读取 memory 并拼接为一段 [Memory] 文本。
 * @param {{ memoryPaths: { rootMemory: string; dailyPath: string; dailyPathYesterday?: string; agentMemory?: string }; notesRoot?: string; otherAgentMemoryPaths?: string[] }} resolution - resolveWorkspace 的返回值
 * @param {{
 *   maxRootChars?: number;
 *   maxDailyTodayChars?: number;
 *   maxDailyYesterdayChars?: number;
 *   maxAgentChars?: number;
 *   includeYesterday?: boolean;
 *   farDays?: number;
 *   farMaxPerDayChars?: number;
 *   includeOtherAgents?: boolean;
 *   otherMaxPerAgentChars?: number;
 * }} [options]
 * @returns {string} 拼接后的 [Memory] 块，无内容时返回 ''
 */
export function readMemoryContext(resolution, options = {}) {
  if (!resolution || !resolution.memoryPaths) return '';

  // 默认不限额（0）；仅当显式配置为正数时才截断，便于后续分析时再设具体值控 token
  const maxRoot = options.maxRootChars ?? 0;
  const maxDailyToday = options.maxDailyTodayChars ?? 0;
  const maxDailyYesterday = options.maxDailyYesterdayChars ?? 0;
  const maxAgent = options.maxAgentChars ?? 0;
  const includeYesterday = options.includeYesterday !== false;
  const farDays = Math.max(0, options.farDays ?? 0);
  const farMaxPerDay = options.farMaxPerDayChars ?? 0;
  const includeOtherAgents = options.includeOtherAgents === true;
  const otherMaxPer = options.otherMaxPerAgentChars ?? 0;

  const parts = [];

  // 近：根 MEMORY + 今日 daily + 昨日 daily + 当前 Agent MEMORY
  const nearParts = [];
  const rootText = safeRead(resolution.memoryPaths.rootMemory, maxRoot);
  if (rootText) nearParts.push(rootText);

  const dailyToday = safeRead(resolution.memoryPaths.dailyPath, maxDailyToday);
  if (dailyToday) nearParts.push(`## 今日记录\n${dailyToday}`);

  if (includeYesterday && resolution.memoryPaths.dailyPathYesterday) {
    const dailyY = safeRead(resolution.memoryPaths.dailyPathYesterday, maxDailyYesterday);
    if (dailyY) nearParts.push(`## 昨日记录\n${dailyY}`);
  }

  if (resolution.memoryPaths.agentMemory) {
    const agentText = safeRead(resolution.memoryPaths.agentMemory, maxAgent);
    if (agentText) nearParts.push(`## 当前 Agent 记忆\n${agentText}`);
  }

  if (nearParts.length > 0) {
    parts.push('[近] 常用记忆（优先查阅）\n' + nearParts.join('\n\n---\n\n'));
  }

  // 远：更早的 daily
  if (farDays > 0 && resolution.notesRoot) {
    const now = options.now ?? new Date();
    const farPaths = getFarDailyPaths(resolution.notesRoot, now, farDays);
    const farTexts = farPaths
      .map((p) => safeRead(p, farMaxPerDay))
      .filter(Boolean);
    if (farTexts.length > 0) {
      parts.push('[远] 近期历史\n' + farTexts.join('\n\n---\n\n'));
    }
  }

  // 他 Agent：其他 Agent 的 MEMORY
  if (includeOtherAgents && resolution.otherAgentMemoryPaths && resolution.otherAgentMemoryPaths.length > 0) {
    const otherTexts = resolution.otherAgentMemoryPaths
      .map((p) => safeRead(p, otherMaxPer))
      .filter(Boolean);
    if (otherTexts.length > 0) {
      parts.push('[其他 Agent 记忆] 按需查阅\n' + otherTexts.join('\n\n---\n\n'));
    }
  }

  if (parts.length === 0) return '';
  return '[Memory]\n\n' + parts.join('\n\n---\n\n');
}
