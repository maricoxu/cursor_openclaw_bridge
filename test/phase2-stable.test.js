/**
 * Phase 2：稳定运行 — 单测
 * 覆盖：健康检查端点、配置端点、错误响应契约、OpenClaw fallback（503/504 与 error 体）
 */

import path from 'path';
import { fileURLToPath } from 'url';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import http from 'http';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

process.env.NODE_ENV = 'test';
process.env.BRIDGE_API_KEY = '';
process.env.CURSOR_AGENT_BIN = 'node';
process.env.CURSOR_AGENT_SCRIPT = path.join(projectRoot, 'test', 'fixtures', 'fake-agent-fail.js');
process.env.FAIL_MODE = 'not_logged_in';
process.env.CURSOR_WORKSPACE = projectRoot;
process.env.CURSOR_AGENT_TIMEOUT_MS = '10000';

const { server } = await import('../src/server.js');
let baseUrl = '';

async function listen() {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const a = server.address();
      baseUrl = `http://127.0.0.1:${a.port}`;
      resolve();
    });
  });
}

function close() {
  return new Promise((resolve) => server.close(() => resolve()));
}

function get(pathname) {
  return new Promise((resolve, reject) => {
    const url = new URL(pathname, baseUrl);
    http.get(url, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', reject);
  });
}

function post(pathname, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(pathname, baseUrl);
    const opts = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    };
    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

describe('Phase 2: 稳定运行', () => {
  before(async () => await listen());
  after(async () => await close());

  describe('健康检查端点', () => {
    it('GET /health 返回 200，body 含 status、cursor_agent、version', async () => {
      const res = await get('/health');
      assert.strictEqual(res.status, 200);
      const data = JSON.parse(res.body);
      assert.strictEqual(typeof data.status, 'string');
      assert.ok(data.status === 'ok' || data.status === 'degraded');
      assert.strictEqual(typeof data.cursor_agent, 'string');
      assert.strictEqual(typeof data.version, 'string');
    });

    it('GET / 与 /health 行为一致', async () => {
      const res = await get('/');
      assert.strictEqual(res.status, 200);
      const data = JSON.parse(res.body);
      assert.ok('status' in data && 'cursor_agent' in data && 'version' in data);
    });
  });

  describe('配置端点', () => {
    it('GET /config 返回 200，含 envFileExists、cwd、CURSOR_WORKSPACE、CURSOR_AGENT_BIN、CURSOR_AGENT_TIMEOUT_MS', async () => {
      const res = await get('/config');
      assert.strictEqual(res.status, 200);
      const data = JSON.parse(res.body);
      assert.strictEqual(typeof data.envFileExists, 'boolean');
      assert.strictEqual(typeof data.cwd, 'string');
      assert.strictEqual(typeof data.CURSOR_WORKSPACE, 'string');
      assert.strictEqual(typeof data.CURSOR_AGENT_BIN, 'string');
      assert.strictEqual(typeof data.CURSOR_AGENT_TIMEOUT_MS, 'number');
      assert.ok(data.BRIDGE_API_KEY === '(set)' || data.BRIDGE_API_KEY === '(empty)');
    });
  });

  describe('错误响应契约（OpenAI 兼容 error 体）', () => {
    it('GET 未知路径返回 404，body 为 { error: { message, type } }', async () => {
      const res = await get('/v1/unknown');
      assert.strictEqual(res.status, 404);
      const data = JSON.parse(res.body);
      assert.ok(data.error && typeof data.error.message === 'string');
      assert.ok(data.error.type === 'invalid_request' || data.error.type);
    });

    it('POST /v1/chat/completions 无 body 返回 400，含 error.message', async () => {
      const res = await post('/v1/chat/completions', '');
      assert.strictEqual(res.status, 400);
      const data = JSON.parse(res.body);
      assert.ok(data.error && typeof data.error.message === 'string');
    });
  });

  describe('OpenClaw fallback：agent 不可用返回 503 与 error 体', () => {
    it('agent 返回 not logged in 时，completions 返回 503，body 含 error.message 与 code', async () => {
      const res = await post('/v1/chat/completions', {
        model: 'cursor-agent',
        stream: false,
        messages: [{ role: 'user', content: 'hi' }],
      });
      assert.strictEqual(res.status, 503, `expected 503 got ${res.status} body: ${res.body}`);
      const data = JSON.parse(res.body);
      assert.ok(data.error && typeof data.error.message === 'string');
      assert.ok(data.error.code === 'bridge_agent_not_ready' || data.error.code, `error.code: ${data.error.code}`);
    });
  });
});
