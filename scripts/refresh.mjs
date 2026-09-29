// 抓取各站点公开接口，生成 data/live.json 实时快照。
// 探测内容：主页可达性（状态/延迟）、New API 系 /api/status（面板版本/签到/注册开关/登录方式）、
// /api/pricing（模型清单）。单站失败不影响整体：无旧快照则该站标 offline，有则沿用旧数据并标 stale。
import { readFile, writeFile } from 'node:fs/promises';
import { resolveGuardedUrl, safeFetchJson } from './lib/fetchGuard.mjs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CONCURRENCY = 4;
const TIMEOUT_MS = 15000;

const sitesRaw = await readFile(`${ROOT}/data/sites.json`, 'utf8');
const data = JSON.parse(sitesRaw);
const prev = await readFile(`${ROOT}/data/live.json`, 'utf8')
  .then((t) => JSON.parse(t))
  .catch(() => null);
const prevById = new Map((prev?.sites ?? []).map((s) => [s.id, s]));

// New API 系面板的登录方式映射：status 接口返回 oauth flag，这里翻成可读文案
function mapLoginMethods(st) {
  const m = [];
  if (st?.github_oauth === true) m.push('GitHub OAuth');
  if (st?.linuxdo_oauth === true) m.push('LinuxDO OAuth');
  if (st?.oidc_enabled === true) m.push('OIDC');
  if (st?.telegram_oauth === true) m.push('Telegram');
  if (st?.email_verification === true) m.push('邮箱验证');
  if (st?.password_register_enabled === true || st?.register_enabled === true) m.push('邮箱 + 密码');
  return m;
}

function mapStatusApi(json) {
  if (!json || typeof json !== 'object') return {};
  const st = json.data ?? json;
  return {
    systemName: st.system_name ?? null,
    version: st.version ?? null,
    registerOpen: typeof st.register_enabled === 'boolean' ? st.register_enabled : null,
    passwordRegister: typeof st.password_register_enabled === 'boolean' ? st.password_register_enabled : null,
    checkinEnabled: typeof st.check_in_enabled === 'boolean' ? st.check_in_enabled : (typeof st.checkin_enabled === 'boolean' ? st.checkin_enabled : null),
    topupEnabled: typeof st.top_up_enabled === 'boolean' ? st.top_up_enabled : (typeof st.topup_enabled === 'boolean' ? st.topup_enabled : null),
    loginMethods: mapLoginMethods(st),
    quotaPerUnit: typeof st.quota_per_unit === 'number' ? st.quota_per_unit : null,
    announcements: Array.isArray(st.announcements)
      ? st.announcements.slice(0, 3).map((a) => ({ id: a.id ?? null, date: a.created_at ? String(a.created_at).slice(0, 10) : null, text: String(a.content ?? a.text ?? '').slice(0, 300) }))
      : [],
  };
}

// pricing 接口按模型名过滤出主流 Coding 模型，避免快照爆炸
const MODEL_KEEP = /claude|gpt-5|gpt-4|codex|glm|deepseek|gemini|grok|qwen|kimi|doubao|mini-max|minimax/i;
function mapPricingApi(json) {
  const arr = Array.isArray(json?.data) ? json.data : Array.isArray(json) ? json : [];
  return arr
    .filter((m) => typeof m?.model_name === 'string' && MODEL_KEEP.test(m.model_name))
    .slice(0, 80)
    .map((m) => ({
      name: m.model_name,
      protocols: Array.isArray(m.supported_endpoint) ? m.supported_endpoint.map(String) : (m.supported_endpoint ? [String(m.supported_endpoint)] : []),
      inputPerMTok: typeof m.quota_type === 'number' && m.quota_type === 0 ? null : (typeof m.model_price === 'number' ? m.model_price : null),
    }));
}

