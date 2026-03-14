/**
 * cursor-bridge 本地自动化测试。
 * 通过 fake-agent 模拟 cursor-agent，覆盖 health、models、completions（非流式 + 流式）、多轮对话与“天气”类内容。
 * 不设 CURSOR_FORCE_NON_STREAM，以便 stream: true 时走真实流式路径。
 */

import path from 'path';
import { fileURLToPath } from 'url';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

process.env.NODE_ENV = 'test';
process.env.BRIDGE_PORT = '3848';
process.env.BRIDGE_HOST = '127.0.0.1';
process.env.BRIDGE_API_KEY = '';
process.env.CURSOR_AGENT_BIN = 'node';
process.env.CURSOR_AGENT_SCRIPT = path.join(projectRoot, 'test', 'fixtures', 'fake-agent.js');
process.env.CURSOR_WORKSPACE = projectRoot;
process.env.CURSOR_AGENT_TIMEOUT_MS = '15000';
process.env.CURSOR_FORCE_NON_STREAM = '';

const { server } = await import('../src/server.js');
const port = Number(process.env.BRIDGE_PORT);
const base = `http://${process.env.BRIDGE_HOST}:${port}`;

async function listen() {
  return new Promise((resolve, reject) => {
    server.listen(port, process.env.BRIDGE_HOST, () => resolve());
    server.once('error', reject);
  });
}

function close() {
  return new Promise((resolve) => server.close(() => resolve()));
}

describe('cursor-bridge', () => {
  before(async () => {
    await listen();
  });

  after(async () => {
    await close();
  });

  it('GET /health returns 200 and status', async () => {
    const res = await fetch(`${base}/health`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(typeof body.status, 'string');
    assert.ok(body.cursor_agent === 'available' || body.status === 'ok' || body.status === 'degraded');
  });

  it('GET /v1/models returns 200 and model list', async () => {
    const res = await fetch(`${base}/v1/models`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.data));
    assert.ok(body.data.length >= 1);
    assert.strictEqual(body.data[0].id, 'cursor-agent');
  });

  it('POST /v1/chat/completions (non-stream) 多轮对话 + 天气', async () => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'cursor-agent',
        stream: false,
        messages: [
          { role: 'system', content: '你是助手。' },
          { role: 'user', content: '测试' },
          { role: 'assistant', content: '收到，测试通过。' },
          { role: 'user', content: '今天天气怎么样' },
        ],
      }),
    });
    assert.strictEqual(res.status, 200, `expected 200 got ${res.status}`);
    const body = await res.json();
    assert.ok(body.choices && body.choices[0]);
    const content = body.choices[0].message?.content ?? '';
    assert.ok(content.length > 0, 'content should not be empty');
    assert.ok(/天气|晴|气温|收到|测试/.test(content), `content should mention weather or test reply: ${content}`);
  });

  it('POST /v1/chat/completions (stream) 多轮对话 + 天气', async () => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'cursor-agent',
        stream: true,
        messages: [
          { role: 'system', content: '你是助手。' },
          { role: 'user', content: '今天上海天气怎样' },
        ],
      }),
    });
    assert.strictEqual(res.status, 200, `expected 200 got ${res.status}`);
    const text = await res.text();
    assert.ok(text.includes('data:'), 'response should be SSE');
    assert.ok(/天气|晴|气温|上海|收到/.test(text), `SSE body should contain reply: ${text.slice(0, 300)}`);
    assert.ok(text.includes('[DONE]') || text.includes('finish_reason'), 'should have finish or [DONE]');
  });
});
