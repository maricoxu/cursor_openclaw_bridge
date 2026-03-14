/**
 * Phase 1 测试：prompt-builder
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { buildPrompt } from '../src/prompt-builder.js';

describe('buildPrompt', () => {
  it('空数组返回空字符串', () => {
    assert.strictEqual(buildPrompt([]), '');
  });

  it('非数组返回空字符串', () => {
    assert.strictEqual(buildPrompt(null), '');
    assert.strictEqual(buildPrompt(undefined), '');
    assert.strictEqual(buildPrompt(''), '');
  });

  it('单条 user 消息', () => {
    const out = buildPrompt([{ role: 'user', content: 'hello' }]);
    assert.ok(out.includes('[User]'));
    assert.ok(out.includes('hello'));
  });

  it('system + user', () => {
    const out = buildPrompt([
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'hi' },
    ]);
    assert.ok(out.includes('[System]'));
    assert.ok(out.includes('You are helpful.'));
    assert.ok(out.includes('[User]'));
    assert.ok(out.includes('hi'));
  });

  it('多轮 user/assistant', () => {
    const out = buildPrompt([
      { role: 'user', content: '1' },
      { role: 'assistant', content: '2' },
      { role: 'user', content: '3' },
    ]);
    assert.ok(out.includes('[User]'));
    assert.ok(out.includes('[Assistant]'));
    assert.ok(out.includes('1'));
    assert.ok(out.includes('2'));
    assert.ok(out.includes('3'));
  });

  it('content 非字符串时当空处理', () => {
    const out = buildPrompt([{ role: 'user', content: 123 }]);
    assert.ok(out.includes('[User]'));
  });

  it('content 为数组（OpenAI 多 part）时提取 text', () => {
    const out = buildPrompt([
      { role: 'user', content: [{ type: 'text', text: '测试' }] },
    ]);
    assert.ok(out.includes('[User]'));
    assert.ok(out.includes('测试'));
    assert.ok(!out.includes('object Object'));
  });

  it('忽略非 user/assistant/system 的 role', () => {
    const out = buildPrompt([
      { role: 'user', content: 'a' },
      { role: 'tool', content: 'b' },
      { role: 'assistant', content: 'c' },
    ]);
    assert.ok(out.includes('a'));
    assert.ok(out.includes('c'));
    assert.ok(!out.includes('b'));
  });
});
