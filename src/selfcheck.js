import { safeFetch, checkTarget } from './safe-fetch.js';
import { isValidFilename } from './validate.js';
import { matchFile } from './repo/rules.js';
import { isPattern, patternIntersects, compareRules } from './hostmatch.js';

export const CHECK_CODES = {
  OK: 'OK',
  TARGET_BLOCKED: 'TARGET_BLOCKED',
  RESPONSE_TOO_LARGE: 'RESPONSE_TOO_LARGE',
  BUSY: 'BUSY',
  NO_HOST: 'NO_HOST',
  EGRESS_BLOCKED: 'EGRESS_BLOCKED',
  DNS_OR_CONNECT_FAILED: 'DNS_OR_CONNECT_FAILED',
  REDIRECTED: 'REDIRECTED',
  STATUS_NOT_200: 'STATUS_NOT_200',
  CONTENT_TYPE_WRONG: 'CONTENT_TYPE_WRONG',
  CONTENT_MISMATCH: 'CONTENT_MISMATCH',
};

const DNS_ERROR_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ENOTDIR']);
const EGRESS_ERROR_CODES = new Set([
  'ECONNREFUSED', 'ETIMEDOUT', 'ECONNRESET', 'EHOSTUNREACH',
  'ENETUNREACH', 'UND_ERR_CONNECT_TIMEOUT',
]);

export function runInternalCheck(db, file, probeHost) {
  if (!file) return { ok: false, problems: ['记录不存在'] };

  const problems = [];
  if (file.deleted_at) problems.push('记录已被删除，不会响应任何请求');
  if (!isValidFilename(file.filename)) problems.push('文件名不合法');
  if (typeof file.content !== 'string' || file.content.length === 0) problems.push('内容为空');

  const pattern = file.host === '' ? '*' : file.host;
  const probe = probeHost !== undefined ? probeHost : (isPattern(pattern) ? undefined : pattern);
  if (probe === undefined) {
    // 模式/全局记录：与线上匹配同源——扫描同 filename 的活跃行，
    // 模式相交且排序赢过它的行会在部分域名上遮蔽这条
    const others = db.prepare(`
      SELECT id, host, priority FROM verify_files
      WHERE filename = ? AND deleted_at IS NULL AND id != ?
    `).all(file.filename, file.id);
    for (const o of others) {
      const oHost = o.host === '' ? '*' : o.host;
      if (patternIntersects(oHost, pattern) && compareRules({ ...o, host: oHost }, { ...file, host: pattern }) < 0) {
        problems.push(`在部分域名上命中的不是这条记录，而是 id=${o.id}（host=${o.host} 优先）`);
      }
    }
  } else {
    const matched = matchFile(db, probe, file.filename);
    if (!matched) {
      problems.push('按当前匹配规则查不到任何记录');
    } else if (matched.id !== file.id) {
      problems.push(`当前匹配规则下命中的不是这条记录，而是 id=${matched.id}（更精确的 host 优先）`);
    }
  }

  return { ok: problems.length === 0, problems };
}

function classifyFetchError(err) {
  const code = err?.cause?.code || err?.code || '';
  if (DNS_ERROR_CODES.has(code)) return CHECK_CODES.DNS_OR_CONNECT_FAILED;
  if (EGRESS_ERROR_CODES.has(code)) return CHECK_CODES.EGRESS_BLOCKED;
  if (err?.name === 'AbortError' || err?.name === 'TimeoutError') return CHECK_CODES.EGRESS_BLOCKED;
  return CHECK_CODES.DNS_OR_CONNECT_FAILED;
}

const MAX_RESPONSE_BYTES = 64 * 1024;
let activeChecks = 0;

async function readBoundedBody(res) {
  if (Number(res.headers.get('content-length')) > MAX_RESPONSE_BYTES) {
    throw Object.assign(new Error('响应正文超过 64 KiB'), { code: CHECK_CODES.RESPONSE_TOO_LARGE });
  }
  if (!res.body) {
    // 兼容测试注入的轻量响应；真实网络响应走下方流式限长读取。
    const text = res.text ? await res.text() : '';
    if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) throw Object.assign(new Error('响应正文超过 64 KiB'), { code: CHECK_CODES.RESPONSE_TOO_LARGE });
    return text;
  }
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw Object.assign(new Error('响应正文超过 64 KiB'), { code: CHECK_CODES.RESPONSE_TOO_LARGE });
      }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  // 保留 BOM；校验文件需要逐字节一致，Response.text() 会去掉 BOM。
  return new TextDecoder('utf-8', { ignoreBOM: true }).decode(Buffer.concat(chunks));
}

export async function runExternalCheck(file, { fetchImpl = safeFetch, timeoutMs = 8000, allowedHosts = [] } = {}) {
  if (!file.host || isPattern(file.host)) {
    return {
      code: CHECK_CODES.NO_HOST,
      detail: !file.host || file.host === '*'
        ? '全局记录无法确定验证域名，请手动访问目标 URL 确认。'
        : '模式规则无法确定验证域名，请手动访问目标 URL 确认。',
    };
  }
  if (activeChecks >= 10) return { code: CHECK_CODES.BUSY, detail: '自检请求繁忙，请稍后重试' };
  activeChecks++;
  let res;
  let url;
  try {
    // 通过 pathname 设置路径，防止文件名中的 ?/# 改变实际访问目标。
    const target = new URL(`https://${file.host}`);
    if (target.host !== file.host || target.pathname !== '/' || target.search || target.hash) {
      throw Object.assign(new Error('自检域名不合法'), { code: CHECK_CODES.TARGET_BLOCKED });
    }
    checkTarget(target, allowedHosts);
    target.pathname = '/' + file.filename.split('/').map(encodeURIComponent).join('/');
    url = target.href;
    res = await fetchImpl(url, {
      redirect: 'manual', signal: AbortSignal.timeout(timeoutMs), allowedHosts,
      headers: { 'User-Agent': 'text-router-selfcheck/1.0' },
    });
    if (res.status >= 300 && res.status < 400) {
      return {
        code: CHECK_CODES.REDIRECTED,
        detail: `返回 ${res.status} 跳转到 ${res.headers.get('location') || '(未知目标)'}。微信校验不接受重定向，需要为该路径配置例外。`,
      };
    }
    if (res.status !== 200) return { code: CHECK_CODES.STATUS_NOT_200, detail: `返回状态码 ${res.status}，期望 200` };
    const contentType = res.headers.get('content-type') || '';
    if (contentType.split(';')[0].trim().toLowerCase() !== 'text/plain') {
      return { code: CHECK_CODES.CONTENT_TYPE_WRONG, detail: `Content-Type 是 ${contentType || '(空)'}，期望 text/plain` };
    }
    const actual = await readBoundedBody(res);
    if (actual !== file.content) {
      return { code: CHECK_CODES.CONTENT_MISMATCH, detail: '线上返回的内容与库中记录不一致', expected: file.content, actual };
    }
    return { code: CHECK_CODES.OK, detail: `${url} 返回 200，内容完全一致` };
  } catch (err) {
    const code = err?.cause?.code || err?.code;
    return {
      code: [CHECK_CODES.TARGET_BLOCKED, CHECK_CODES.RESPONSE_TOO_LARGE].includes(code) ? code : classifyFetchError(err),
      detail: `请求 ${url || file.host} 失败：${err?.cause?.code || err?.code || err?.message || String(err)}`,
    };
  } finally {
    try { if (res?.body && !res.body.locked) await res.body.cancel(); } catch {}
    activeChecks--;
  }
}
