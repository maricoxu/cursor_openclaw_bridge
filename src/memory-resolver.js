/**
 * Phase 3 Memory：根据 agent_id 解析 workspace 与 memory 文件路径。
 * 无 agent_id 或未配置映射时使用笔记库根。
 */

import path from 'path';
import fs from 'fs';

/** 解析环境变量 CURSOR_BRIDGE_AGENT_WORKSPACES，格式 id1:path1,id2:path2 或 id1:path1;id2:path2 */
function parseAgentWorkspacesEnv(envValue) {
  if (!envValue || typeof envValue !== 'string') return new Map();
  const map = new Map();
  const pairs = envValue.split(/[,;]/).map((s) => s.trim()).filter(Boolean);
  for (const p of pairs) {
    const i = p.indexOf(':');
    if (i <= 0) continue;
    const id = p.slice(0, i).trim();
    const subPath = p.slice(i + 1).trim();
    if (id && subPath) map.set(id, subPath);
  }
  return map;
}

/**
 * 获取今日、昨日、前 N 天的日期字符串 YYYY-MM-DD。
 * @param {Date} [d] 基准日期，默认当前
 * @param {number} [daysAgo] 0=今天，1=昨天，2=前天…
 */
function dateString(d = new Date(), daysAgo = 0) {
  const t = new Date(d);
  t.setDate(t.getDate() - daysAgo);
  const y = t.getFullYear();
  const m = String(t.getMonth() + 1).padStart(2, '0');
  const day = String(t.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * 解析当前请求的 workspace 与 memory 路径集合。
 * @param {string | undefined} agentId - 请求中的 agent 标识（Header 或 body）
 * @param {string} workspaceRoot - 笔记库根（CURSOR_WORKSPACE）
 * @param {{ agentWorkspaces?: string, now?: Date }} [options] - agent 映射 env、用于测试的当前时间
 * @returns {{
 *   workspacePath: string;
 *   notesRoot: string;
 *   agentId: string | undefined;
 *   memoryPaths: { rootMemory: string; dailyPath: string; dailyPathYesterday?: string; agentMemory?: string };
 *   otherAgentMemoryPaths: string[];
 * }}
 */
export function resolveWorkspace(agentId, workspaceRoot, options = {}) {
  const root = path.resolve(workspaceRoot || process.cwd());
  const agentWorkspacesEnv = options.agentWorkspaces ?? process.env.CURSOR_BRIDGE_AGENT_WORKSPACES ?? '';
  const agentMap = parseAgentWorkspacesEnv(agentWorkspacesEnv);
  const now = options.now ?? new Date();

  const today = dateString(now, 0);
  const yesterday = dateString(now, 1);
  const memoryDir = path.join(root, 'memory');
  const rootMemoryPath = path.join(root, 'MEMORY.md');
  const dailyPath = path.join(memoryDir, `${today}.md`);
  const dailyPathYesterday = path.join(memoryDir, `${yesterday}.md`);

  let workspacePath = root;
  let agentMemoryPath = undefined;
  const otherAgentMemoryPaths = [];

  if (agentId && agentMap.has(agentId)) {
    const subPath = agentMap.get(agentId);
    workspacePath = path.join(root, subPath);
    agentMemoryPath = path.join(workspacePath, 'MEMORY.md');
    // 其他 agent 的 MEMORY.md（同映射表内除当前外的所有）
    for (const [id, sub] of agentMap) {
      if (id === agentId) continue;
      const otherPath = path.join(root, sub, 'MEMORY.md');
      otherAgentMemoryPaths.push(otherPath);
    }
  }

  return {
    workspacePath,
    notesRoot: root,
    agentId: agentId || undefined,
    memoryPaths: {
      rootMemory: rootMemoryPath,
      dailyPath,
      dailyPathYesterday,
      agentMemory: agentMemoryPath,
    },
    otherAgentMemoryPaths,
  };
}
