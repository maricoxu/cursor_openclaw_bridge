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

  it('type result 时提取 result 文本', () => {
    const line = JSON.stringify({ type: 'result', result: '今天上海晴。' });
    const out = parseNdjsonLine(line, meta);
    assert.ok(out !== null);
    const parsed = JSON.parse(out);
    assert.strictEqual(parsed.choices[0].delta.content, '今天上海晴。');
  });

  it('顶层 content 时提取文本', () => {
    const line = JSON.stringify({ content: '收到。' });
    const out = parseNdjsonLine(line, meta);
    assert.ok(out !== null);
    const parsed = JSON.parse(out);
    assert.strictEqual(parsed.choices[0].delta.content, '收到。');
  });
});

/** 从 parser 输出的 SSE 字符串中拼接出所有 delta.content */
function extractContentFromSSE(sseText) {
  const content = [];
  const lines = sseText.split(/\n\n/);
  for (const block of lines) {
    const m = block.match(/^data:\s*(.+)$/m);
    if (!m) continue;
    try {
      const data = JSON.parse(m[1].trim());
      if (data === '[DONE]' || data?.choices?.[0]?.delta?.content == null) continue;
      content.push(data.choices[0].delta.content);
    } catch (_) {}
  }
  return content.join('');
}

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

  it('result 原样转发（含自重复内容也保留）', () => {
    const msg = '我是 Auto,由 Cursor 设计的 Agent 路由器。';
    const line = JSON.stringify({
      type: 'result',
      result: msg + msg,
    });
    const out = parseNdjsonLine(line, meta);
    assert.ok(out !== null);
    const parsed = JSON.parse(out);
    assert.strictEqual(parsed.choices[0].delta.content, msg + msg);
  });

  it('流式多行相同 result 事件级去重只保留一遍', () => {
    const msg = '你好';
    return new Promise((resolve, reject) => {
      const parser = createStreamParser(meta);
      const chunks = [];
      parser.on('data', (c) => chunks.push(c.toString()));
      parser.on('end', () => {
        const sseText = chunks.join('');
        const content = extractContentFromSSE(sseText);
        assert.strictEqual(content, msg, '相同 result 多行只转发第一行');
        resolve();
      });
      parser.on('error', reject);
      const line = JSON.stringify({ type: 'result', result: msg });
      const r = new Readable({ read() {} });
      r.push(line + '\n');
      r.push(line + '\n');
      r.push(null);
      r.pipe(parser);
    });
  });

  it('真实 Cursor partial + 完整 assistant + result 时事件级去重只出一遍正文', () => {
    const part1 = '\n我是 **Auto**';
    const part2 = '，由 Cursor 设计';
    const part3 = '的 **Agent 路由器**，负责理解你的需求并调度合适的工具与能力来协助你。\n\n如果你有具体问题或想做的事，可以直接说，我会用中文和你一起解决。';
    const full = '我是 **Auto**，由 Cursor 设计的 **Agent 路由器**，负责理解你的需求并调度合适的工具与能力来协助你。\n\n如果你有具体问题或想做的事，可以直接说，我会用中文和你一起解决。';

    return new Promise((resolve, reject) => {
      const parser = createStreamParser(meta);
      const chunks = [];
      parser.on('data', (c) => chunks.push(c.toString()));
      parser.on('end', () => {
        const sseText = chunks.join('');
        const content = extractContentFromSSE(sseText);
        assert.strictEqual(content, full, 'partial 拼出 full 后，完整 assistant 与 result 视为冗余只出一遍');
        resolve();
      });
      parser.on('error', reject);

      const lines = [
        JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: part1 }] } }),
        JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: part2 }] } }),
        JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: part3 }] } }),
        JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: full }] } }),
        JSON.stringify({ type: 'result', subtype: 'success', result: full }),
      ];
      const r = new Readable({ read() {} });
      for (const line of lines) r.push(line + '\n');
      r.push(null);
      r.pipe(parser);
    });
  });
});
