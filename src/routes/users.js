import { Hono } from 'hono';
import {
  createUser, getUser, listUsers, disableUser, restoreUser, setPassword, updateUser,
  deleteUser, countActiveFilesByUser,
} from '../repo/users.js';
import { UniqueViolation } from '../repo/errors.js';
import { MIN_PASSWORD_LENGTH, MAX_PASSWORD_LENGTH } from '../validate.js';
import { requireSuper } from '../auth.js';

const USERNAME_RE = /^[A-Za-z0-9_.@-]{1,64}$/;

export function createUserRoutes({ db }) {
  const router = new Hono();
  router.use('*', requireSuper);

  router.get('/', (c) =>
    c.json(listUsers(db, { includeDisabled: c.req.query('include_disabled') === '1' }))
  );

  router.post('/', async (c) => {
    let body;
    try { body = await c.req.json(); } catch { return c.json({ error: 'bad request' }, 400); }
    const { username, password, display_name } = body || {};

    if (typeof username !== 'string' || !USERNAME_RE.test(username)) {
      return c.json({ error: '用户名只能包含字母、数字、下划线、点、@ 和连字符，长度 1-64' }, 400);
    }
    if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH || password.length > MAX_PASSWORD_LENGTH) {
      return c.json({ error: `密码至少 ${MIN_PASSWORD_LENGTH} 个字符，最多 ${MAX_PASSWORD_LENGTH} 个字符` }, 400);
    }

    try {
      const user = createUser(db, {
        username,
        password,
        displayName: typeof display_name === 'string' ? display_name : '',
        isSuper: false,
        createdBy: c.get('user').id,
      });
      return c.json(user, 201);
    } catch (err) {
      if (err instanceof UniqueViolation) return c.json({ error: '用户名已存在' }, 409);
      throw err;
    }
  });

  router.put('/:id', async (c) => {
    const target = getUser(db, Number(c.req.param('id')));
    if (!target) return c.json({ error: '用户不存在' }, 404);

    let body;
    try { body = await c.req.json(); } catch { return c.json({ error: 'bad request' }, 400); }
    const { username, display_name } = body || {};
    const hasUsername = username !== undefined;
    const hasDisplayName = display_name !== undefined;
    if (!hasUsername && !hasDisplayName) {
      return c.json({ error: '没有需要修改的内容' }, 400);
    }
    if (hasUsername && (typeof username !== 'string' || !USERNAME_RE.test(username.trim()))) {
      return c.json({ error: '用户名只能包含字母、数字、下划线、点、@ 和连字符，长度 1-64' }, 400);
    }
    if (hasDisplayName && typeof display_name !== 'string') {
      return c.json({ error: '显示名必须是字符串' }, 400);
    }

    try {
      return c.json(updateUser(db, target.id, {
        username: hasUsername ? username.trim() : undefined,
        displayName: hasDisplayName ? display_name.trim() : undefined,
      }));
    } catch (err) {
      if (err instanceof UniqueViolation) return c.json({ error: '用户名已存在' }, 409);
      throw err;
    }
  });

  router.delete('/:id', (c) => {
    const target = getUser(db, Number(c.req.param('id')));
    if (!target) return c.json({ error: '用户不存在' }, 404);
    if (target.is_super) return c.json({ error: '超级管理员不可被禁用' }, 403);
    if (target.disabled_at) return c.json({ error: '该用户已被禁用' }, 400);

    disableUser(db, target.id);
    return c.body(null, 204);
  });

  // 彻底删除（区别于上面的软删除/禁用）
  router.delete('/:id/permanent', (c) => {
    const target = getUser(db, Number(c.req.param('id')));
    if (!target) return c.json({ error: '用户不存在' }, 404);
    if (target.is_super) return c.json({ error: '超级管理员不可被删除' }, 403);

    const n = countActiveFilesByUser(db, target.id);
    if (n > 0) {
      return c.json({ error: `该用户名下还有 ${n} 条路由记录，请先删除或转移` }, 400);
    }

    deleteUser(db, target.id);
    return c.body(null, 204);
  });

  router.post('/:id/restore', (c) => {
    const target = getUser(db, Number(c.req.param('id')));
    if (!target) return c.json({ error: '用户不存在' }, 404);
    if (!target.disabled_at) return c.json({ error: '该用户未被禁用' }, 400);

    try {
      return c.json(restoreUser(db, target.id));
    } catch (err) {
      if (err instanceof UniqueViolation) {
        return c.json({ error: '同名账号已重新创建，无法恢复' }, 409);
      }
      throw err;
    }
  });

  router.post('/:id/password', async (c) => {
    const target = getUser(db, Number(c.req.param('id')));
    if (!target) return c.json({ error: '用户不存在' }, 404);

    let body;
    try { body = await c.req.json(); } catch { return c.json({ error: 'bad request' }, 400); }
    const { new_password } = body || {};
    if (typeof new_password !== 'string' || new_password.length < MIN_PASSWORD_LENGTH || new_password.length > MAX_PASSWORD_LENGTH) {
      return c.json({ error: `密码至少 ${MIN_PASSWORD_LENGTH} 个字符，最多 ${MAX_PASSWORD_LENGTH} 个字符` }, 400);
    }

    setPassword(db, target.id, new_password);
    return c.body(null, 204);
  });

  return router;
}
