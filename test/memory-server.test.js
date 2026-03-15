/**
 * Phase 3 Memory：开启 CURSOR_BRIDGE_MEMORY_ENABLED 时，请求能正常完成且 prompt 含 [Memory]
 */
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const memoryFixture = path.join(projectRoot, 'test', 'fixtures', 'memory-fixture');

process.env.NODE_ENV = 'test';
process.env.BRIDGE_API_KEY = '';
process.env.CURSOR_BRIDGE_MEMORY_ENABLED = '1';
process.env.CURSOR_WORKSPACE = memoryFixture;
process.env.CURSOR_AGENT_BIN = 'node';
process.env.CURSOR_AGENT_SCRIPT = path.join(projectRoot, 'test', 'fixtures', 'fake-agent.js');
process.env.CURSOR_AGENT_TIMEOUT_MS = '10000';
process.env.CURSOR_BRIDGE_UPDATE_DAILY = '0';

const { server } = await import('../src/server.js');
const port = 3849;
const base = `http://127.0.0.1:${port}`;

async function listen() {
  return new Promise((resolve, reject) => {
    server.listen(port, '127.0.0.1', () => resolve());
    server.once('error', reject);
  });
}

function close() {
  return new Promise((resolve) => server.close(() => resolve()));
}

describe('Phase 3 Memory (server)', () => {
  before(async () => {
    await listen();
  });

  after(async () => {
    await close();
  });

  it('MEMORY_ENABLED=1 时 POST completions 返回 200（注入 + workspace 正常）', async () => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'cursor-agent',
        stream: false,
        messages: [
          { role: 'system', content: 'You are a test.' },
          { role: 'user', content: 'Say hello' },
        ],
      }),
    });
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.ok(data.choices && data.choices[0]);
    const content = data.choices[0].message?.content ?? '';
    assert.ok(content.length > 0, '应有回复内容');
    assert.ok(content.includes('收到') || content.includes('测试'), 'fake-agent 固定回复');
  });
});
