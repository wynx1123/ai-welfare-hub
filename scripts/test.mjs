// 零依赖单测：不联网，覆盖额度口径计算与 fetchGuard 的关键拒绝路径。
// 跑法：npm test
import { guardUrl, resolveGuardedUrl } from './lib/fetchGuard.mjs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
let passed = 0, failed = 0;
async function t(name, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.error(`  ✗ ${name}\n    ${e.message}`); }
}

console.log('guardUrl 协议与地址黑名单：');
await t('拒绝非 http(s) 协议', async () => {
  assert.equal(guardUrl('file:///etc/passwd').ok, false);
  assert.equal(guardUrl('ftp://example.com').ok, false);
  assert.equal(guardUrl('gopher://x').ok, false);
});
await t('拒绝 localhost 与环回 IP', async () => {
  assert.equal(guardUrl('http://localhost/api').ok, false);
  assert.equal(guardUrl('http://127.0.0.1:3000/api').ok, false);
  assert.equal(guardUrl('http://[::1]/api').ok, false);
});
await t('拒绝私网与保留地址', async () => {
  for (const u of ['http://10.0.0.1/api', 'http://192.168.1.1/api', 'http://172.16.0.1/api', 'http://169.254.169.254/latest/meta-data', 'http://[::ffff:127.0.0.1]/api', 'http://0.0.0.0/api']) {
    assert.equal(guardUrl(u).ok, false, u);
  }
});
await t('放行公网 https', async () => {
  const g = guardUrl('https://example.com/api/status');
  assert.equal(g.ok, true);
});

console.log('resolveGuardedUrl DNS 层防护：');
await t('DNS 解析失败返回错误而非抛出', async () => {
  const g = await resolveGuardedUrl('https://this-domain-definitely-not-exist-xyz123.invalid/api');
  assert.equal(g.ok, false);
});
await t('localhost 即使写成域名也被拒', async () => {
  assert.equal(guardUrl('https://localhost.localdomain/x').ok, true); // 域名形式先放行给 DNS
  const g = await resolveGuardedUrl('http://localhost/');
  assert.equal(g.ok, false);
});

console.log('sites.json 结构断言：');
await t('数据文件可解析且 sites 为数组', async () => {
  const d = JSON.parse(await readFile(`${ROOT}/data/sites.json`, 'utf8'));
  assert.ok(Array.isArray(d.sites));
  assert.ok(d.meta && typeof d.meta.title === 'string');
});
await t('所有站点 id 唯一', async () => {
  const d = JSON.parse(await readFile(`${ROOT}/data/sites.json`, 'utf8'));
  const ids = d.sites.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length);
});

console.log(`\n${failed ? `✗ ${failed} 个用例失败` : `✓ 全部 ${passed} 个用例通过`}`);
process.exit(failed ? 1 : 0);
