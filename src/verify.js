import { isValidFilename, normalizeHost } from './validate.js';
import { matchFile } from './repo/rules.js';

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

    requestLog.record({
      host: c.req.header('host') || '',
      forwardedHost: c.req.header('x-forwarded-host') || '',
      resolvedHost,
      path: c.req.path,
      filename,
      hit: Boolean(row),
      fileId: row ? row.id : null,
      // 网关通常做了 HTTPS 终结，后端只见 http；以 x-forwarded-proto 还原真实协议
      scheme: (c.req.header('x-forwarded-proto') || '').split(',')[0].trim() || 'http',
    });

    if (!row) return c.body('Not found', 404, TEXT_HEADERS);
    return c.body(row.content, 200, TEXT_HEADERS);
  };
}
