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
  it('输入 NDJSON 行输出 SSE 行（只推 result）', () => {
    return new Promise((resolve, reject) => {
      const parser = createStreamParser(meta);
      const chunks = [];
      parser.on('data', (c) => chunks.push(c.toString()));
      parser.on('end', () => {
        const out = chunks.join('');
        assert.ok(out.startsWith('data: '));
        assert.ok(out.includes('"content":"x"'));
        resolve();
      });
      parser.on('error', reject);
      const r = new Readable({ read() {} });
      r.push(JSON.stringify({ type: 'result', result: 'x' }) + '\n');
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

  it('流式多行 result 每行都转发（无去重）', () => {
    const msg = '你好';
    return new Promise((resolve, reject) => {
      const parser = createStreamParser(meta);
      const chunks = [];
      parser.on('data', (c) => chunks.push(c.toString()));
      parser.on('end', () => {
        const content = extractContentFromSSE(chunks.join(''));
        assert.strictEqual(content, msg + msg, '两行 result 都转发');
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

  it('assistant 多段 + result 时只出 result 正文', () => {
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
        assert.strictEqual(content, full, '只推 result，assistant 不转发');
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

  it('result 先到、assistant 后到：只出 result', () => {
    const full = '我是小哩——你笔记库里的中枢之魂。';
    const part1 = '我是小哩';
    const part2 = '——你笔记库里的中枢之魂。';
    return new Promise((resolve, reject) => {
      const parser = createStreamParser(meta);
      const chunks = [];
      parser.on('data', (c) => chunks.push(c.toString()));
      parser.on('end', () => {
        const content = extractContentFromSSE(chunks.join(''));
        assert.strictEqual(content, full, '只推 result');
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

  it('result 与 message 同段时只出 result', () => {
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

  it('result 先到、assistant 短 chunk 后到：只出 result', () => {
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

  it('仅 assistant 无 result 时出兜底', () => {
    const full = '完全相同的两行只出一遍。';
    return new Promise((resolve, reject) => {
      const parser = createStreamParser(meta);
      const chunks = [];
      parser.on('data', (c) => chunks.push(c.toString()));
      parser.on('end', () => {
        const content = extractContentFromSSE(chunks.join(''));
        assert.ok(content.includes('无可展示内容') || content.includes('heartbeat') || content.includes('thinking'), '仅 assistant 无 result 时应出兜底');
        resolve();
      });
      parser.on('error', reject);
      const r = new Readable({ read() {} });
      r.push(JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: full }] } }) + '\n');
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

  it('真实场景：长段落 result 后再发同内容 assistant 只出一遍（防「用的什么模型」类两遍）', () => {
    const full =
      '我这边看不到当前对话具体用的是哪个模型。\n\n' +
      '原因: 我是 Cursor 的 Auto, 只做请求路由, 拿不到「当前会话模型名称」这类信息。\n\n' +
      '若要在 openclaw-control-ui 里显示「当前模型」: 需要在 Cursor 的配置/API, 或你们 openclaw 里「选模型/发请求」的那段逻辑里读出模型名, 再在 UI 里展示。\n\n' +
      '如果你把 openclaw 里和「选模型/发请求」相关的配置或代码(或调用链说明)贴出来, 我可以帮你标出该从哪里取这个值; 同一份架构也可以一起标消息去重该加在哪一层。';
    return new Promise((resolve, reject) => {
      const parser = createStreamParser(meta);
      const chunks = [];
      parser.on('data', (c) => chunks.push(c.toString()));
      parser.on('end', () => {
        const sseText = chunks.join('');
        const content = extractContentFromSSE(sseText);
        assert.strictEqual(content, full, '长段落 result 后同内容 assistant 应只出一遍；若此处通过仍出现两遍则多为 Cursor Agent 顺序/格式或客户端渲染问题');
        resolve();
      });
      parser.on('error', reject);
      const lines = [
        JSON.stringify({ type: 'result', result: full }),
        JSON.stringify({
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'text', text: full }] },
        }),
      ];
      const r = new Readable({ read() {} });
      for (const line of lines) r.push(line + '\n');
      r.push(null);
      r.pipe(parser);
    });
  });

  it('仅 assistant 多段无 result 时出兜底', () => {
    return new Promise((resolve, reject) => {
      const parser = createStreamParser(meta);
      const chunks = [];
      parser.on('data', (c) => chunks.push(c.toString()));
      parser.on('end', () => {
        const content = extractContentFromSSE(chunks.join(''));
        assert.ok(content.includes('无可展示内容') || content.includes('thinking'), '仅 assistant 无 result 时出兜底');
        resolve();
      });
      parser.on('error', reject);
      const lines = [
        JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'A' }] } }),
        JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'AB' }] } }),
      ];
      const r = new Readable({ read() {} });
      for (const line of lines) r.push(line + '\n');
      r.push(null);
      r.pipe(parser);
    });
  });

  it('仅 assistant 多段无 result 时出兜底（多段）', () => {
    const a = '问1：什么是更好的？';
    const ab = a + '问2：当前痛点？';
    const abc = ab + '问3：硬约束？';
    return new Promise((resolve, reject) => {
      const parser = createStreamParser(meta);
      const chunks = [];
      parser.on('data', (c) => chunks.push(c.toString()));
      parser.on('end', () => {
        const content = extractContentFromSSE(chunks.join(''));
        assert.ok(content.includes('无可展示内容') || content.includes('thinking'), '仅 assistant 无 result 时出兜底');
        resolve();
      });
      parser.on('error', reject);
      const lines = [
        JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: a }] } }),
        JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: ab }] } }),
        JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: abc }] } }),
      ];
      const r = new Readable({ read() {} });
      for (const line of lines) r.push(line + '\n');
      r.push(null);
      r.pipe(parser);
    });
  });
});

