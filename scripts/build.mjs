// 从 data/sites.json + data/live.json 生成静态聚合页（docs/index.html）与 README.md。
// 页面纯静态 + 原生 JS：搜索、标签筛选、排序都跑在浏览器里，无需任何前端框架与构建链。
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const ROOT = fileURLToPath(new URL('..', import.meta.url));

const [sitesRaw, liveRaw, freeApisRaw] = await Promise.all([
  readFile(`${ROOT}/data/sites.json`, 'utf8'),
  readFile(`${ROOT}/data/live.json`, 'utf8').catch(() => null),
  readFile(`${ROOT}/data/free-apis.json`, 'utf8').catch(() => null),
]);
const data = JSON.parse(sitesRaw);
const live = liveRaw ? JSON.parse(liveRaw) : null;
const freeApis = freeApisRaw ? JSON.parse(freeApisRaw) : null;
const liveById = new Map((live?.sites ?? []).map((s) => [s.id, s]));

function esc(s) {
  return String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

// ---------- 首日额度口径：注册 + 邀请 + 签到（有则加，缺项跳过） ----------
function firstDayCredits(site) {
  const c = site.credits ?? {};
  if (c.unit === 'point') return null; // 积分制不折算美元，展示原始文案
  const parts = [];
  if (typeof c.signup === 'number') parts.push(c.signup);
  if (typeof c.invite === 'number') parts.push(c.invite);
  if (typeof c.dailyCheckin === 'number') parts.push(c.dailyCheckin);
  if (!parts.length) return null;
  const total = parts.reduce((a, b) => a + b, 0);
  return { total, approx: !!c.approx };
}

function fmtUsd(n) {
  if (n == null) return '—';
  const r = Math.round(n * 100) / 100;
  return `$${r % 1 === 0 ? r.toFixed(0) : r.toFixed(2)}`;
}

// ---------- 供浏览器端渲染的精简数据 ----------
const pageData = data.sites.map((site) => {
  const lv = liveById.get(site.id) ?? {};
  const fc = firstDayCredits(site);
  return {
    id: site.id,
    name: site.name,
    subtitle: site.subtitle ?? '',
    recommended: !!site.recommended,
    tags: site.tags ?? [],
    highlights: site.highlights ?? [],
    signupUrl: site.signupUrl,
    homeUrl: site.homeUrl,
    docsUrl: site.docsUrl ?? null,
    endpoints: site.endpoints ?? {},
    register: site.register?.methods ?? [],
    mirrors: (site.mirrors ?? []).map((m) => ({ label: m.label, homeUrl: m.homeUrl, signupUrl: m.signupUrl })),
    caveats: site.caveats ?? [],
    credits: site.credits ?? {},
    firstDayUsd: fc ? fc.total : null,
    approx: fc ? fc.approx : false,
    online: lv.online ?? null,
    latencyMs: lv.latencyMs ?? null,
    checkinEnabled: lv.checkinEnabled ?? null,
    modelsCount: Array.isArray(lv.models) ? lv.models.length : null,
    topupEnabled: lv.topupEnabled ?? null,
  };
});

  const generatedAt = live?.generatedAt ?? null;

  // ---------- 官方免费 API 分区数据 ----------
  const freeApiJson = freeApis ? JSON.stringify(freeApis).replaceAll('</', '<\\/') : null;

// ---------- README ----------
function readmeSiteRow(site) {
  const lv = liveById.get(site.id) ?? {};
  const fc = firstDayCredits(site);
  const c = site.credits ?? {};
  const parts = [];
  if (typeof c.signup === 'number') parts.push(`注册 ${fmtUsd(c.signup)}`);
  if (typeof c.invite === 'number') parts.push(`邀请 ${fmtUsd(c.invite)}`);
  if (typeof c.dailyCheckin === 'number') parts.push(`签到 ${fmtUsd(c.dailyCheckin)}`);
  if (typeof c.dailyQuota === 'number') parts.push(`每日池 ${fmtUsd(c.dailyQuota)}`);
  const status = lv.online === true ? '🟢 在线' : lv.online === false ? '🔴 离线' : '⚪ 未知';
  const protocols = Object.entries(site.endpoints ?? {}).filter(([, v]) => v).map(([k]) => k).join(' / ') || '—';
  const totalUsd = data.sites.reduce((acc, s) => { const f = firstDayCredits(s); return acc + (f ? f.total : 0); }, 0);
  return `| [${site.name}](${site.signupUrl}) | ${status} | ${fc ? `${fc.approx ? '~' : ''}${fmtUsd(fc.total)}` : c.unit === 'point' ? `${c.invite ?? ''} 积分` : '—'} | ${parts.join(' + ') || '—'} | ${c.dailyCheckin != null ? '✅' : '—'} | ${protocols} | ${Array.isArray(lv.models) ? lv.models.length : '—'} |`;
}

function buildReadme() {
  const totalUsd = data.sites.reduce((acc, s) => { const f = firstDayCredits(s); return acc + (f ? f.total : 0); }, 0);
  const sitesTable = data.sites
    .map((s) => `| [${s.name}](${s.signupUrl}) | ${s.subtitle ?? ''} |`)
    .join('\n');
  const detailRows = data.sites.map(readmeSiteRow).join('\n');
  const genLine = generatedAt ? `> 数据快照：${generatedAt.replace('T', ' ').slice(0, 16)} UTC，由 GitHub Actions 自动抓取更新。` : '> 尚无实时快照，先运行 `npm run refresh`。';

  // ---------- 官方免费 API 分区（itsfree.ai 整理） ----------
  const providersTable = freeApis?.providers?.length
    ? freeApis.providers.map((p) => `| [${p.name}](${p.url}) | ${p.freeTier} | ${p.context} | ${p.signup} | ${p.models} | \`${p.baseUrl}\` |`).join('\n')
    : '';
  const moreLine = freeApis?.more?.length
    ? `\n**还有 13 家**：${freeApis.more.map((m) => `[${m.name}](${m.url})（${m.freeTier}）`).join(' · ')}\n`
    : '';
  const freeApiSection = providersTable ? `
## 🏢 官方免费 API（公益站之外的保底方案）

公益站随时可能关停或改规则，各家平台的**官方免费层**是更稳的保底：注册即用、长期有效、不经过第三方中转。数据整理自 [itsfree.ai](https://itsfree.ai/)（@midudev 出品的官方免费 API 目录，完整目录含 25 家 provider / 463 个免费模型 / 9 种本地运行时）。

| Provider | 免费额度 | 上下文 | 注册 | 模型数 | Base URL |
|---|---|---|---|---|---|
${providersTable}
${moreLine}
> 国内直连推荐：ModelScope 魔搭（阿里）、Z.ai 智谱、AMD Radeon Cloud（中国站）；不想注册的可用 LLM7.io / OVHcloud。
` : '';

  return `# ${data.meta.title}

> ${data.meta.tagline}

[![GitHub Stars](https://img.shields.io/github/stars/wynx1123/ai-welfare-hub?style=social)](https://github.com/wynx1123/ai-welfare-hub/stargazers)
[![Live Status](https://img.shields.io/badge/%E6%8E%A2%E6%B4%BB-%E8%87%AA%E5%8A%A8%E6%9B%B4%E6%96%B0-brightgreen)](${data.meta.pagesUrl || 'https://wynx1123.github.io/ai-welfare-hub/'})

${genLine}

**当前收录 ${data.sites.length} 个站点**，美元计价站全部注册首日合计约 **${fmtUsd(totalUsd)}** 额度。

**搜到这的你可能在找**：Claude Code 免费额度 / 公益站 / New API 中转 / Codex 白嫖 / Cursor 免费用 / AI API 公益站导航 / claude-opus 免费 / gpt 免费接口 —— 这里全都有，而且每 6 小时自动探活，不会点进去才发现站挂了。

## 🚀 快速上车

| 站点 | 状态 | 首日可得 | 额度构成 | 每日签到 | 协议 | 模型数 |
|---|---|---|---|---|---|---|
${detailRows}

## 📚 站点速览

| 站点 | 定位 |
|---|---|
${sitesTable}
${freeApiSection}
## 🧰 仓库结构

| 文件 | 作用 |
|---|---|
| \`data/sites.json\` | **唯一数据源**：站点信息与注册链接，加站只改这里 |
| \`data/live.json\` | 自动抓取的实时快照（在线状态/延迟/模型/签到开关） |
| \`scripts/validate.mjs\` | 数据校验（URL 合法性、字段完整性、防重复） |
| \`scripts/refresh.mjs\` | 抓取各站公开接口生成 live.json，失败沿用旧快照 |
| \`scripts/build.mjs\` | 生成 README.md 与 docs/index.html 静态页 |
| \`scripts/check.mjs\` | 链接健康检查，失效即报警 |
| \`scripts/lib/fetchGuard.mjs\` | 出站请求安全层（协议白名单 + 拒绝内网/环回/保留地址） |

## 🤝 收录新的福利站

1. 编辑 \`data/sites.json\`，在 \`sites\` 数组追加一个站点对象（字段说明见下）
2. 本地跑 \`npm run all\`（校验 → 抓快照 → 生成页面 → 健康检查）
3. 提交 PR；合并后 GitHub Pages 自动更新

\`sites.json\` 单站点字段速查：

\`\`\`jsonc
{
  "id": "my-site",                  // 唯一 id：小写字母/数字/连字符
  "name": "站点名",
  "subtitle": "一句话定位",
  "recommended": true,              // 是否推荐（卡片高亮）
  "credits": {                      // 额度口径（美元）；积分制填 "unit": "point"
    "signup": 100, "invite": 50, "dailyCheckin": 25, "approx": false
  },
  "signupUrl": "https://...",       // 注册链接（可带邀请参数）
  "homeUrl": "https://...",         // 主页
  "docsUrl": "https://...",         // 文档（可选）
  "statusApi": "https://.../api/status",   // New API 系面板状态接口（可选，用于探活）
  "pricingApi": "https://.../api/pricing", // 定价接口（可选）
  "mirrors": [ { "label": "备用域名", "homeUrl": "...", "signupUrl": "..." } ],
  "tags": ["公益站", "免费额度"],
  "highlights": ["卖点 1", "卖点 2"],
  "endpoints": { "anthropic": "https://...", "openai": "https://.../v1" },
  "register": { "methods": ["GitHub OAuth"] },
  "caveats": ["注意事项"],
  "community": ["Discord: https://..."]
}
\`\`\`

## ❓ 常见问题

- **额度不到账**：多数面板要求注册后退出重登一次才显示；邀请额度需从邀请链接进入注册。
- **401 / 无效 Key**：确认 Base URL 协议与客户端匹配（Anthropic 填根地址，OpenAI 兼容填 \`/v1\`）。
- **公益站能撑多久**：不承诺 SLA，随时可能改规则或关站，重要数据别依赖单一站点。

## ⚠️ 免责声明

本页仅为信息聚合，与收录站点无隶属关系，不承诺可用性。请勿将生产密钥、隐私数据、企业代码交给来源不明的中转服务。部分站点为支持充值的中转站而非纯公益站，请自行甄别。

---

MIT License
`;
}

// ---------- 静态页 ----------
function buildHtml() {
  const totalUsd = pageData.reduce((acc, s) => acc + (s.firstDayUsd ?? 0), 0);
  // JSON 塞进 <script type="application/json">：只转义 </script> 防提前闭合，其余保持字面（实体转义会破坏 JSON.parse）
  const json = JSON.stringify({ meta: data.meta, generatedAt, sites: pageData }).replaceAll('</', '<\\/');
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(data.meta.title)}</title>
<meta name="description" content="${esc(data.meta.tagline)}">
<meta name="keywords" content="${esc((data.meta.keywords ?? []).join(', '))}">
<style>
:root {
  --bg: #f6f7f9; --card: #ffffff; --text: #1a1d21; --muted: #6b7280;
  --accent: #2563eb; --accent-soft: #eff4ff; --border: #e5e7eb;
  --green: #059669; --red: #dc2626; --amber: #d97706; --tag: #eef1f4;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0f1115; --card: #171a20; --text: #e6e8ec; --muted: #9aa1ac;
    --accent: #60a5fa; --accent-soft: #1a2436; --border: #2a2f38;
    --green: #34d399; --red: #f87171; --amber: #fbbf24; --tag: #232830;
  }
}
* { box-sizing: border-box; }
body { margin: 0; font-family: -apple-system, "Segoe UI", "Microsoft YaHei", "PingFang SC", sans-serif; background: var(--bg); color: var(--text); line-height: 1.6; }
.wrap { max-width: 1080px; margin: 0 auto; padding: 24px 16px 64px; }
header h1 { margin: 8px 0 4px; font-size: 26px; }
header p { margin: 0 0 6px; color: var(--muted); }
.meta-line { font-size: 13px; color: var(--muted); }
.stats { display: flex; gap: 12px; flex-wrap: wrap; margin: 18px 0; }
.stat { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 12px 18px; min-width: 120px; }
.stat b { display: block; font-size: 22px; }
.stat span { font-size: 12px; color: var(--muted); }
.controls { display: flex; gap: 10px; flex-wrap: wrap; margin: 14px 0 6px; align-items: center; }
#q { flex: 1; min-width: 220px; padding: 10px 14px; border: 1px solid var(--border); border-radius: 10px; background: var(--card); color: var(--text); font-size: 14px; outline: none; }
#q:focus { border-color: var(--accent); }
select { padding: 10px; border: 1px solid var(--border); border-radius: 10px; background: var(--card); color: var(--text); font-size: 14px; }
#tags { display: flex; gap: 8px; flex-wrap: wrap; margin: 10px 0 18px; }
.tag-btn { border: 1px solid var(--border); background: var(--card); color: var(--muted); border-radius: 999px; padding: 4px 12px; font-size: 13px; cursor: pointer; }
.tag-btn.on { background: var(--accent); border-color: var(--accent); color: #fff; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 14px; }
.card { background: var(--card); border: 1px solid var(--border); border-radius: 14px; padding: 16px 18px; display: flex; flex-direction: column; gap: 8px; transition: border-color .15s; }
.card:hover { border-color: var(--accent); }
.card.recommended { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent) inset; }
.card-top { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; }
.card h3 { margin: 0; font-size: 17px; }
.dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 5px; vertical-align: 1px; }
.dot.on { background: var(--green); } .dot.off { background: var(--red); } .dot.un { background: var(--muted); }
.status { font-size: 12px; color: var(--muted); white-space: nowrap; }
.subtitle { color: var(--muted); font-size: 13.5px; margin: 0; }
.tags { display: flex; gap: 6px; flex-wrap: wrap; }
.tag { background: var(--tag); color: var(--muted); font-size: 12px; border-radius: 6px; padding: 2px 8px; }
.credits { display: flex; gap: 14px; flex-wrap: wrap; font-size: 13px; color: var(--muted); }
.credits b { color: var(--text); }
.hl { margin: 6px 0 0; padding-left: 18px; font-size: 13.5px; color: var(--muted); }
.hl li { margin: 2px 0; }
.card-actions { display: flex; gap: 8px; margin-top: auto; padding-top: 10px; flex-wrap: wrap; }
.btn { border-radius: 8px; padding: 7px 14px; font-size: 14px; text-decoration: none; border: 1px solid var(--border); color: var(--text); background: var(--card); }
.btn.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
details.more { font-size: 13px; color: var(--muted); }
details.more summary { cursor: pointer; user-select: none; }
.empty { text-align: center; color: var(--muted); padding: 48px 0; }
#free-apis { margin-top: 48px; }
#free-apis h2 { font-size: 20px; margin: 0 0 4px; }
.sec-desc { color: var(--muted); font-size: 13.5px; margin: 0 0 16px; }
.sec-more { color: var(--muted); font-size: 13px; margin-top: 14px; }
.api-grid { margin-top: 12px; }
.api-card { background: var(--card); border: 1px solid var(--border); border-radius: 14px; padding: 14px 16px; display: flex; flex-direction: column; gap: 6px; font-size: 13.5px; }
.api-card:hover { border-color: var(--accent); }
.api-card .api-top { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; }
.api-card h3 { margin: 0; font-size: 15.5px; }
.api-card .free { color: var(--green); font-size: 12.5px; white-space: nowrap; font-weight: 600; }
.api-card .api-meta { color: var(--muted); font-size: 12.5px; display: flex; gap: 10px; flex-wrap: wrap; }
.api-card .api-hl { color: var(--muted); font-size: 13px; margin: 2px 0 0; }
.api-card code { background: var(--tag); border-radius: 5px; padding: 1px 6px; font-size: 12px; word-break: break-all; }
.api-card .api-actions { margin-top: auto; padding-top: 8px; display: flex; gap: 8px; }
footer { margin-top: 40px; font-size: 12.5px; color: var(--muted); border-top: 1px solid var(--border); padding-top: 16px; }
a { color: var(--accent); }
</style>
</head>
<body>
<div class="wrap">
<header>
  <h1>${esc(data.meta.title)}</h1>
  <p>${esc(data.meta.tagline)}</p>
  <div class="meta-line" id="gen-line"></div>
