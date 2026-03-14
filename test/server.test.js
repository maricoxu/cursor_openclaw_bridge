/**
 * Phase 1 测试：server 路由与错误响应（不调用真实 cursor-agent）
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import http from 'http';

process.env.NODE_ENV = 'test';
process.env.BRIDGE_API_KEY = '';

const serverPromise = (async () => {
  const mod = await import('../src/server.js');
  const s = mod.server;
  await new Promise((resolve) => {
    s.listen(0, '127.0.0.1', () => resolve());
  });
  const a = s.address();
  return { server: s, baseUrl: `http://127.0.0.1:${a.port}` };
})();

function get(baseUrl, path) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    http.get(url, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', reject);
  });
}

function post(baseUrl, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const opts = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
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

describe('server', () => {
  it('GET /v1/models 返回 200 与模型列表', async () => {
    const { baseUrl } = await serverPromise;
    const res = await get(baseUrl, '/v1/models');
    assert.strictEqual(res.status, 200);
    const data = JSON.parse(res.body);
    assert.strictEqual(data.object, 'list');
    assert.ok(Array.isArray(data.data));
    assert.ok(data.data.some((m) => m.id === 'cursor-agent'));
  });

  it('GET 未知路径返回 404', async () => {
    const { baseUrl } = await serverPromise;
    const res = await get(baseUrl, '/v1/unknown');
    assert.strictEqual(res.status, 404);
    const data = JSON.parse(res.body);
    assert.ok(data.error && data.error.message);
  });

  it('POST /v1/chat/completions 无 body 或非法 JSON 返回 400', async () => {
    const { baseUrl } = await serverPromise;
    const r1 = await post(baseUrl, '/v1/chat/completions', 'not json');
    assert.strictEqual(r1.status, 400);
    const r2 = await post(baseUrl, '/v1/chat/completions', '{}');
    assert.strictEqual(r2.status, 400);
    const r3 = await post(baseUrl, '/v1/chat/completions', '{"messages":[]}');
    assert.strictEqual(r3.status, 400);
  });

  it('POST /v1/chat/completions 缺少 messages 返回 400', async () => {
    const { baseUrl } = await serverPromise;
    const res = await post(baseUrl, '/v1/chat/completions', { model: 'cursor-agent' });
    assert.strictEqual(res.status, 400);
    const data = JSON.parse(res.body);
    assert.ok(data.error && data.error.message.includes('messages'));
  });

  it('关闭 server 便于进程退出', async () => {
    const { server } = await serverPromise;
    server.close();
  });
});
