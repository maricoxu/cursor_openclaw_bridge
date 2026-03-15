/**
 * memory-resolver 单测
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import path from 'path';
import { fileURLToPath } from 'url';
import { resolveWorkspace } from '../src/memory-resolver.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixtureRoot = path.resolve(__dirname, 'fixtures');

describe('memory-resolver', () => {
  it('无 agentId 时 workspacePath 为根，无 agentMemory，无 otherAgentMemoryPaths', () => {
    const r = resolveWorkspace(undefined, fixtureRoot);
    assert.strictEqual(r.workspacePath, fixtureRoot);
    assert.strictEqual(r.notesRoot, fixtureRoot);
    assert.strictEqual(r.agentId, undefined);
    assert.ok(r.memoryPaths.rootMemory.endsWith('MEMORY.md'));
    assert.ok(r.memoryPaths.dailyPath.includes('memory'));
    assert.strictEqual(r.memoryPaths.agentMemory, undefined);
    assert.strictEqual(r.otherAgentMemoryPaths.length, 0);
  });

  it('有 agentId 但映射表为空时等同于无 agentId', () => {
    const r = resolveWorkspace('any_agent', fixtureRoot, { agentWorkspaces: '' });
    assert.strictEqual(r.workspacePath, fixtureRoot);
    assert.strictEqual(r.memoryPaths.agentMemory, undefined);
    assert.strictEqual(r.otherAgentMemoryPaths.length, 0);
  });

  it('有 agentId 且映射存在时 workspacePath 为子目录，含 agentMemory', () => {
    const r = resolveWorkspace('00_小哩', fixtureRoot, {
      agentWorkspaces: '00_小哩:7-Agents/00_小哩',
    });
    assert.ok(r.workspacePath.includes('7-Agents'));
    assert.ok(r.workspacePath.endsWith('00_小哩') || r.workspacePath.includes('00_小哩'));
    assert.ok(r.memoryPaths.agentMemory && r.memoryPaths.agentMemory.endsWith('MEMORY.md'));
    assert.strictEqual(r.otherAgentMemoryPaths.length, 0);
  });

  it('多 agent 映射时当前 agent 外其他 agent 的 MEMORY 路径出现在 otherAgentMemoryPaths', () => {
    const r = resolveWorkspace('A', fixtureRoot, {
      agentWorkspaces: 'A:agents/a,B:agents/b,C:agents/c',
    });
    assert.ok(r.workspacePath.includes('agents' + path.sep + 'a'));
    assert.strictEqual(r.otherAgentMemoryPaths.length, 2);
    assert.ok(r.otherAgentMemoryPaths.some((p) => p.includes('agents' + path.sep + 'b')));
    assert.ok(r.otherAgentMemoryPaths.some((p) => p.includes('agents' + path.sep + 'c')));
  });

  it('dailyPath 与 dailyPathYesterday 基于 options.now', () => {
    const now = new Date('2026-03-15T12:00:00Z');
    const r = resolveWorkspace(undefined, fixtureRoot, { now });
    assert.ok(r.memoryPaths.dailyPath.endsWith('2026-03-15.md'));
    assert.ok(r.memoryPaths.dailyPathYesterday.endsWith('2026-03-14.md'));
  });
});