</header>
<div class="stats" id="stats"></div>
<div class="controls">
  <input id="q" type="search" placeholder="搜索站点名 / 标签 / 卖点…" autocomplete="off">
  <select id="sort">
    <option value="default">默认排序</option>
    <option value="credits">首日额度 ↓</option>
    <option value="name">名称</option>
    <option value="latency">延迟</option>
  </select>
</div>
<div id="tags"></div>
<main class="grid" id="grid"></main>
<div class="empty" id="empty" hidden>没有匹配的站点</div>
<section id="free-apis" hidden>
  <h2>🏢 官方免费 API（公益站之外的保底）</h2>
  <p class="sec-desc">公益站随时可能关停或改规则，各家平台的<strong>官方免费层</strong>更稳：注册即用、长期有效、不经第三方中转。数据整理自 <a href="https://itsfree.ai/" target="_blank" rel="noopener">itsfree.ai</a>（@midudev 出品，完整目录 25 家 provider / 463 个免费模型 / 9 种本地运行时）。国内直连推荐 ModelScope 魔搭、Z.ai 智谱、AMD Radeon Cloud。</p>
  <div class="grid api-grid" id="api-grid"></div>
  <p class="sec-more" id="api-more"></p>
</section>
<footer>
  <p>本页仅为信息聚合，与收录站点无隶属关系，不承诺可用性。请勿将生产密钥、隐私数据、企业代码交给来源不明的中转服务。注册链接若含邀请参数，意味着站长可能获得邀请奖励。</p>
  <p>数据快照由脚本自动抓取，页面静态生成 —— <a href="#" id="repo-link">仓库地址</a></p>
