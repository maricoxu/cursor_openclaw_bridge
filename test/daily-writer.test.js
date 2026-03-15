/**
 * daily-writer 单测
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { appendDailyNote, _resetDailyThrottle } from '../src/daily-writer.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDir = path.join(__dirname, 'fixtures', 'daily-writer-tmp');

describe('daily-writer', () => {
  it('notesRoot 或 reqId 为空时返回 false', () => {
    assert.strictEqual(appendDailyNote('', 'id1', 'q', 'a'), false);
    assert.strictEqual(appendDailyNote('/tmp', '', 'q', 'a'), false);
  });

  it('首次写入创建 memory 目录与今日文件并写入块', () => {
    _resetDailyThrottle();
    const root = path.join(tmpDir, 'first');
    try {
      fs.rmSync(root, { recursive: true });
    } catch (_) {}
    fs.mkdirSync(root, { recursive: true });

    const ok = appendDailyNote(root, 'req-1', '用户问题', '助手回复', { throttleMin: 0 });
    assert.strictEqual(ok, true);

    const memoryDir = path.join(root, 'memory');
    assert.ok(fs.existsSync(memoryDir));
    const today = new Date().toISOString().slice(0, 10);
    const filePath = path.join(memoryDir, `${today}.md`);
    assert.ok(fs.existsSync(filePath));
    const content = fs.readFileSync(filePath, 'utf8');
    assert.ok(content.includes('## AI交互记录'));
    assert.ok(content.includes('用户问题'));
    assert.ok(content.includes('助手回复'));
    assert.ok(content.includes('req-1'));

    fs.rmSync(root, { recursive: true });
  });

  it('长内容被截断', () => {
    _resetDailyThrottle();
    const root = path.join(tmpDir, 'trunc');
    try {
      fs.rmSync(root, { recursive: true });
    } catch (_) {}
    fs.mkdirSync(root, { recursive: true });

    const longUser = 'x'.repeat(1000);
    const longAssistant = 'y'.repeat(1000);
    appendDailyNote(root, 'req-2', longUser, longAssistant, { throttleMin: 0, maxUserChars: 10, maxAssistantChars: 10 });

    const today = new Date().toISOString().slice(0, 10);
    const content = fs.readFileSync(path.join(root, 'memory', `${today}.md`), 'utf8');
    assert.ok(content.includes('x'.repeat(10) + '…'));
    assert.ok(content.includes('y'.repeat(10) + '…'));

    fs.rmSync(root, { recursive: true });
  });

  it('限频时跳过写入并返回 false', () => {
    _resetDailyThrottle();
    const root = path.join(tmpDir, 'throttle');
    try {
      fs.rmSync(root, { recursive: true });
    } catch (_) {}
    fs.mkdirSync(root, { recursive: true });

    const ok1 = appendDailyNote(root, 'req-a', 'q', 'a', { throttleMin: 10 });
    assert.strictEqual(ok1, true);
    const ok2 = appendDailyNote(root, 'req-b', 'q', 'a', { throttleMin: 10 });
    assert.strictEqual(ok2, false);

    fs.rmSync(root, { recursive: true });
  });

  it('throttleMin=0 时连续两次都写入', () => {
    _resetDailyThrottle();
    const root = path.join(tmpDir, 'no-throttle');
    try {
      fs.rmSync(root, { recursive: true });
    } catch (_) {}
    fs.mkdirSync(root, { recursive: true });

    appendDailyNote(root, 'r1', 'q1', 'a1', { throttleMin: 0 });
    const ok2 = appendDailyNote(root, 'r2', 'q2', 'a2', { throttleMin: 0 });
    assert.strictEqual(ok2, true);

    const today = new Date().toISOString().slice(0, 10);
    const content = fs.readFileSync(path.join(root, 'memory', `${today}.md`), 'utf8');
    assert.ok(content.includes('q1') && content.includes('q2'));

    fs.rmSync(root, { recursive: true });
  });
});
