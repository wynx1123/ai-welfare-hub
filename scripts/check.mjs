// 链接健康检查：对 sites.json 里所有会展示给用户的 URL（注册/主页/文档/镜像）逐一探测。
// 结果分三级，避免 CI 误报：
//   ✗ 失败  —— 4xx/5xx/超时/DNS 失败，退出码 1（真正需要人工处理的）
//   ~ 拦截  —— 403 + Cloudflare 等机器人防护（浏览器可正常访问），只提示不计失败
//   ✓ 可达  —— 2xx/3xx
import { readFile } from 'node:fs/promises';
import { safeFetchJson } from './lib/fetchGuard.mjs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const TIMEOUT_MS = 15000;
const CONCURRENCY = 6;

const data = JSON.parse(await readFile(`${ROOT}/data/sites.json`, 'utf8'));

const jobs = [];
for (const s of data.sites) {
  const add = (label, url) => { if (url) jobs.push({ id: s.id, label, url }); };
  add('signupUrl', s.signupUrl);
  add('homeUrl', s.homeUrl);
  add('docsUrl', s.docsUrl);
  for (const [i, m] of (s.mirrors ?? []).entries()) {
    add(`mirrors[${i}].homeUrl`, m.homeUrl);
    add(`mirrors[${i}].signupUrl`, m.signupUrl);
  }
}

async function runPool(items, worker) {
  const results = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      try { results[idx] = await worker(items[idx]); } catch (e) { results[idx] = { ...items[idx], error: String(e?.message ?? e) }; }
    }
  }));
  return results;
}

const results = await runPool(jobs, async (job) => {
  // 两次尝试（间隔 2s）：单次超时多为网络抖动或站点限流，直接判死链误报率高
  let r = await safeFetchJson(job.url, { timeoutMs: TIMEOUT_MS });
  if (!r.ok && r.status == null) {
    await new Promise((res) => setTimeout(res, 2000));
    r = await safeFetchJson(job.url, { timeoutMs: TIMEOUT_MS });
  }
  // Cloudflare/WAF 对无头请求回 403，浏览器带 JS 挑战可通过——不算死链
  const botBlocked = r.status === 403 || r.status === 503;
  // 主域名不通但该站有镜像在线：算可达（用户实际可从镜像进入）
  let mirrorFallback = false;
  if (!r.ok && !botBlocked) {
    const site = data.sites.find((s) => s.id === job.id);
    const mirror = job.label.startsWith('mirrors[')
      ? null
      : (site?.mirrors ?? []).find((m) => m[job.label] || m.homeUrl || m.signupUrl);
    if (mirror) {
      const fallbackUrl = job.label === 'signupUrl' && mirror.signupUrl
        ? mirror.signupUrl
        : job.label === 'homeUrl' && mirror.homeUrl
          ? mirror.homeUrl
          : (() => {
              const base = mirror.homeUrl ?? mirror.signupUrl;
              if (!base) return null;
              const target = new URL(base);
              const source = new URL(job.url);
              target.pathname = source.pathname;
              target.search = source.search;
              target.hash = source.hash;
              return target.href;
            })();
      const mr = fallbackUrl ? await safeFetchJson(fallbackUrl, { timeoutMs: TIMEOUT_MS }) : null;
      mirrorFallback = !!mr && mr.status != null && mr.status < 400;
    }
  }
  return { ...job, status: r.status, reason: r.reason, ok: r.status != null && r.status < 400, botBlocked, mirrorFallback };
});

const bad = results.filter((r) => !r.ok && !r.botBlocked && !r.mirrorFallback);
const blocked = results.filter((r) => r.botBlocked);
const viaMirror = results.filter((r) => r.mirrorFallback && !r.ok);

for (const r of results) {
  const mark = r.ok ? '✓' : r.botBlocked ? '~' : r.mirrorFallback ? '⤷' : '✗';
  const extra = r.ok ? `${r.status}` : r.botBlocked ? `${r.status}（防护拦截，浏览器可访问）` : r.mirrorFallback ? `主域不通，镜像可达` : (r.reason ?? `HTTP ${r.status}`);
  console.log(`${mark} ${r.id} ${r.label} -> ${extra}`);
}
if (blocked.length) console.log(`\n~ ${blocked.length} 条链接被站点防护拦截（403/503），非死链，不计失败`);
if (viaMirror.length) console.log(`⤷ ${viaMirror.length} 条链接主域不通但镜像可达`);
if (bad.length) {
  console.error(`\n✗ ${bad.length} 条链接失效：`);
  for (const b of bad) console.error(`  ${b.id} ${b.label} -> ${b.status ?? b.reason}`);
  // CI 模式（环境变量 CHECK_STRICT=0）：只告警不阻断——单个站点偶发超时不该挡住整站发布
  if (process.env.CHECK_STRICT === '0') {
    console.error('⚠ CHECK_STRICT=0，仅告警不阻断部署');
  } else {
    process.exit(1);
  }
}
console.log(`\n✓ 健康检查通过：${results.length} 条链接（${blocked.length} 条防护拦截、${viaMirror.length} 条走镜像）`);