</footer>
</div>
<script id="page-data" type="application/json">${json}</script>
${freeApiJson ? `<script id="free-api-data" type="application/json">${freeApiJson}</script>` : ''}
<script>
(function () {
  var DATA = JSON.parse(document.getElementById('page-data').textContent);
  var q = document.getElementById('q'), sortSel = document.getElementById('sort');
  var grid = document.getElementById('grid'), emptyEl = document.getElementById('empty');
  var state = { q: '', tag: null, sort: 'default' };

  document.getElementById('gen-line').textContent = DATA.generatedAt
    ? '实时数据：' + DATA.generatedAt.replace('T', ' ').slice(0, 16) + ' UTC 自动更新'
    : '尚无实时快照';

  // 统计条
  var online = DATA.sites.filter(function (s) { return s.online === true; }).length;
  var known = DATA.sites.filter(function (s) { return s.online !== null; }).length;
  var totalUsd = DATA.sites.reduce(function (a, s) { return a + (s.firstDayUsd || 0); }, 0);
  document.getElementById('stats').innerHTML =
    stat(DATA.sites.length, '收录站点') + stat('$' + (Math.round(totalUsd * 100) / 100), '首日额度合计') +
    stat(online + '/' + known, '在线（已探测）') + stat(DATA.sites.filter(function (s) { return s.checkinEnabled; }).length, '支持每日签到');
  function stat(v, label) { return '<div class="stat"><b>' + v + '</b><span>' + label + '</span></div>'; }
  var repo = (DATA.meta && DATA.meta.repoUrl) || '';
  var repoLink = document.getElementById('repo-link');
  if (repo) { repoLink.href = repo; repoLink.textContent = repo.replace('https://github.com/', '@'); } else { repoLink.parentNode.removeChild(repoLink); }

  // 标签栏（按出现频次排序）
  var freq = {};
  DATA.sites.forEach(function (s) { (s.tags || []).forEach(function (t) { freq[t] = (freq[t] || 0) + 1; }); });
  var tagNames = Object.keys(freq).sort(function (a, b) { return freq[b] - freq[a]; }).slice(0, 14);
  var tagsEl = document.getElementById('tags');
  tagNames.forEach(function (t) {
    var b = document.createElement('button');
    b.className = 'tag-btn'; b.textContent = t + ' ' + freq[t];
    b.onclick = function () {
      state.tag = state.tag === t ? null : t;
      tagsEl.querySelectorAll('.tag-btn').forEach(function (x) { x.classList.remove('on'); });
      if (state.tag) b.classList.add('on');
      render();
    };
    tagsEl.appendChild(b);
  });

  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function usd(n) { return n == null ? '—' : '$' + (Math.round(n * 100) / 100); }

  function card(s) {
    var dot = s.online === true ? 'on' : s.online === false ? 'off' : 'un';
    var stTxt = s.online === true ? '在线' : s.online === false ? '离线' : '未探测';
    if (s.latencyMs != null && s.online) stTxt += ' · ' + s.latencyMs + 'ms';
    var c = s.credits || {};
    var cr = [];
    if (c.signup != null) cr.push('注册 <b>' + usd(c.signup) + '</b>');
    if (c.invite != null) cr.push('邀请 <b>' + usd(c.invite) + '</b>');
    if (c.dailyCheckin != null) cr.push('签到 <b>' + usd(c.dailyCheckin) + '</b>');
    if (c.dailyQuota != null) cr.push('每日池 <b>' + usd(c.dailyQuota) + '</b>');
    if (c.unit === 'point' && c.invite != null) cr.push('邀请 <b>' + c.invite + ' 积分</b>');
    var first = s.firstDayUsd != null ? (s.approx ? '~' : '') + usd(s.firstDayUsd) + ' 首日' : '';
    var protos = Object.keys(s.endpoints || {}).filter(function (k) { return s.endpoints[k]; });
    var mirrors = (s.mirrors || []).map(function (m) { return '<a href="' + esc(m.signupUrl || m.homeUrl) + '" target="_blank" rel="noopener">' + esc(m.label) + '</a>'; }).join(' · ');
    return '<div class="card' + (s.recommended ? ' recommended' : '') + '">' +
      '<div class="card-top"><h3><span class="dot ' + dot + '"></span>' + esc(s.name) + '</h3><span class="status">' + esc(stTxt) + (first ? ' · ' + first : '') + '</span></div>' +
      '<p class="subtitle">' + esc(s.subtitle) + '</p>' +
      '<div class="tags">' + (s.tags || []).map(function (t) { return '<span class="tag">' + esc(t) + '</span>'; }).join('') + '</div>' +
      (cr.length ? '<div class="credits">' + cr.join('') + '</div>' : '') +
      ((s.highlights || []).length ? '<ul class="hl">' + s.highlights.slice(0, 3).map(function (h) { return '<li>' + esc(h) + '</li>'; }).join('') + '</ul>' : '') +
      '<div class="card-actions">' +
        '<a class="btn primary" href="' + esc(s.signupUrl) + '" target="_blank" rel="noopener">注册</a>' +
        '<a class="btn" href="' + esc(s.homeUrl) + '" target="_blank" rel="noopener">主页</a>' +
        (s.docsUrl ? '<a class="btn" href="' + esc(s.docsUrl) + '" target="_blank" rel="noopener">文档</a>' : '') +
      '</div>' +
      ((protos.length || mirrors || (s.caveats || []).length || (s.register || []).length) ?
        '<details class="more"><summary>接入与详情</summary>' +
        (protos.length ? '<p>协议：' + protos.map(function (p) { return esc(p) + ' → <code>' + esc(s.endpoints[p]) + '</code>'; }).join('；') + '</p>' : '') +
        ((s.register || []).length ? '<p>登录方式：' + esc(s.register.join(' / ')) + '</p>' : '') +
        (mirrors ? '<p>镜像：' + mirrors + '</p>' : '') +
        ((s.caveats || []).length ? '<p>注意：' + s.caveats.map(esc).join('；') + '</p>' : '') +
        '</details>' : '') +
      '</div>';
  }

  function render() {
    var list = DATA.sites.filter(function (s) {
      if (state.tag && (s.tags || []).indexOf(state.tag) < 0) return false;
      if (state.q) {
        var hay = [s.name, s.subtitle, (s.tags || []).join(' '), (s.highlights || []).join(' ')].join(' ').toLowerCase();
        if (hay.indexOf(state.q.toLowerCase()) < 0) return false;
      }
      return true;
    });
    var sort = sortSel.value;
    if (sort === 'credits') list.sort(function (a, b) { return (b.firstDayUsd || 0) - (a.firstDayUsd || 0); });
    else if (sort === 'name') list.sort(function (a, b) { return a.name.localeCompare(b.name, 'zh'); });
    else if (sort === 'latency') list.sort(function (a, b) { return (a.latencyMs == null ? 1e9 : a.latencyMs) - (b.latencyMs == null ? 1e9 : b.latencyMs); });
    grid.innerHTML = list.map(card).join('');
    emptyEl.hidden = list.length > 0;
  }

  q.addEventListener('input', function () { state.q = q.value.trim(); render(); });
  sortSel.addEventListener('change', render);
  render();

  // 官方免费 API 分区
  var apiDataEl = document.getElementById('free-api-data');
  if (apiDataEl) {
    var APIS = JSON.parse(apiDataEl.textContent);
    var apiGrid = document.getElementById('api-grid');
    document.getElementById('free-apis').hidden = false;
    apiGrid.innerHTML = (APIS.providers || []).map(function (p) {
      return '<div class="api-card">' +
        '<div class="api-top"><h3>' + esc(p.name) + '</h3><span class="free">' + esc(p.freeTier) + '</span></div>' +
        '<div class="api-meta"><span>📏 ' + esc(p.context) + ' 上下文</span><span>📦 ' + esc(p.models) + ' 个模型</span><span>🔑 ' + esc(p.signup) + '注册</span></div>' +
        '<p class="api-hl">' + esc(p.highlight) + '</p>' +
        '<div><code>' + esc(p.baseUrl) + '</code></div>' +
        '<div class="api-actions"><a class="btn" href="' + esc(p.url) + '" target="_blank" rel="noopener">详情</a></div>' +
        '</div>';
    }).join('');
    var moreEl = document.getElementById('api-more');
    if (APIS.more && APIS.more.length) {
      moreEl.innerHTML = '还有 ' + APIS.more.length + ' 家：' + APIS.more.map(function (m) {
        return '<a href="' + esc(m.url) + '" target="_blank" rel="noopener">' + esc(m.name) + '</a>（' + esc(m.freeTier) + '）';
      }).join(' · ');
    }
  }
})();
</script>
</body>
</html>
`;
}

await mkdir(`${ROOT}/docs`, { recursive: true });
await writeFile(`${ROOT}/README.md`, buildReadme(), 'utf8');
await writeFile(`${ROOT}/docs/index.html`, buildHtml(), 'utf8');
console.log(`✓ build 完成：README.md + docs/index.html（${data.sites.length} 个站点${generatedAt ? '，快照 ' + generatedAt : '，无实时数据'}）`);
