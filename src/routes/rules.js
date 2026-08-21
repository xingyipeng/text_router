import { Hono } from 'hono';
import {
  createFile, updateFile, getFile, listFiles, softDeleteFile, restoreFile, listMeta,
  findActiveByHostFilename,
} from '../repo/rules.js';
import { UniqueViolation } from '../repo/errors.js';
import {
  isValidFilename, normalizeHost, inspectContent, MAX_CONTENT_BYTES,
} from '../validate.js';
import { requireAuth } from '../auth.js';
import { runInternalCheck, runExternalCheck } from '../selfcheck.js';
import { getSettings } from '../settings.js';

function parsePayload(body) {
  const filename = body?.filename;
  if (!isValidFilename(filename)) {
    return { error: '路径必须以 .txt 结尾；每段 1-80 位字母、数字、下划线、连字符或点，不能是 . 或 ..，不能含首尾斜杠，总长不超过 255' };
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

  // 注意：/export、/import 必须先于 /:id 注册，否则会被参数路由吞掉
  router.get('/export', (c) => {
    const rows = listFiles(db, {}); // 只含未删除记录
    const payload = {
      version: 1,
      exported_at: new Date().toISOString(),
      count: rows.length,
      files: rows.map(({ host, filename, content, note }) => ({ host, filename, content, note })),
    };
    // 纯 ASCII 文件名，避免 Content-Disposition 编码兼容问题
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14); // YYYYMMDDHHmmss
    return c.json(payload, 200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="wx_router-rules-${stamp}.json"`,
      'Cache-Control': 'no-store',
    });
  });

  router.post('/import', async (c) => {
    let body;
    try { body = await c.req.json(); } catch { return c.json({ error: 'bad request' }, 400); }
    const mode = body?.mode;
    if (mode !== 'skip' && mode !== 'overwrite') {
      return c.json({ error: 'mode 必须是 skip 或 overwrite' }, 400);
    }
    const files = body?.files;
    if (!Array.isArray(files) || files.length === 0) {
      return c.json({ error: 'files 必须是非空数组' }, 400);
    }
    if (files.length > 5000) return c.json({ error: 'files 最多 5000 条' }, 400);

    // 逐条校验（同新建/编辑规则），失败的记录进 errors，不影响其余导入
    const userId = c.get('user').id;
    const errors = [];
    const valid = [];
    for (const f of files) {
      const { error, value } = parsePayload(f);
      if (error) {
        errors.push({
          host: typeof f?.host === 'string' ? f.host : '',
          filename: typeof f?.filename === 'string' ? f.filename : '',
          reason: error,
        });
      } else {
        valid.push(value);
      }
    }

    let imported = 0;
    let skipped = 0;
    db.transaction(() => {
      for (const v of valid) {
        const existing = findActiveByHostFilename(db, v.host, v.filename);
        if (existing) {
          if (mode === 'skip') { skipped++; continue; }
          updateFile(db, existing.id, { ...v, userId }); // overwrite
        } else {
          createFile(db, { ...v, userId });
        }
        imported++;
      }
    })();

    return c.json({ imported, skipped, errors });
  });

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
    const external = await runExternalCheck(file, {
      ...(fetchImpl ? { fetchImpl } : {}),
      timeoutMs: getSettings(db).selfcheck.timeout_seconds * 1000, // 自检超时可在设置页调整
    });
    return c.json({ internal, external });
  });

  return router;
}
