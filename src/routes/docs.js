import { Hono } from 'hono';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { requireAuth } from '../auth.js';

// 只允许单段文件名（不含 /），杜绝路径穿越；文档 id = 去 .md 的文件名
const DOC_ID_RE = /^[a-z0-9][a-z0-9._-]*$/i;
// 分组目录名：非空、不含 /、不为 ..、不以 . 开头
const GROUP_RE = /^(?!\.)[^/]+$/;

function readTitle(content, fallback) {
  const m = content.match(/^#\s+(.+)$/m);
  return m ? m[1].trim() : fallback;
}

function readDoc(path, id) {
  let content;
  try {
    content = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  return { id, title: readTitle(content, id), content };
}

export function createDocsRoutes({ docsDir = './docs' }) {
  const router = new Hono();
  router.use('*', requireAuth);

  // 文档列表：顶层 *.md（group 为空、排在最前）+ 一级子目录内 *.md（group 为目录名），
  // 组间按目录名、组内按文件名排序，返回扁平数组由前端分组渲染
  router.get('/', (c) => {
    const docs = [];
    try {
      const entries = readdirSync(docsDir, { withFileTypes: true });
      entries
        .filter((e) => e.isFile() && e.name.endsWith('.md'))
        .map((e) => e.name)
        .sort()
        .forEach((name) => {
          const id = name.slice(0, -3);
          const doc = readDoc(join(docsDir, name), id);
          if (doc) docs.push({ id: doc.id, title: doc.title, group: '' });
        });
      entries
        .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
        .map((e) => e.name)
        .sort()
        .forEach((group) => {
          let names = [];
          try {
            names = readdirSync(join(docsDir, group)).filter((f) => f.endsWith('.md'));
          } catch {}
          names.sort();
          names.forEach((name) => {
            const id = name.slice(0, -3);
            const doc = readDoc(join(docsDir, group, name), id);
            if (doc) docs.push({ id: doc.id, title: doc.title, group });
          });
        });
    } catch {
      // 目录不存在视为没有文档
    }
    return c.json(docs);
  });

  // 组内文档（如 /api/docs/网关接入/nginx）
  router.get('/:group/:name', (c) => {
    const group = c.req.param('group');
    const name = c.req.param('name');
    if (!GROUP_RE.test(group) || !DOC_ID_RE.test(name)) return c.notFound();
    const doc = readDoc(join(docsDir, group, `${name}.md`), name);
    return doc ? c.json(doc) : c.notFound();
  });

  // 顶层文档（如 /api/docs/gateway）
  router.get('/:id', (c) => {
    const id = c.req.param('id');
    if (!DOC_ID_RE.test(id)) return c.notFound();
    const doc = readDoc(join(docsDir, `${id}.md`), id);
    return doc ? c.json(doc) : c.notFound();
  });

  return router;
}