/** 流式兜底：无 result 时推解析异常或无可展示内容 */
describe('流式兜底与仅 result 推送', () => {
  it('流式 0 输出：仅非法 JSON 时推一条「解析异常」提示', () => {
    return new Promise((resolve, reject) => {
      const parser = createStreamParser(meta);
      const chunks = [];
      parser.on('data', (c) => chunks.push(c.toString()));
      parser.on('end', () => {
        const content = extractContentFromSSE(chunks.join(''));
        assert.ok(content.includes('解析异常') || content.includes('未得到可展示内容'), '应收到解析异常类兜底提示');
        resolve();
      });
      parser.on('error', reject);
      const r = new Readable({ read() {} });
      r.push('not json\n');
      r.push('{"type":"user"}\n');
      r.push('{broken\n');
      r.push(null);
      r.pipe(parser);
    });
  });

  it('流式 0 输出：仅有 thinking/heartbeat 时推一条「无可展示内容」提示', () => {
    return new Promise((resolve, reject) => {
      const parser = createStreamParser(meta);
      const chunks = [];
      parser.on('data', (c) => chunks.push(c.toString()));
      parser.on('end', () => {
        const content = extractContentFromSSE(chunks.join(''));
        assert.ok(content.includes('无可展示内容') || content.includes('heartbeat') || content.includes('thinking'), '应收到无可展示内容类兜底提示');
        resolve();
      });
      parser.on('error', reject);
      const lines = [
        JSON.stringify({ type: 'thinking', content: 'The user is asking something.' }),
        JSON.stringify({ type: 'reasoning', content: 'I should respond as the Xiao Li persona.' }),
      ];
      const r = new Readable({ read() {} });
      for (const line of lines) r.push(line + '\n');
      r.push(null);
      r.pipe(parser);
    });
  });

  it('长文本「已发包含当前行」：当前行为已发内容的子串应整行跳过', () => {
    const full = '我这边看不到当前对话具体用的是哪个模型。若要在 openclaw 里显示当前模型需在选模型/发请求逻辑里读出模型名。';
    const substring = '若要在 openclaw 里显示当前模型需在选模型/发请求逻辑里读出模型名。';
    return new Promise((resolve, reject) => {
      const parser = createStreamParser(meta);
      const chunks = [];
      parser.on('data', (c) => chunks.push(c.toString()));
      parser.on('end', () => {
        const content = extractContentFromSSE(chunks.join(''));
        assert.strictEqual(content, full, '只应出 result 整段');
        assert.strictEqual(content.split(substring).length, 2, '子串只作为整段的一部分出现一次');
        resolve();
      });
      parser.on('error', reject);
      const lines = [
        JSON.stringify({ type: 'result', result: full }),
        JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: substring }] } }),
      ];
      const r = new Readable({ read() {} });
      for (const line of lines) r.push(line + '\n');
      r.push(null);
      r.pipe(parser);
    });
  });
});
