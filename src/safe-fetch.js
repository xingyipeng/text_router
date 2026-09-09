import { lookup } from 'node:dns';
import { isIP } from 'node:net';
import { request } from 'node:https';
import { Readable } from 'node:stream';
import ipaddr from 'ipaddr.js';

export function isPublicAddress(address) {
  try { return ipaddr.process(address).range() === 'unicast'; } catch { return false; }
}

function blocked() {
  return Object.assign(new Error('自检目标不是允许的公网地址；内网目标需配置 SELFCHECK_ALLOWED_HOSTS'), { code: 'TARGET_BLOCKED' });
}

export function checkTarget(url, allowedHosts = []) {
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) throw blocked();
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const allowed = allowedHosts.includes(host);
  if (isIP(host) && !allowed && !isPublicAddress(host)) throw blocked();
  return allowed;
}

// 校验的 DNS 结果直接用于建立连接，不在校验后再次解析，避免 DNS rebinding。
export function safeLookup(allowPrivate, lookupImpl = lookup) {
  return (hostname, options, callback) => {
    lookupImpl(hostname, { all: true, verbatim: true }, (err, addresses) => {
      if (err) return callback(err);
      if (!addresses?.length) return callback(Object.assign(new Error('没有可用地址'), { code: 'ENOTFOUND' }));
      if (!allowPrivate && addresses.some(({ address }) => !isPublicAddress(address))) return callback(blocked());
      const family = typeof options === 'number' ? options : options?.family;
      const candidates = family ? addresses.filter((a) => a.family === family) : addresses;
      if (!candidates.length) return callback(Object.assign(new Error('没有可用地址'), { code: 'ENOTFOUND' }));
      if (options?.all) return callback(null, candidates);
      callback(null, candidates[0].address, candidates[0].family);
    });
  };
}

// 不使用环境代理、不跟随重定向，TLS 证书校验仍针对原始主机名。
export function safeFetch(input, { signal, headers, allowedHosts = [] } = {}) {
  const url = new URL(input);
  const allowPrivate = checkTarget(url, allowedHosts);
  return new Promise((resolve, reject) => {
    const req = request(url, {
      signal, headers, agent: false, lookup: safeLookup(allowPrivate),
    }, (res) => {
      const responseHeaders = new Headers();
      for (const [key, value] of Object.entries(res.headers)) {
        if (value !== undefined) responseHeaders.set(key, Array.isArray(value) ? value.join(', ') : value);
      }
      const noBody = [204, 205, 304].includes(res.statusCode);
      if (noBody) res.resume();
      resolve(new Response(noBody ? null : Readable.toWeb(res), {
        status: res.statusCode, headers: responseHeaders,
      }));
    });
    req.on('error', reject);
    req.end();
  });
}
