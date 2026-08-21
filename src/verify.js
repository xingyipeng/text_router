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

    requestLog.record({
      host: c.req.header('host') || '',
      forwardedHost: c.req.header('x-forwarded-host') || '',
      resolvedHost,
      path: c.req.path,
      filename,
      hit: Boolean(row),
      fileId: row ? row.id : null,
    });

    if (!row) return c.body('Not found', 404, TEXT_HEADERS);
    return c.body(row.content, 200, TEXT_HEADERS);
  };
}