async function probeSite(site) {
  const out = {
    id: site.id,
    checkedAt: new Date().toISOString(),
    online: false, latencyMs: null, error: null,
    apiOk: false, pricingOk: false,
    systemName: null, version: null,
    registerOpen: null, passwordRegister: null, checkinEnabled: null,
    loginMethods: [], topupEnabled: null, quotaPerUnit: null, announcements: [],
    models: null, modelsCount: null, mirrors: [],
  };

  // 主域名 + 镜像域名依次探测，选第一个可达的作为数据源（大陆网络下主域名常被墙，镜像兜底）
  const candidates = [site.homeUrl, ...(site.mirrors ?? []).map((m) => m.homeUrl)].filter(Boolean);
  let baseHome = null;
  let lastErr = null;
  for (const homeUrl of candidates) {
    const g = await resolveGuardedUrl(homeUrl);
    if (!g.ok) { lastErr = `homeUrl blocked: ${g.reason}`; continue; }
    const home = await safeFetchJson(homeUrl, { timeoutMs: TIMEOUT_MS });
    if (home.status != null && home.status < 500) { baseHome = { homeUrl, res: home }; break; }
    lastErr = home.reason ?? `HTTP ${home.status}`;
  }
  if (!baseHome) {
    out.error = lastErr ?? 'unreachable';
    return out;
  }
  out.online = true;
  out.latencyMs = baseHome.res.ms;
  // 探测用的是哪个域名（主域名失败时即镜像），status/pricing 也跟着用同一域名，保持同源
  const origin = new URL(baseHome.homeUrl).origin;
  const swapOrigin = (u) => { try { return new URL(new URL(u).pathname + new URL(u).search, origin).href; } catch { return u; } };

  if (site.statusApi) {
    const r = await safeFetchJson(swapOrigin(site.statusApi), { timeoutMs: TIMEOUT_MS });
    if (r.ok && r.json) { Object.assign(out, mapStatusApi(r.json)); out.apiOk = true; }
    else if (r.status != null && r.status < 500) out.apiOk = true; // 在线但接口非公开 JSON
  }
  if (site.pricingApi) {
    const r = await safeFetchJson(swapOrigin(site.pricingApi), { timeoutMs: TIMEOUT_MS });
    if (r.ok && (Array.isArray(r.json?.data) || Array.isArray(r.json))) { out.models = mapPricingApi(r.json); out.modelsCount = out.models.length; out.pricingOk = true; }
  }
  for (const m of site.mirrors ?? []) {
    const rm = await safeFetchJson(m.homeUrl, { timeoutMs: TIMEOUT_MS });
    out.mirrors.push({ label: m.label, online: rm.status != null && rm.status < 500, latencyMs: rm.ms });
  }
  return out;
}

// 抓取失败时沿用上次快照的对应字段，页面不会被刷空
function mergeStale(prevSite, fresh) {
  if (!prevSite) return { ...fresh, dataStale: false, staleFrom: null, staleFields: [] };
  const staleFields = [];
  const merged = { ...fresh };
  if (!fresh.apiOk && prevSite.apiOk) {
    for (const f of ['systemName', 'version', 'registerOpen', 'passwordRegister', 'checkinEnabled', 'loginMethods', 'topupEnabled', 'quotaPerUnit', 'announcements']) {
      if (fresh[f] == null || (Array.isArray(fresh[f]) && !fresh[f].length)) { merged[f] = prevSite[f]; staleFields.push(f); }
    }
  }
  if (!fresh.pricingOk && prevSite.pricingOk && !fresh.modelsCount) { merged.models = prevSite.models; merged.modelsCount = prevSite.modelsCount; staleFields.push('models'); }
  merged.dataStale = staleFields.length > 0;
  merged.staleFrom = merged.dataStale ? (prevSite.staleFrom ?? fresh.checkedAt) : null;
  return merged;
}

async function runPool(items, worker) {
  const results = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      try { results[idx] = await worker(items[idx], idx); }
      catch (e) { results[idx] = { id: items[idx].id, error: String(e?.message ?? e) }; }
    }
  }));
  return results;
}

const fresh = await runPool(data.sites, probeSite);
const merged = fresh.map((f) => mergeStale(prevById.get(f.id), f));
const live = { generatedAt: new Date().toISOString(), sites: merged };
await writeFile(`${ROOT}/data/live.json`, JSON.stringify(live, null, 2) + '\n', 'utf8');

const online = merged.filter((s) => s.online).length;
const stale = merged.filter((s) => s.dataStale).length;
const errs = merged.filter((s) => s.error).map((s) => `${s.id}: ${s.error}`);
console.log(`✓ refresh 完成：${merged.length} 站探测，${online} 在线，${stale} 沿用旧快照`);
if (errs.length) console.log('  探测异常：\n  ' + errs.join('\n  '));
