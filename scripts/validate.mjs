// data/sites.json 的结构与内容校验：字段齐全、URL 合法（协议白名单 + 禁内网/环回）、无重复 id。
// 这是贡献新站点时的第一道门槛，CI 里在 refresh/build 之前跑。
import { readFile } from 'node:fs/promises';
import { guardUrl } from './lib/fetchGuard.mjs';

const errors = [];
const warnings = [];

function needString(site, field, { allowEmpty = false } = {}) {
  const v = site[field];
  if (v == null || v === '') {
    if (!allowEmpty) errors.push(`${site.id ?? '?'}: missing ${field}`);
    return;
  }
  if (typeof v !== 'string') errors.push(`${site.id}: ${field} must be string`);
}

function checkUrl(site, field, { required = false } = {}) {
  const v = site[field];
  if (v == null || v === '') {
    if (required) errors.push(`${site.id}: missing ${field}`);
    return;
  }
  if (typeof v !== 'string') {
    errors.push(`${site.id}: ${field} must be string`);
    return;
  }
  const g = guardUrl(v);
  if (!g.ok) errors.push(`${site.id}: bad ${field} (${v}) — ${g.reason}`);
}

const raw = await readFile(new URL('../data/sites.json', import.meta.url), 'utf8');
let data;
try {
  data = JSON.parse(raw);
} catch (e) {
  console.error(`✗ data/sites.json 解析失败: ${e.message}`);
  process.exit(1);
}

if (!Array.isArray(data.sites)) {
  console.error('✗ data/sites.json 缺少 sites 数组');
  process.exit(1);
}
if (!data.meta || typeof data.meta.title !== 'string') errors.push('meta.title is required');
if (data.meta?.repoUrl) checkUrl({ id: 'meta' }, 'repoUrl');
if (data.meta?.pagesUrl) checkUrl({ id: 'meta' }, 'pagesUrl');

const seenIds = new Set();
for (const site of data.sites) {
  if (!site.id || typeof site.id !== 'string') { errors.push(`site missing id: ${JSON.stringify(site).slice(0, 60)}`); continue; }
  if (!/^[a-z0-9-]+$/.test(site.id)) errors.push(`${site.id}: id 只能含小写字母/数字/连字符`);
  if (seenIds.has(site.id)) errors.push(`${site.id}: 重复 id`);
  seenIds.add(site.id);

  needString(site, 'name');
  if (!site.subtitle) warnings.push(`${site.id}: 建议填写 subtitle（一句话定位，展示在卡片上）`);
  if (!site.tags?.length) warnings.push(`${site.id}: 建议填写 tags（用于页面筛选）`);
  if (site.tags && site.tags.some((t) => typeof t !== 'string')) errors.push(`${site.id}: tags 必须全是字符串`);
  if (!Array.isArray(site.highlights) || site.highlights.length === 0) warnings.push(`${site.id}: 建议填写 highlights（2-4 条卖点）`);
  if (site.credits && (typeof site.credits !== 'object' || Array.isArray(site.credits))) errors.push(`${site.id}: credits 必须是对象`);
  if (site.credits && typeof site.credits === 'object' && !Array.isArray(site.credits)) {
    for (const [field, value] of Object.entries(site.credits)) {
      if (['signup', 'invite', 'dailyCheckin', 'dailyQuota'].includes(field) && value != null && (typeof value !== 'number' || !Number.isFinite(value) || value < 0)) {
        errors.push(`${site.id}: credits.${field} 必须是非负有限数字`);
      }
    }
    if (site.credits.unit != null && site.credits.unit !== 'point') errors.push(`${site.id}: credits.unit 只支持 point`);
  }

  checkUrl(site, 'signupUrl', { required: true });
  checkUrl(site, 'homeUrl', { required: true });
  for (const f of ['docsUrl', 'statusApi', 'pricingApi']) checkUrl(site, f);

  if (site.endpoints) {
    if (typeof site.endpoints !== 'object' || Array.isArray(site.endpoints)) errors.push(`${site.id}: endpoints 必须是对象`);
    for (const [proto, ep] of Object.entries(site.endpoints)) {
      if (ep == null || ep === '') continue;
      const g = guardUrl(ep);
      if (!g.ok) errors.push(`${site.id}: bad endpoints.${proto} (${ep}) — ${g.reason}`);
    }
  }
  if (site.mirrors) {
    if (!Array.isArray(site.mirrors)) errors.push(`${site.id}: mirrors 必须是数组`);
    else for (const [i, m] of site.mirrors.entries()) {
      if (!m || typeof m !== 'object' || Array.isArray(m)) { errors.push(`${site.id}: mirrors[${i}] 必须是对象`); continue; }
      if (m.label != null && typeof m.label !== 'string') errors.push(`${site.id}: mirrors[${i}].label 必须是字符串`);
      for (const f of ['homeUrl', 'signupUrl']) {
        if (m[f] != null && m[f] !== '') checkUrl({ id: `${site.id} mirrors[${i}]` }, f);
      }
    }
  }
  for (const f of ['tags', 'highlights', 'caveats', 'community', 'earnMore']) {
    if (site[f] != null && (!Array.isArray(site[f]) || site[f].some((v) => typeof v !== 'string'))) errors.push(`${site.id}: ${f} 必须是字符串数组`);
  }
  if (site.register && !Array.isArray(site.register.methods)) warnings.push(`${site.id}: register.methods 建议填数组（GitHub OAuth / 邮箱注册 等）`);
  if (site.register?.methods?.some((v) => typeof v !== 'string')) errors.push(`${site.id}: register.methods 必须全是字符串`);
}

for (const w of warnings) console.warn(`⚠ ${w}`);
if (errors.length) {
  for (const e of errors) console.error(`✗ ${e}`);
  console.error(`\n校验失败：${errors.length} 个错误`);
  process.exit(1);
}
console.log(`✓ sites.json 校验通过：${data.sites.length} 个站点${warnings.length ? `，${warnings.length} 条建议` : ''}`);
