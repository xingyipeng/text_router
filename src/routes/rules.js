import { Hono } from 'hono';
import {
  createFile, updateFile, getFile, listFiles, softDeleteFile, restoreFile, listMeta,
} from '../repo/rules.js';
import { UniqueViolation } from '../repo/errors.js';
import {
  isValidFilename, normalizeHost, inspectContent, MAX_CONTENT_BYTES,
} from '../validate.js';
import { requireAuth } from '../auth.js';
import { runInternalCheck, runExternalCheck } from '../selfcheck.js';

function parsePayload(body) {
  const filename = body?.filename;
  if (!isValidFilename(filename)) {
    return { error: '文件名必须是 1-80 位字母、数字、下划线或连字符，并以 .txt 结尾' };
  }
  const content = body?.content;
  if (typeof content !== 'string') return { error: '内容必须是字符串' };
  if (Buffer.byteLength(content, 'utf8') > MAX_CONTENT_BYTES) {
    return { error: `内容不能超过 ${MAX_CONTENT_BYTES} 字节` };
  }
  return {
    value: {
      host: normalizeHost(body?.host ?? ''),
      filename,
      content,
      note: typeof body?.note === 'string' ? body.note : '',
    },
  };
}

function withInspect(row) {
  return { ...row, inspect: inspectContent(row.content) };
}

export function createRulesRoutes({ db, fetchImpl }) {
  const router = new Hono();
  router.use('*', requireAuth);

  router.get('/', (c) => {
    const q = c.req.query();
    const rows = listFiles(db, {
      host: q.host ? normalizeHost(q.host) : undefined,
      q: q.q || undefined,
      by: q.by ? Number(q.by) : undefined,
      sort: q.sort || undefined,
      dir: q.dir || undefined,
      includeDeleted: q.include_deleted === '1',
      onlyGlobal: q.only_global === '1',
    });
    return c.json(rows.map(withInspect));
  });

  router.get('/meta', (c) => c.json(listMeta(db)));

  router.post('/', async (c) => {
    let body;
    try { body = await c.req.json(); } catch { return c.json({ error: 'bad request' }, 400); }
    const { error, value } = parsePayload(body);
    if (error) return c.json({ error }, 400);

    try {
      return c.json(withInspect(createFile(db, { ...value, userId: c.get('user').id })), 201);
    } catch (err) {
      if (err instanceof UniqueViolation) {
        return c.json({ error: '该域名下已存在同名规则，请改为编辑那一条' }, 409);
      }
      throw err;
    }
  });

  router.put('/:id', async (c) => {
    const id = Number(c.req.param('id'));
    const existing = getFile(db, id);
    if (!existing || existing.deleted_at) return c.json({ error: '记录不存在' }, 404);

    let body;
    try { body = await c.req.json(); } catch { return c.json({ error: 'bad request' }, 400); }
    const { error, value } = parsePayload(body);
    if (error) return c.json({ error }, 400);

    try {
      return c.json(withInspect(updateFile(db, id, { ...value, userId: c.get('user').id })));
    } catch (err) {
      if (err instanceof UniqueViolation) {
        return c.json({ error: '该域名下已存在同名规则' }, 409);
      }
      throw err;
    }
  });

  router.delete('/:id', (c) => {
    const id = Number(c.req.param('id'));
    const existing = getFile(db, id);
    if (!existing || existing.deleted_at) return c.json({ error: '记录不存在' }, 404);
    softDeleteFile(db, id, c.get('user').id);
    return c.body(null, 204);
  });

  router.post('/:id/restore', (c) => {
    const id = Number(c.req.param('id'));
    const existing = getFile(db, id);
    if (!existing) return c.json({ error: '记录不存在' }, 404);
    if (!existing.deleted_at) return c.json({ error: '该记录未被删除' }, 400);

    try {
      return c.json(withInspect(restoreFile(db, id, c.get('user').id)));
    } catch (err) {
      if (err instanceof UniqueViolation) {
        return c.json({ error: '同名规则已重新创建，无法恢复。请先处理现有的那一条' }, 409);
      }
      throw err;
    }
  });

  router.post('/:id/check', async (c) => {
    const id = Number(c.req.param('id'));
    const file = getFile(db, id);
    if (!file) return c.json({ error: '记录不存在' }, 404);

    const internal = runInternalCheck(db, file);
    const external = await runExternalCheck(file, fetchImpl ? { fetchImpl } : {});
    return c.json({ internal, external });
  });

  return router;
}
