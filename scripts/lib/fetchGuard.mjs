// 出站请求安全层：所有服务端对站点 URL 的抓取（探活/状态/定价）都必须经过这里。
// 仅允许 http/https，且拒绝 localhost、环回、私有及保留地址（防 SSRF）。
import { isIP } from 'node:net';

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'ip6-localhost',
  'ip6-loopback',
  'metadata.google.internal', // 云元数据服务
  'instance-data',
]);

function isPrivateIPv4(ip) {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) return true;
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127) return true; // 本网络/内网/环回
  if (a === 169 && b === 254) return true; // 链路本地（含云元数据 169.254.169.254）
  if (a === 172 && b >= 16 && b <= 31) return true; // 内网
  if (a === 192 && b === 168) return true; // 内网
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a >= 224) return true; // 组播/保留
  return false;
}

function isPrivateIPv6(ip) {
  const v = ip.toLowerCase();
  if (v === '::' || v === '::1') return true; // 未指定/环回
  if (v.startsWith('fe80:') || v.startsWith('fc') || v.startsWith('fd')) return true; // 链路本地 / ULA
  if (v.startsWith('::ffff:')) return isPrivateIPv4(v.slice(7)); // IPv4 映射地址
  if (v.startsWith('64:ff9b:')) return true; // NAT64
  if (v.startsWith('100::')) return true; // discard-only
  if (v.startsWith('ff')) return true; // 组播
  if (v.startsWith('2001:db8')) return true; // 文档保留段
  return false;
}

/** 校验 URL 字符串：协议白名单 + host 黑名单。返回 { ok, url, reason } */
export function guardUrl(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, reason: 'invalid URL' };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { ok: false, reason: `protocol not allowed: ${u.protocol}` };
  }
  const host = u.hostname.toLowerCase().replace(/\.$/, '').replace(/^\[(.*)\]$/, '$1'); // IPv6 字面量剥方括号
  if (BLOCKED_HOSTNAMES.has(host)) {
    return { ok: false, reason: `blocked host: ${host}` };
  }
  // 纯 IP 字面量直接判；域名交给 resolveGuardedUrl 在 DNS 解析后判定
  if (isIP(host)) {
    const bad = host.includes(':') ? isPrivateIPv6(host) : isPrivateIPv4(host);
    if (bad) return { ok: false, reason: `private/reserved address: ${host}` };
  } else if (/^\d+$/.test(host)) {
    // http://2130706433/ 这类纯数字 IP 等价于 127.0.0.1，isIP 不认，直接拒
    return { ok: false, reason: `numeric-form address: ${host}` };
  }
  return { ok: true, url: u };
}

/** 校验并解析 host 的全部 IP，任何一个命中私网/保留段即拒绝（防 DNS rebinding 到内网） */
export async function resolveGuardedUrl(raw) {
  const g = guardUrl(raw);
  if (!g.ok) return g;
  const host = g.url.hostname.toLowerCase().replace(/\.$/, '').replace(/^\[(.*)\]$/, '$1');
  if (isIP(host)) return { ok: true, url: g.url };
  const dns = await import('node:dns/promises');
  let addrs;
  try {
    addrs = await dns.lookup(host, { all: true, verbatim: true });
  } catch {
    return { ok: false, reason: `DNS lookup failed: ${host}` };
  }
  if (!addrs.length) return { ok: false, reason: `no DNS records: ${host}` };
  for (const { address } of addrs) {
    const bad = address.includes(':') ? isPrivateIPv6(address) : isPrivateIPv4(address);
    if (bad) return { ok: false, reason: `resolves to private/reserved address: ${host} -> ${address}` };
  }
  return { ok: true, url: g.url };
}

const DEFAULT_UA = 'ai-welfare-hub/1.0 (+health-check; github.com)';
const MAX_REDIRECTS = 5;

/** 安全 GET：先过 resolveGuardedUrl，再发请求。超时/错误一律返回 null 而不抛出。 */
export async function safeFetchJson(raw, { timeoutMs = 15000, headers = {}, init } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const started = Date.now();
  let currentUrl = raw;
  let redirects = 0;
  try {
    while (true) {
      const g = await resolveGuardedUrl(currentUrl);
      if (!g.ok) return { ok: false, guarded: true, reason: g.reason, status: null, json: null, ms: Date.now() - started };
      const res = await fetch(g.url, {
        ...init,
        signal: ctrl.signal,
        redirect: 'manual',
        headers: { 'user-agent': DEFAULT_UA, accept: 'application/json,text/plain;q=0.9,*/*;q=0.8', ...(init?.headers ?? {}), ...headers },
      });
      if ([301, 302, 303, 307, 308].includes(res.status)) {
        const location = res.headers.get('location');
        if (!location) return { ok: res.ok, guarded: false, reason: null, status: res.status, json: null, ms: Date.now() - started, finalUrl: g.url };
        if (redirects++ >= MAX_REDIRECTS) return { ok: false, guarded: false, reason: `too many redirects (>${MAX_REDIRECTS})`, status: res.status, json: null, ms: Date.now() - started, finalUrl: g.url };
        currentUrl = new URL(location, g.url).href;
        continue;
      }
      let json = null;
      const text = await res.text();
      try {
        json = JSON.parse(text);
      } catch {
        /* Non-JSON response is still a reachable endpoint. */
      }
      return { ok: res.ok, guarded: false, reason: null, status: res.status, json, ms: Date.now() - started, finalUrl: g.url };
    }
  } catch (e) {
    const ms = Date.now() - started;
    return { ok: false, guarded: false, reason: e.name === 'AbortError' ? 'timeout' : String(e.cause?.code || e.message || e), status: null, json: null, ms };
  } finally {
    clearTimeout(timer);
  }
}
