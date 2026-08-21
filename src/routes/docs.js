import { Hono } from 'hono';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { requireAuth } from '../auth.js';

// 只允许单段文件名（不含 /），杜绝路径穿越；文档 id = 去 .md 的文件名
const DOC_ID_RE = /^[a-z0-9][a-z0-9._-]*$/i;

function readTitle(content, fallback) {
  const m = content.match(/^#\s+(.+)$/m);
  return m ? m[1].trim() : fallback;
}

export function createDocsRoutes({ docsDir = './docs' }) {
  const router = new Hono();
  router.use('*', requireAuth);

  // 文档列表：docsDir 顶层 *.md，标题取文件首个 # 行
  router.get('/', (c) => {
    let names = [];
    try {
      names = readdirSync(docsDir).filter((f) => f.endsWith('.md'));
    } catch {
      // 目录不存在视为没有文档
    }
    names.sort();
    const docs = names.map((name) => {
      const id = name.slice(0, -3);
      let content = '';
      try {
        content = readFileSync(join(docsDir, name), 'utf8');
      } catch {}
      return { id, title: readTitle(content, id) };
    });
    return c.json(docs);
  });

  router.get('/:id', (c) => {
    const id = c.req.param('id');
    if (!DOC_ID_RE.test(id)) return c.notFound();
    let content;
    try {
      content = readFileSync(join(docsDir, `${id}.md`), 'utf8');
    } catch {
      return c.notFound();
    }
    return c.json({ id, title: readTitle(content, id), content });
  });

  return router;
}
