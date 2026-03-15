/**
 * memory-reader 单测（近/远/他 Agent 分层）
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { readMemoryContext } from '../src/memory-reader.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixtureRoot = path.resolve(__dirname, 'fixtures', 'memory-fixture');
const now = new Date('2026-03-14T12:00:00Z');

function resolution(overrides = {}) {
  return {
    notesRoot: fixtureRoot,
    memoryPaths: {
      rootMemory: path.join(fixtureRoot, 'MEMORY.md'),
      dailyPath: path.join(fixtureRoot, 'memory', '2026-03-14.md'),
      dailyPathYesterday: path.join(fixtureRoot, 'memory', '2026-03-13.md'),
      agentMemory: undefined,
    },
    otherAgentMemoryPaths: [],
    ...overrides,
  };
}

describe('memory-reader', () => {
  it('无 resolution 返回空字符串', () => {
    assert.strictEqual(readMemoryContext(null), '');
    assert.strictEqual(readMemoryContext(undefined), '');
  });

  it('有根 MEMORY 与今日 daily 时返回 [Memory] 且含 [近]', () => {
    const out = readMemoryContext(resolution(), { now });
    assert.ok(out.startsWith('[Memory]'));
    assert.ok(out.includes('[近]'));
    assert.ok(out.includes('Root long-term memory'));
    assert.ok(out.includes('Today daily note'));
    assert.ok(out.includes('昨日') || out.includes('Yesterday note'));
  });

  it('includeYesterday=false 时不读昨日', () => {
    const r = resolution();
    r.memoryPaths.dailyPath = path.join(fixtureRoot, 'memory', '2026-03-14.md');
    r.memoryPaths.dailyPathYesterday = path.join(fixtureRoot, 'memory', 'nonexistent.md');
    const out = readMemoryContext(resolution(), { now, includeYesterday: false });
    assert.ok(out.includes('[近]'));
    assert.ok(!out.includes('Yesterday note'));
  });

  it('maxRootChars 截断根 MEMORY', () => {
    const out = readMemoryContext(resolution(), { now, maxRootChars: 5 });
    assert.ok(out.includes('Root ') && out.includes('… [已截断]'));
  });

  it('farDays > 0 且存在更早 daily 时含 [远]', () => {
    const out = readMemoryContext(resolution(), { now, farDays: 3, farMaxPerDayChars: 500 });
    assert.ok(out.includes('[远]'));
    assert.ok(out.includes('Older daily for far tier'));
  });

  it('includeOtherAgents 且 otherAgentMemoryPaths 有内容时含 [其他 Agent 记忆]', () => {
    const otherPath = path.join(fixtureRoot, 'other-agent-MEMORY.md');
    try {
      fs.writeFileSync(otherPath, 'Other agent memory content', 'utf8');
    } catch (_) {}
    const r = resolution({ otherAgentMemoryPaths: [otherPath] });
    const out = readMemoryContext(r, { now, includeOtherAgents: true, otherMaxPerAgentChars: 100 });
    assert.ok(out.includes('[其他 Agent 记忆]') || out.includes('Other agent memory'));
    try {
      fs.unlinkSync(otherPath);
    } catch (_) {}
  });

  it('所有路径无文件或空时返回空字符串', () => {
    const r = resolution({
      memoryPaths: {
        rootMemory: path.join(fixtureRoot, 'nonexistent.md'),
        dailyPath: path.join(fixtureRoot, 'nope.md'),
        dailyPathYesterday: undefined,
        agentMemory: undefined,
      },
      otherAgentMemoryPaths: [],
    });
    assert.strictEqual(readMemoryContext(r), '');
  });
});
