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

  it('无 type 或非 assistant/result/message 时不抽取（不走兜底，避免重复）', () => {
    assert.strictEqual(parseNdjsonLine(JSON.stringify({ content: '收到。' }), meta), null);
    assert.strictEqual(parseNdjsonLine(JSON.stringify({ output: 'x' }), meta), null);
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

  it('result 先到、assistant 后到同一段正文时只出一遍', () => {
    const full = '我是小哩——你笔记库里的中枢之魂。';
    const part1 = '我是小哩';
    const part2 = '——你笔记库里的中枢之魂。';
    return new Promise((resolve, reject) => {
      const parser = createStreamParser(meta);
      const chunks = [];
      parser.on('data', (c) => chunks.push(c.toString()));
      parser.on('end', () => {
        const sseText = chunks.join('');
        const content = extractContentFromSSE(sseText);
        assert.strictEqual(content, full, 'result 先发整段再 assistant 分片时，分片视为冗余只出一遍');
        resolve();
      });
      parser.on('error', reject);
      const lines = [
        JSON.stringify({ type: 'result', result: full }),
        JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: part1 }] } }),
        JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: part2 }] } }),
      ];
      const r = new Readable({ read() {} });
      for (const line of lines) r.push(line + '\n');
      r.push(null);
      r.pipe(parser);
    });
  });

  it('result 与 message(role=assistant) 同一段正文时只出一遍', () => {
    const full = '回复正文只出一遍。';
    return new Promise((resolve, reject) => {
      const parser = createStreamParser(meta);
      const chunks = [];
      parser.on('data', (c) => chunks.push(c.toString()));
      parser.on('end', () => {
        const sseText = chunks.join('');
        const content = extractContentFromSSE(sseText);
        assert.strictEqual(content, full, 'result 与 message 内容相同时只转发一次');
        resolve();
      });
      parser.on('error', reject);
      const lines = [
        JSON.stringify({ type: 'result', result: full }),
        JSON.stringify({ type: 'message', role: 'assistant', content: full }),
      ];
      const r = new Readable({ read() {} });
      for (const line of lines) r.push(line + '\n');
      r.push(null);
      r.pipe(parser);
    });
  });

  it('result 先到、assistant 单字/短 chunk 后到时只出一遍（防短 chunk 漏去重）', () => {
    const full = '你好世界';
    return new Promise((resolve, reject) => {
      const parser = createStreamParser(meta);
      const chunks = [];
      parser.on('data', (c) => chunks.push(c.toString()));
      parser.on('end', () => {
        const sseText = chunks.join('');
        const content = extractContentFromSSE(sseText);
        assert.strictEqual(content, full, 'result 整段后再跟 assistant 单字/短片段应全部视为冗余');
        resolve();
      });
      parser.on('error', reject);
      const lines = [
        JSON.stringify({ type: 'result', result: full }),
        ...['你', '好', '世', '界'].map((t) =>
          JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: t }] } })
        ),
      ];
      const r = new Readable({ read() {} });
      for (const line of lines) r.push(line + '\n');
      r.push(null);
      r.pipe(parser);
    });
  });

  it('两行完全相同 assistant 全文时只出一遍', () => {
    const full = '完全相同的两行只出一遍。';
    return new Promise((resolve, reject) => {
      const parser = createStreamParser(meta);
      const chunks = [];
      parser.on('data', (c) => chunks.push(c.toString()));
      parser.on('end', () => {
        const sseText = chunks.join('');
        const content = extractContentFromSSE(sseText);
        assert.strictEqual(content, full, '相同 assistant 多行只转发第一行');
        resolve();
      });
      parser.on('error', reject);
      const line = JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: full }] },
      });
      const r = new Readable({ read() {} });
      r.push(line + '\n');
      r.push(line + '\n');
      r.push(null);
      r.pipe(parser);
    });
  });

  it('type=result 时只取 result 字段不取顶层 content（无兜底）', () => {
    const line = JSON.stringify({ type: 'result', result: '正确', content: '错误' });
    const out = parseNdjsonLine(line, meta);
    assert.ok(out !== null);
    const parsed = JSON.parse(out);
    assert.strictEqual(parsed.choices[0].delta.content, '正确');
  });

  it('无 type 仅有顶层 content 的行不产出', () => {
    assert.strictEqual(parseNdjsonLine(JSON.stringify({ content: '不应出现' }), meta), null);
  });
});
