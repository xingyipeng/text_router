import { isValidFilename, normalizeHost } from './validate.js';
import { matchFile } from './repo/rules.js';
import { insertRequest, countRequests, trimRequests } from './repo/requests.js';

const TEXT_HEADERS = {
  'Content-Type': 'text/plain; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
};

export function resolveHost(c) {
  return normalizeHost(c.req.header('x-forwarded-host') || c.req.header('host') || '');
}

export function createVerifyHandler({ db, requestLog }) {
  return (c) => {
    const filename = c.req.path.slice(1); // 去掉前导 /，子目录路径形如 h5/xxx.txt
    const resolvedHost = resolveHost(c);

    const row = isValidFilename(filename) ? matchFile(db, resolvedHost, filename) : undefined;

    // 非 .txt 路径无命中时返回 null 透传（交给静态文件与 notFound），也不记入
    // 请求日志，避免 style.css 等静态资源刷屏。.txt 未命中仍 404 + 留痕，保持原有排障语义。
    if (!row && !c.req.path.endsWith('.txt')) return null;

    const entry = {
      at: Date.now(),
      host: c.req.header('host') || '',
      forwardedHost: c.req.header('x-forwarded-host') || '',
      resolvedHost,
      path: c.req.path,
      filename,
      hit: Boolean(row),
      fileId: row ? row.id : null,
      // 网关通常做了 HTTPS 终结，后端只见 http；以 x-forwarded-proto 还原真实协议
      scheme: (c.req.header('x-forwarded-proto') || '').split(',')[0].trim() || 'http',
      method: c.req.method,
      // 归因信息：UA 与客户端 IP（取 XFF 第一跳；截断防超长头刷库）。
      // remoteIp = TCP 直连对端：绕过网关直连时 XFF 可伪造，TCP 来源做对照
      ua: (c.req.header('user-agent') || '').slice(0, 200),
      ip: (c.req.header('x-forwarded-for') || '').split(',')[0].trim().slice(0, 200),
      remoteIp: (c.env?.incoming?.socket?.remoteAddress || '').slice(0, 200),
    };
    requestLog.record(entry);

    // 落库持久化：超出容量自动删最旧（容量 = 设置页「日志最大保留条数」）
    insertRequest(db, entry);
    const cap = requestLog.getCapacity();
    if (countRequests(db) > cap) trimRequests(db, cap);

    if (!row) return c.body('Not found', 404, TEXT_HEADERS);
    return c.body(row.content, 200, TEXT_HEADERS);
  };
}
