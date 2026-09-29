// 站点探测：识别面板类型与公开数据，为 sites.json 收集字段。
// 用法：node scripts/probe.mjs https://example.com [https://another.com ...]
// 出站请求全部走 fetchGuard（协议白名单 + 拒绝内网/环回/保留地址）。
import { safeFetchJson } from './lib/fetchGuard.mjs';

const urls = process.argv.slice(2).filter((u) => /^https?:\/\//.test(u));
if (!urls.length) {
  console.error('用法：node scripts/probe.mjs <站点主页URL...>');
  process.exit(1);
}

function loginMethods(d) {
  const m = [];
  if (d.github_oauth) m.push('GitHub OAuth');
  if (d.linuxdo_oauth) m.push('LinuxDO OAuth');
  if (d.oidc_enabled) m.push('OIDC');
  if (d.telegram_oauth) m.push('Telegram');
  if (d.email_verification) m.push('邮箱验证');
  if (d.password_register_enabled) m.push('邮箱 + 密码');
  return m;
}

async function probeOne(homeUrl) {
  const origin = new URL(homeUrl).origin;
  const out = { origin, lines: [] };
  const [home, st, pr] = await Promise.all([
    safeFetchJson(homeUrl, { timeoutMs: 15000 }),
    safeFetchJson(`${origin}/api/status`, { timeoutMs: 15000 }),
    safeFetchJson(`${origin}/api/pricing`, { timeoutMs: 15000 }),
  ]);
  out.lines.push(`主页: HTTP ${home.status ?? home.reason} · ${home.ms ?? '?'}ms`);
  if (st.ok && st.json) {
    const d = st.json.data ?? st.json;
    out.newApi = true;
    out.systemName = d.system_name ?? null;
    out.lines.push(`面板: ${d.system_name ?? '?'} ${d.version ?? ''}（New API 系）`);
    out.lines.push(`注册开放: ${d.register_enabled} · 密码注册: ${d.password_register_enabled} · 签到: ${d.check_in_enabled ?? d.checkin_enabled} · 充值: ${d.top_up_enabled ?? d.topup_enabled} · quota_per_unit: ${d.quota_per_unit ?? '?'}`);
    out.lines.push(`登录方式: ${loginMethods(d).join(' / ') || '?'}`);
    if (Array.isArray(d.announcements)) {
      for (const a of d.announcements.slice(0, 3)) {
        out.lines.push(`公告[${String(a.created_at ?? '').slice(0, 10)}]: ${String(a.content ?? '').replace(/\s+/g, ' ').slice(0, 160)}`);
      }
    }
  } else {
    out.lines.push(`/api/status: ${st.status ?? st.reason}（非 New API 系或接口不公开）`);
  }
  if (pr.ok && pr.json) {
    const arr = Array.isArray(pr.json?.data) ? pr.json.data : Array.isArray(pr.json) ? pr.json : [];
    out.modelsCount = arr.length;
    out.lines.push(`定价: ${arr.length} 个模型，样例: ${arr.slice(0, 6).map((m) => m.model_name).join(', ')}`);
  } else {
    out.lines.push(`/api/pricing: ${pr.status ?? pr.reason}`);
  }
  return out;
}

const results = await Promise.all(urls.map(probeOne));
for (const r of results) {
  console.log(`\n===== ${r.origin} =====`);
  for (const l of r.lines) console.log(l);
}
