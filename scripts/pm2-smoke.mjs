#!/usr/bin/env node
/**
 * Phase 2：pm2 部署后烟雾校验
 * 请求 /health 与 /config，两者均 200 则 exit 0，否则 exit 1。
 * 用法：桥已启动（如 pm2 start 后）执行 node scripts/pm2-smoke.mjs [baseUrl]
 */

const BASE = process.argv[2] || 'http://127.0.0.1:3847';

async function main() {
  let ok = true;
  try {
    const [health, config] = await Promise.all([
      fetch(`${BASE}/health`).then((r) => r.status),
      fetch(`${BASE}/config`).then((r) => r.status),
    ]);
    if (health !== 200) {
      console.error('[pm2-smoke] GET /health ->', health);
      ok = false;
    }
    if (config !== 200) {
      console.error('[pm2-smoke] GET /config ->', config);
      ok = false;
    }
    if (ok) console.log('[pm2-smoke] OK', BASE);
  } catch (e) {
    console.error('[pm2-smoke]', e.message);
    ok = false;
  }
  process.exit(ok ? 0 : 1);
}

main();
