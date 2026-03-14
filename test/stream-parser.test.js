/**
 * Phase 1 测试：stream-parser
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { Readable } from 'stream';
import { parseNdjsonLine, createStreamParser } from '../src/stream-parser.js';

const meta = { id: 'test-id', created: 1000, model: 'cursor-agent' };

describe('parseNdjsonLine', () => {
  it('非 assistant 类型返回 null', () => {
    assert.strictEqual(parseNdjsonLine('{"type":"user","message":{}}', meta), null);
    assert.strictEqual(parseNdjsonLine('{"type":"system","subtype":"init"}', meta), null);
  });

  it('assistant 且 content 为数组时提取 text', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: '你好' }] },
    });
    const out = parseNdjsonLine(line, meta);
    assert.ok(out !== null);
    const parsed = JSON.parse(out);
    assert.strictEqual(parsed.choices[0].delta.content, '你好');
    assert.strictEqual(parsed.id, 'test-id');
    assert.strictEqual(parsed.model, 'cursor-agent');
  });

  it('assistant 多条 content 拼接', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'a' },
          { type: 'text', text: 'b' },
        ],
      },
    });
    const out = parseNdjsonLine(line, meta);
    assert.ok(out !== null);
    const parsed = JSON.parse(out);
    assert.strictEqual(parsed.choices[0].delta.content, 'ab');
  });

  it('无效 JSON 返回 null', () => {
    assert.strictEqual(parseNdjsonLine('not json', meta), null);
    assert.strictEqual(parseNdjsonLine('', meta), null);
  });

  it('无 message.content 返回 null', () => {
    const line = JSON.stringify({ type: 'assistant', message: {} });
    assert.strictEqual(parseNdjsonLine(line, meta), null);
  });
});

describe('createStreamParser', () => {
  it('输入 NDJSON 行输出 SSE 行', (t) => {
    return new Promise((resolve, reject) => {
      const parser = createStreamParser(meta);
      const chunks = [];
      parser.on('data', (c) => chunks.push(c.toString()));
      parser.on('end', () => {
        const out = chunks.join('');
        assert.ok(out.startsWith('data: '));
        assert.ok(out.includes('"content":"x"'));
        assert.ok(out.endsWith('\n\n') || out.includes('\n\n'));
        resolve();
      });
      parser.on('error', reject);
      const line = JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'x' }] },
      });
      const r = new Readable({ read() {} });
      r.push(line + '\n');
      r.push(null);
      r.pipe(parser);
    });
  });
});
