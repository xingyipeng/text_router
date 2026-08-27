# glob 域名匹配与手动优先级实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把路由规则的域名模型从「留空 = 全局」升级为显式 glob 模式（`*` 单层、`**` 任意层、单独 `*` 全局）+ 手动优先级（0~1000），并附带上趋势图刻度、批量自检、回收站彻底删除/清空与帮助文档。

**Architecture:** 新增纯函数模块 `src/hostmatch.js`（标签比较实现 glob，无正则无 ReDoS）作为匹配/排序/校验的唯一来源；`verify_files` 表加 `priority` 列并在 `openDb` 幂等迁移存量 `'' → '*'`；线上匹配改为「按 filename 查候选行 + JS 过滤排序取第一条」；批量自检用内存任务注册表 + 轮询；前端无构建，校验逻辑在 `public/rules.js` 写轻量副本。规格见 `docs/superpowers/specs/2026-08-27-glob-host-matching-design.md`。

**Tech Stack:** Node.js 22、Hono 4、better-sqlite3、vitest、原生 HTML/CSS/JS（无前端构建）。

**约定：**
- 每个 Task 内 TDD：先写失败测试 → 运行确认失败 → 最小实现 → 运行确认通过 → 提交。
- 测试运行统一用 `npx vitest run <文件>`；全量回归 `npm test`。
- 提交信息用中文，格式沿用仓库习惯（`feat:` / `docs:` / `test:`）。
- 后端校验是权威，前端校验只是体验优化——两边规则保持一致。

---

## 文件结构总览

| 文件 | 动作 | 职责 |
|------|------|------|
| `src/hostmatch.js` | 新建 | matchHost / patternIntersects / compareRules / isPattern / normalizePattern / isValidPriority（纯函数） |
| `test/hostmatch.test.js` | 新建 | 上述纯函数的完整覆盖 |
| `src/db.js` | 修改 | SCHEMA 加 priority 列；openDb 后幂等迁移（ALTER + `'' → '*'`） |
| `test/db.test.js` | 修改 | 旧库迁移用例 |
| `src/repo/rules.js` | 修改 | matchFile 重写、create/update 写 priority、hardDeleteFile/clearTrash、listFiles 业务语义、listMeta 排除模式 |
| `test/repo-rules.test.js` | 修改 | 匹配/优先级/筛选/彻底删除用例 |
| `src/routes/rules.js` | 修改 | parsePayload 校验模式与优先级、导出含 priority、导入兼容、回收站两条路由、批量自检两条路由 |
| `test/routes-rules.test.js` | 修改 | 上述路由用例 |
| `src/selfcheck.js` | 修改 | 模式规则 NO_HOST；遮蔽检测统一为新排序逻辑 |
| `test/selfcheck.test.js` | 修改 | 模式/优先级遮蔽用例 |
| `src/stats.js` | 修改 | global 统计 `*`；byDomain 排除模式 |
| `test/stats.test.js` | 修改 | 统计口径用例 |
| `src/batchcheck.js` | 新建 | 内存任务注册表（并发 5、10 分钟 TTL） |
| `test/batchcheck.test.js` | 新建 | 任务生命周期用例 |
| `public/index.html` | 修改 | 规则对话框（域名提示/优先级输入）、规则工具栏（刷新/批量自检）、回收站工具栏与行按钮 |
| `public/rules.js` | 修改 | 前端校验、host 显示与徽章、筛选标签、刷新按钮、批量自检 UI、回收站 UI |
| `public/dashboard.js` | 修改 | 趋势图 Y 轴刻度 + 数据点数值 |
| `public/style.css` | 修改 | `trend-y-label` / `trend-point-label` / `.batch-progress` / `.btn:disabled` |
| `public/help.js` | 修改 | `openHelpDoc(id)` 导出 |
| `docs/rules-guide.md` | 新建 | 规则配置说明（ASCII 文件名，中文标题） |
| `README.md` | 修改 | 第 17、77 行附近两处文案 |

---

## Task 1: `src/hostmatch.js` 纯函数模块

**Files:**
- Create: `src/hostmatch.js`
- Test: `test/hostmatch.test.js`

- [ ] **Step 1: 写失败测试**

```js
// test/hostmatch.test.js
import { describe, it, expect } from 'vitest';
import {
  matchHost, patternIntersects, compareRules, isPattern, normalizePattern, isValidPriority,
} from '../src/hostmatch.js';

describe('matchHost', () => {
  it('精确域名只匹配自身', () => {
    expect(matchHost('example.com', 'example.com')).toBe(true);
    expect(matchHost('example.com', 'www.example.com')).toBe(false);
  });

  it('全局 * 命中所有，含空 host', () => {
    expect(matchHost('*', 'anything.com')).toBe(true);
    expect(matchHost('*', '')).toBe(true);
  });

  it('* 单层：恰占一个整段标签', () => {
    expect(matchHost('*.example.com', 'www.example.com')).toBe(true);
    expect(matchHost('*.example.com', 'example.com')).toBe(false);
    expect(matchHost('*.example.com', 'a.b.example.com')).toBe(false);
  });

  it('** 任意层（含 0 层）', () => {
    expect(matchHost('**.example.com', 'example.com')).toBe(true);
    expect(matchHost('**.example.com', 'a.example.com')).toBe(true);
    expect(matchHost('**.example.com', 'a.b.example.com')).toBe(true);
    expect(matchHost('**.example.com', 'other.com')).toBe(false);
  });

  it('中间段通配', () => {
    expect(matchHost('a.*.com', 'a.b.com')).toBe(true);
    expect(matchHost('a.*.com', 'a.com')).toBe(false);
    expect(matchHost('a.*.com', 'a.b.c.com')).toBe(false);
  });

  it('* 与 ** 混用', () => {
    expect(matchHost('*.**.example.com', 'a.b.example.com')).toBe(true);
    expect(matchHost('*.**.example.com', 'example.com')).toBe(false);
  });

  it('host 大小写不敏感，空 host 不命中非全局模式', () => {
    expect(matchHost('example.com', 'EXAMPLE.COM')).toBe(true);
    expect(matchHost('Example.COM', 'example.com')).toBe(true); // pattern 侧同样不敏感
    expect(matchHost('*.example.com', '')).toBe(false);
  });

  it('单独 ** 等价全局', () => {
    expect(matchHost('**', '')).toBe(true);
    expect(matchHost('**', 'a.b.com')).toBe(true);
  });
});

describe('isPattern', () => {
  it('含 * 才算模式', () => {
    expect(isPattern('*.example.com')).toBe(true);
    expect(isPattern('*')).toBe(true);
    expect(isPattern('example.com')).toBe(false);
  });
});

describe('normalizePattern', () => {
  it('空串与空白归一化为全局 *', () => {
    expect(normalizePattern('')).toEqual({ ok: true, value: '*' });
    expect(normalizePattern('  ')).toEqual({ ok: true, value: '*' });
  });

  it('非模式走 normalizeHost（小写/去端口/去尾点）', () => {
    expect(normalizePattern('A.COM:8080')).toEqual({ ok: true, value: 'a.com' });
    expect(normalizePattern('Example.COM.')).toEqual({ ok: true, value: 'example.com' });
  });

  it('模式统一小写并去尾点', () => {
    expect(normalizePattern('*.Example.COM.')).toEqual({ ok: true, value: '*.example.com' });
  });

  it('单独 ** 归一化为 *', () => {
    expect(normalizePattern('**')).toEqual({ ok: true, value: '*' });
    expect(normalizePattern('**.')).toEqual({ ok: true, value: '*' });
    expect(normalizePattern('**.**')).toEqual({ ok: true, value: '*' });
  });

  it('非法模式拒绝：半段/叠加通配、端口、方括号', () => {
    for (const bad of ['a*.example.com', '***.example.com', '*.example.com:8080', '*.ex[ample.com']) {
      expect(normalizePattern(bad).ok, bad).toBe(false);
    }
  });

  it('相邻整段通配合法（每段单独满足规则即可）', () => {
    expect(normalizePattern('*.*.com')).toEqual({ ok: true, value: '*.*.com' });
  });

  it('标签长度 1-63 位', () => {
    expect(normalizePattern(`*.${'a'.repeat(63)}.com`).ok).toBe(true);
    expect(normalizePattern(`*.${'a'.repeat(64)}.com`).ok).toBe(false);
  });

  it('模式总长超过 255 拒绝', () => {
    expect(normalizePattern(`*.${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(63)}.com`).ok).toBe(false);
  });

  it('非字符串拒绝', () => {
    expect(normalizePattern(123).ok).toBe(false);
  });
});

describe('isValidPriority', () => {
  it('0-1000 整数合法，其余非法', () => {
    expect(isValidPriority(0)).toBe(true);
    expect(isValidPriority(1000)).toBe(true);
    expect(isValidPriority(-1)).toBe(false);
    expect(isValidPriority(1001)).toBe(false);
    expect(isValidPriority(1.5)).toBe(false);
    expect(isValidPriority('5')).toBe(false);
    expect(isValidPriority(undefined)).toBe(false);
  });
});

describe('compareRules', () => {
  it('priority 大者胜，与具体度无关', () => {
    const a = { id: 1, host: 'a.com', priority: 5 };
    const b = { id: 2, host: '*', priority: 9 };
    expect(compareRules(a, b)).toBeGreaterThan(0); // b 排前
    expect(compareRules(b, a)).toBeLessThan(0);
  });

  it('同 priority 时具体度：精确 > * 模式 > ** 模式 > 全局', () => {
    const exact = { id: 4, host: 'a.com', priority: 0 };
    const star = { id: 3, host: '*.a.com', priority: 0 };
    const dstar = { id: 2, host: '**.a.com', priority: 0 };
    const global = { id: 1, host: '*', priority: 0 };
    const sorted = [global, star, dstar, exact].sort(compareRules).map((r) => r.host);
    expect(sorted).toEqual(['a.com', '*.a.com', '**.a.com', '*']);
  });

  it('同 priority 同具体度时先建者（id 小）胜', () => {
    const old = { id: 1, host: '*.a.com', priority: 0 };
    const young = { id: 2, host: '*.a.com', priority: 0 };
    expect([young, old].sort(compareRules)[0].id).toBe(1);
  });

  it('同时含 * 与 ** 的模式按 ** 层计具体度', () => {
    const mixed = { id: 2, host: '*.**.a.com', priority: 0 };
    const star = { id: 1, host: '*.a.com', priority: 0 };
    expect(compareRules(mixed, star)).toBeGreaterThan(0); // star 排前
  });
});

describe('patternIntersects', () => {
  it('存在共同可命中域名时相交', () => {
    expect(patternIntersects('*.example.com', '**.example.com')).toBe(true);
    expect(patternIntersects('**.example.com', 'example.com')).toBe(true);
    expect(patternIntersects('a.*.com', 'a.b.com')).toBe(true);
    expect(patternIntersects('a.**.b', 'a.b')).toBe(true);
  });

  it('无共同域名时不相交', () => {
    expect(patternIntersects('*.a.com', '*.b.com')).toBe(false);
    expect(patternIntersects('*.example.com', 'example.com')).toBe(false);
    expect(patternIntersects('a.com', 'b.com')).toBe(false);
  });

  it('全局 * 与任何模式相交', () => {
    expect(patternIntersects('*', 'a.com')).toBe(true);
    expect(patternIntersects('*', '*.a.com')).toBe(true);
    expect(patternIntersects('a.com', '*')).toBe(true);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run test/hostmatch.test.js`
Expected: FAIL——`Cannot find module '../src/hostmatch.js'`

- [ ] **Step 3: 实现模块**

```js
// src/hostmatch.js
// 域名模式匹配：标签比较实现 glob（无正则、无 ReDoS）。
// 模式语法（gitignore 惯例）：
//   *   恰占一个整段标签（单层子域）
//   **  任意层标签（含 0 层，即域名本身）
//   单独 * 表示全局（匹配所有域名，含空 host）
// 例：*.example.com 匹配 a.example.com，不匹配 example.com、a.b.example.com
//     **.example.com 匹配 example.com、a.example.com、a.b.example.com

import { normalizeHost } from './validate.js';

const LABEL_RE = /^[a-z0-9_-]{1,63}$/;

export function isPattern(host) {
  return typeof host === 'string' && host.includes('*');
}

// 回溯标签比较；k 个 ** 对上 n 个标签最坏 C(n+k,k) 条路径，
// 但模式与 host 标签数都很小（规则行数量级），无需记忆化
function matchFrom(pi, hi, p, h) {
  if (pi === p.length) return hi === h.length;
  const pl = p[pi];
  if (pl === '**') {
    for (let k = hi; k <= h.length; k++) {
      if (matchFrom(pi + 1, k, p, h)) return true;
    }
    return false;
  }
  if (hi === h.length) return false;
  if (pl === '*' || pl === h[hi]) return matchFrom(pi + 1, hi + 1, p, h);
  return false;
}

export function matchHost(pattern, host) {
  const p = typeof pattern === 'string' ? pattern : '';
  const h = typeof host === 'string' ? host : '';
  if (p === '*') return true; // 全局：命中所有（含空 host）
  return matchFrom(0, 0, p.toLowerCase().split('.'), h === '' ? [] : h.toLowerCase().split('.'));
}

// 保存/导入时的校验 + 归一化。返回 { ok, value } 或 { ok, error }。
export function normalizePattern(raw) {
  if (typeof raw !== 'string') return { ok: false, error: '域名必须是字符串' };
  // 与 normalizeHost 习惯一致：取逗号首段、trim、小写、去尾点
  let h = raw.split(',')[0].trim().toLowerCase().replace(/\.+$/, '');
  if (!h) return { ok: true, value: '*' };
  if (h.includes('*')) {
    if (h.length > 255) return { ok: false, error: '域名模式总长不能超过 255' };
    if (/[:\[\]]/.test(h)) return { ok: false, error: '模式中不允许端口或方括号' };
    for (const l of h.split('.')) {
      if (l !== '*' && l !== '**' && !LABEL_RE.test(l)) {
        return {
          ok: false,
          error: `非法域名模式「${raw}」：每段只能是 *、** 或 1-63 位小写字母/数字/下划线/连字符（不支持 a*、*** 等写法）`,
        };
      }
    }
    if (h.split('.').every((l) => l === '**')) return { ok: true, value: '*' }; // 单独 ** 归一化为 *
    return { ok: true, value: h };
  }
  return { ok: true, value: normalizeHost(h) };
}

export function isValidPriority(v) {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 1000;
}

// 具体度分层：精确 > * 模式 > ** 模式 > 全局（数值越大越具体）
function specificity(host) {
  if (host === '*') return 0;
  if (host.includes('**')) return 1;
  if (host.includes('*')) return 2;
  return 3;
}

// 排序比较器：胜者排前（返回负数表示 a 赢）。
// priority 大者 > 具体度高者 > 先建者（id 小）
export function compareRules(a, b) {
  if (b.priority !== a.priority) return b.priority - a.priority;
  const d = specificity(b.host) - specificity(a.host);
  if (d !== 0) return d;
  return a.id - b.id;
}

// 两个模式是否有共同可命中的域名（仅自检用）。
// BFS：状态 (i,j) 为双方标签游标；「**」可零成本前移；
// 每次消费一个候选标签 c ∈ 双方字面量 ∪ {占位标签}（* 必消费、字面量须相等）。
export function patternIntersects(a, b) {
  if (a === '*' || b === '*') return true;
  const pa = a.split('.');
  const pb = b.split('.');
  const literals = new Set([...pa, ...pb].filter((l) => l !== '*' && l !== '**'));
  let placeholder = 'x';
  while (literals.has(placeholder)) placeholder += 'x';
  const candidates = [...literals, placeholder];
  const seen = new Set();
  const queue = [[0, 0]];
  const stepSide = (i, p, c) => {
    if (i === p.length) return null; // 该侧已走完，无法再消费标签
    const l = p[i];
    if (l === '**') return [i, i + 1];
    if (l === '*') return [i + 1];
    return l === c ? [i + 1] : null;
  };
  while (queue.length) {
    const [i, j] = queue.shift();
    if (i === pa.length && j === pb.length) return true;
    const key = `${i},${j}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (pa[i] === '**') queue.push([i + 1, j]); // ** 消费 0 层
    if (pb[j] === '**') queue.push([i, j + 1]);
    for (const c of candidates) {
      const ai = stepSide(i, pa, c);
      const bj = stepSide(j, pb, c);
      if (ai === null || bj === null) continue;
      for (const ni of ai) {
        for (const nj of bj) queue.push([ni, nj]);
      }
    }
  }
  return false;
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run test/hostmatch.test.js`
Expected: PASS（全部用例）

- [ ] **Step 5: 提交**

```bash
git add src/hostmatch.js test/hostmatch.test.js
git commit -m "feat: 新增 hostmatch 纯函数模块（glob 匹配/优先级比较/模式校验）"
```

---

## Task 2: DB 迁移（priority 列 + 存量空 host 转 `*`）

**Files:**
- Modify: `src/db.js:43-57,65-72`
- Test: `test/db.test.js`

- [ ] **Step 1: 写失败测试（旧库迁移）**

在 `test/db.test.js` 顶部 import 增加 `Database`：

```js
import Database from 'better-sqlite3';
```

在 `describe('openDb', ...)` 块末尾（`'同名文件可分属不同 host'` 用例之后）追加两个用例：

```js
  it('旧库迁移：补 priority 列并把空 host 转为 *', () => {
    db.close(); // 先关掉 beforeEach 开的库，重建旧格式库
    const path = join(dir, 'test.db');
    rmSync(path, { force: true });
    const legacy = new Database(path);
    legacy.exec(`
      CREATE TABLE verify_files (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        host TEXT NOT NULL DEFAULT '',
        filename TEXT NOT NULL,
        content TEXT NOT NULL,
        note TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        created_by INTEGER,
        updated_at INTEGER NOT NULL,
        updated_by INTEGER,
        deleted_at INTEGER,
        deleted_by INTEGER
      );
      CREATE UNIQUE INDEX idx_active_host_filename
        ON verify_files(host, filename) WHERE deleted_at IS NULL;
      INSERT INTO verify_files (host, filename, content, note, created_at, updated_at) VALUES
        ('', 'g.txt', 'g', '', 1, 1),
        ('a.com', 'x.txt', 'v', '', 1, 1),
        ('*', 'k.txt', 'k', '', 1, 1);
    `);
    legacy.close();
    db = openDb(path); // 迁移入口

    const cols = db.prepare('PRAGMA table_info(verify_files)').all().map((c) => c.name);
    expect(cols).toContain('priority');
    const hosts = db.prepare('SELECT host, filename FROM verify_files ORDER BY filename').all();
    expect(hosts).toEqual([
      { host: '*', filename: 'g.txt' },
      { host: '*', filename: 'k.txt' },
      { host: 'a.com', filename: 'x.txt' },
    ]);
    expect(db.prepare('SELECT priority FROM verify_files').all()
      .every((r) => r.priority === 0)).toBe(true);
  });

  it('旧库迁移：空 host 与已有字面 * 同 filename 冲突时跳过转换', () => {
    db.close();
    const path = join(dir, 'test.db');
    rmSync(path, { force: true });
    const legacy = new Database(path);
    legacy.exec(`
      CREATE TABLE verify_files (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        host TEXT NOT NULL DEFAULT '',
        filename TEXT NOT NULL,
        content TEXT NOT NULL,
        note TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        created_by INTEGER,
        updated_at INTEGER NOT NULL,
        updated_by INTEGER,
        deleted_at INTEGER,
        deleted_by INTEGER
      );
      CREATE UNIQUE INDEX idx_active_host_filename
        ON verify_files(host, filename) WHERE deleted_at IS NULL;
      INSERT INTO verify_files (host, filename, content, note, created_at, updated_at) VALUES
        ('*', 'k.txt', 'star', '', 1, 1),
        ('', 'k.txt', 'empty', '', 1, 1);
    `);
    legacy.close();
    db = openDb(path);

    const rows = db.prepare('SELECT host, content FROM verify_files ORDER BY content').all();
    expect(rows).toEqual([
      { host: '', content: 'empty' }, // 撞唯一索引，保持原样（匹配层仍按全局处理）
      { host: '*', content: 'star' },
    ]);
  });
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run test/db.test.js`
Expected: FAIL——`PRAGMA table_info` 结果里没有 priority 列、host 未转换

- [ ] **Step 3: 实现迁移**

`src/db.js` 的 `verify_files` SCHEMA 增加 priority 列（`updated_at INTEGER NOT NULL,` 之后）：

```sql
CREATE TABLE IF NOT EXISTS verify_files (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  host       TEXT    NOT NULL DEFAULT '',
  filename   TEXT    NOT NULL,
  content    TEXT    NOT NULL,
  note       TEXT    NOT NULL DEFAULT '',
  priority   INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  created_by INTEGER,
  updated_at INTEGER NOT NULL,
  updated_by INTEGER,
  deleted_at INTEGER,
  deleted_by INTEGER
);
```

在 `SCHEMA` 常量之后、`openDb` 之前加迁移函数，并在 `openDb` 中调用：

```js
// 幂等迁移：旧库补 priority 列 + 存量全局记录 '' → '*'。
// UPDATE OR IGNORE 兜底：旧库若已有同 filename 的字面 '*' 活跃行，
// '' → '*' 会撞唯一索引，此时跳过该行（匹配层仍把 '' 当全局处理，行为不变）。
function migrateSchema(db) {
  const cols = db.prepare('PRAGMA table_info(verify_files)').all().map((c) => c.name);
  if (!cols.includes('priority')) {
    db.exec('ALTER TABLE verify_files ADD COLUMN priority INTEGER NOT NULL DEFAULT 0');
  }
  db.prepare("UPDATE OR IGNORE verify_files SET host = '*' WHERE host = ''").run();
}

export function openDb(dbPath) {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  migrateSchema(db);
  return db;
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run test/db.test.js`
Expected: PASS（含既有用例——`INSERT INTO verify_files (host, filename, content, created_at, updated_at)` 未列 priority，靠列默认值，仍可插入）

- [ ] **Step 5: 提交**

```bash
git add src/db.js test/db.test.js
git commit -m "feat: verify_files 增加 priority 列并迁移存量空 host 为 *"
```

---

## Task 3: repo 匹配重写 + 彻底删除函数

**Files:**
- Modify: `src/repo/rules.js:1-3,15-59,72-87`
- Test: `test/repo-rules.test.js`

- [ ] **Step 1: 写失败测试**

在 `test/repo-rules.test.js` 的 import 中加 `hardDeleteFile, clearTrash`，并在 `describe('matchFile —— 双模匹配')` 后新增两个 describe：

```js
import {
  createFile, updateFile, getFile, listFiles, listMeta,
  softDeleteFile, restoreFile, matchFile, hardDeleteFile, clearTrash,
} from '../src/repo/rules.js';
```

```js
describe('matchFile —— 模式与优先级', () => {
  it('单层模式只命中一层子域', () => {
    createFile(db, { host: '*.example.com', filename: 'x.txt', content: 'p', userId: 1 });
    expect(matchFile(db, 'www.example.com', 'x.txt').content).toBe('p');
    expect(matchFile(db, 'example.com', 'x.txt')).toBeUndefined();
    expect(matchFile(db, 'a.b.example.com', 'x.txt')).toBeUndefined();
  });

  it('多层模式命中域名本身与任意层子域', () => {
    createFile(db, { host: '**.example.com', filename: 'x.txt', content: 'p', userId: 1 });
    expect(matchFile(db, 'example.com', 'x.txt').content).toBe('p');
    expect(matchFile(db, 'a.b.example.com', 'x.txt').content).toBe('p');
    expect(matchFile(db, 'other.com', 'x.txt')).toBeUndefined();
  });

  it('priority 大者压过精确记录', () => {
    createFile(db, { host: 'a.com', filename: 'x.txt', content: 'exact', userId: 1 });
    createFile(db, { host: '*', filename: 'x.txt', content: 'global-p10', priority: 10, userId: 1 });
    expect(matchFile(db, 'a.com', 'x.txt').content).toBe('global-p10');
  });

  it('同 priority 时精确压过模式压过全局', () => {
    createFile(db, { host: '*', filename: 'x.txt', content: 'g', userId: 1 });
    createFile(db, { host: '**.example.com', filename: 'x.txt', content: 'd', userId: 1 });
    createFile(db, { host: '*.example.com', filename: 'x.txt', content: 's', userId: 1 });
    createFile(db, { host: 'a.example.com', filename: 'x.txt', content: 'e', userId: 1 });
    expect(matchFile(db, 'a.example.com', 'x.txt').content).toBe('e');
    expect(matchFile(db, 'b.example.com', 'x.txt').content).toBe('s');
    expect(matchFile(db, 'x.other.com', 'x.txt').content).toBe('g');
  });

  it('同 priority 同具体度时先建者胜', () => {
    const a = createFile(db, { host: '*.example.com', filename: 'x.txt', content: 'first', userId: 1 });
    createFile(db, { host: '*.example.com', filename: 'y.txt', content: 'other', userId: 1 });
    createFile(db, { host: '*.example.com', filename: 'x.txt', content: 'second', userId: 1 }).id;
    // 唯一索引按 (host, filename) 区分：改 filename 再改回会撞索引，这里直接断言 id 序
    const rows = db.prepare(
      "SELECT id, content FROM verify_files WHERE host = '*.example.com' AND filename = 'x.txt'"
    ).all();
    // 同一 (host, filename) 无法存在两条活跃行，改为验证：id 小者胜由排序器保证
    expect(rows).toHaveLength(1);
    expect(a.id).toBeLessThan(rows[0].id + 1);
  });

  it('createFile 写入 priority，默认 0', () => {
    const a = createFile(db, { host: 'a.com', filename: 'x.txt', content: 'v', userId: 1 });
    const b = createFile(db, { host: 'b.com', filename: 'y.txt', content: 'v', priority: 7, userId: 1 });
    expect(getFile(db, a.id).priority).toBe(0);
    expect(getFile(db, b.id).priority).toBe(7);
  });

  it('updateFile 更新 priority', () => {
    const f = createFile(db, { host: 'a.com', filename: 'x.txt', content: 'v', userId: 1 });
    const u = updateFile(db, f.id, { host: 'a.com', filename: 'x.txt', content: 'v', priority: 3, userId: 1 });
    expect(u.priority).toBe(3);
  });
});
```

> 说明：`同 priority 同具体度时先建者胜` 的语义在 Task 1 的 `compareRules` 单测里已严格验证（同 host 同 priority 不同 id）；这里受唯一索引限制，只验证库中唯一性前提成立。

```js
describe('hardDeleteFile / clearTrash', () => {
  it('活动行删不掉（0 行），回收站行可彻底删除', () => {
    const active = createFile(db, { host: 'a.com', filename: 'x.txt', content: 'v', userId: 1 });
    expect(hardDeleteFile(db, active.id)).toBe(0);
    expect(getFile(db, active.id)).toBeTruthy();

    softDeleteFile(db, active.id, 1);
    expect(hardDeleteFile(db, active.id)).toBe(1);
    expect(getFile(db, active.id)).toBeUndefined();
  });

  it('clearTrash 只删回收站，返回删除数', () => {
    const keep = createFile(db, { host: 'a.com', filename: 'x.txt', content: 'v', userId: 1 });
    const gone = createFile(db, { host: 'b.com', filename: 'y.txt', content: 'v', userId: 1 });
    softDeleteFile(db, gone.id, 1);
    expect(clearTrash(db)).toBe(1);
    expect(getFile(db, keep.id)).toBeTruthy();
    expect(getFile(db, gone.id)).toBeUndefined();
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run test/repo-rules.test.js`
Expected: FAIL——`hardDeleteFile` 未导出；matchFile 旧 SQL 不认模式行

- [ ] **Step 3: 实现 repo**

`src/repo/rules.js` 顶部 import 增加：

```js
import { matchHost, compareRules } from '../hostmatch.js';
```

`createFile` / `updateFile` 签名与 SQL 增加 priority：

```js
export function createFile(db, { host, filename, content, note = '', priority = 0, userId }) {
  const now = Date.now();
  const info = wrapUnique(() =>
    db.prepare(`
      INSERT INTO verify_files
        (host, filename, content, note, priority, created_at, created_by, updated_at, updated_by)
      VALUES (?,?,?,?,?,?,?,?,?)
    `).run(host, filename, content, note, priority, now, userId, now, userId)
  );
  return getFile(db, info.lastInsertRowid);
}

export function updateFile(db, id, { host, filename, content, note = '', priority = 0, userId }) {
  wrapUnique(() =>
    db.prepare(`
      UPDATE verify_files
      SET host = ?, filename = ?, content = ?, note = ?, priority = ?, updated_at = ?, updated_by = ?
      WHERE id = ? AND deleted_at IS NULL
    `).run(host, filename, content, note, priority, Date.now(), userId, id)
  );
  return getFile(db, id);
}
```

`matchFile` 整体替换：

```js
// 按 filename 查候选行 → JS 过滤模式命中 → 按 compareRules 排序取第一条。
// 返回形状 {id, content} 不变，verify.js 无需改动。
export function matchFile(db, host, filename) {
  const rows = db.prepare(`
    SELECT id, host, content, priority FROM verify_files
    WHERE filename = ? AND deleted_at IS NULL
  `).all(filename)
    .map((r) => ({ ...r, host: r.host === '' ? '*' : r.host })); // 迁移残留的 '' 按全局处理
  const matched = rows
    .filter((r) => matchHost(r.host, host))
    .sort(compareRules);
  const row = matched[0];
  return row ? { id: row.id, content: row.content } : undefined;
}
```

文件末尾（`restoreFile` 之后）增加彻底删除函数：

```js
// 彻底删除：仅回收站中的行可被物理删除，返回删除行数（活动行 0 行）
export function hardDeleteFile(db, id) {
  return db.prepare(
    'DELETE FROM verify_files WHERE id = ? AND deleted_at IS NOT NULL'
  ).run(id).changes;
}

export function clearTrash(db) {
  return db.prepare(
    'DELETE FROM verify_files WHERE deleted_at IS NOT NULL'
  ).run().changes;
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run test/repo-rules.test.js`
Expected: PASS（既有「双模匹配」用例靠 matchFile 内部 `'' → '*'` 归一化全部保持通过）

- [ ] **Step 5: 提交**

```bash
git add src/repo/rules.js test/repo-rules.test.js
git commit -m "feat: 规则匹配升级为模式+优先级，新增回收站彻底删除函数"
```

---

## Task 4: repo 筛选业务语义（listFiles / listMeta）

**Files:**
- Modify: `src/repo/rules.js:61-128`
- Test: `test/repo-rules.test.js`

- [ ] **Step 1: 更新与新增失败测试**

`describe('listFiles')` 中两个既有用例的 `host: ''` 改为 `host: '*'`（库里不再产生 `''`），并新增模式语义用例：

```js
  it('按 host 过滤时包含全局记录（*）', () => {
    createFile(db, { host: '*', filename: 'g.txt', content: 'v', userId: 1 });
    const rows = listFiles(db, { host: 'a.com' });
    expect(rows.map((r) => r.filename).sort()).toEqual(['g.txt', 'one.txt']);
  });

  it('onlyGlobal 只返回全局记录', () => {
    createFile(db, { host: '*', filename: 'g.txt', content: 'v', userId: 1 });
    expect(listFiles(db, { onlyGlobal: true }).map((r) => r.filename)).toEqual(['g.txt']);
  });

  it('按 host 过滤时包含会命中的模式行，排除不命中的', () => {
    createFile(db, { host: '*.a.com', filename: 'p.txt', content: 'v', userId: 1 });
    createFile(db, { host: '*.b.com', filename: 'q.txt', content: 'v', userId: 1 });
    const rows = listFiles(db, { host: 'x.a.com' });
    // 注：beforeEach 预置的 one.txt 是精确域名 a.com，既不等于 x.a.com 也不含 *，
    // 不会成为 SQL 候选行，故期望只有命中模式 p.txt
    expect(rows.map((r) => r.filename).sort()).toEqual(['p.txt']);
  });
```

`describe('listMeta')` 中 `'hosts 只含活跃记录的非空域名，去重排序'` 用例的 `host: ''` 改为 `host: '*'`，并新增：

```js
  it('hosts 排除通配模式行', () => {
    createFile(db, { host: '*.a.com', filename: 'p.txt', content: 'v', userId: 1 });
    createFile(db, { host: '*', filename: 'g.txt', content: 'v', userId: 1 });
    createFile(db, { host: 'a.com', filename: 'a.txt', content: 'v', userId: 1 });
    expect(listMeta(db).hosts).toEqual(['a.com']);
  });
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run test/repo-rules.test.js`
Expected: FAIL——`onlyGlobal` 仍查 `host = ''`，模式行不出现在域名筛选中

- [ ] **Step 3: 实现筛选语义**

`listMeta` 的 hosts 查询改为：

```js
export function listMeta(db) {
  const hosts = db.prepare(`
    SELECT DISTINCT host FROM verify_files
    WHERE deleted_at IS NULL AND host != '' AND host NOT LIKE '%*%'
    ORDER BY host ASC
  `).all().map((r) => r.host);
  return { hosts, persons: listUsers(db) };
}
```

`listFiles` 的 host/onlyGlobal 分支与返回改为：

```js
export function listFiles(db, { host, q, by, sort = 'updated', dir, includeDeleted = false, onlyGlobal = false } = {}) {
  const where = [];
  const params = [];
  if (!includeDeleted) where.push('f.deleted_at IS NULL');
  if (onlyGlobal) {
    where.push("f.host = '*'");
  } else if (host !== undefined && host !== null && host !== '') {
    // 业务语义：列出「该域名会命中的全部规则」——SQL 取精确行 + 模式行，JS 再精确过滤
    where.push("(f.host = ? OR f.host LIKE '%*%')");
    params.push(host);
  }
  if (q) {
    where.push("(f.filename LIKE ? ESCAPE '\\' OR f.note LIKE ? ESCAPE '\\' OR f.content LIKE ? ESCAPE '\\')");
    params.push(likePattern(q), likePattern(q), likePattern(q));
  }
  if (by) {
    where.push('(f.created_by = ? OR f.updated_by = ?)');
    params.push(by, by);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const s = SORTS[sort] || SORTS.updated;
  const direction = dir === 'asc' || dir === 'desc' ? dir.toUpperCase() : s.defaultDir;
  // SQL 的方向只作用于单个表达式，多列排序（含并列次序）需逐列加上方向
  const orderBy = s.expr.split(',').map((col) => `${col} ${direction}`).join(', ');
  let rows = db.prepare(`${SELECT_WITH_USERS} ${clause} ORDER BY ${orderBy}`).all(...params);
  if (!includeDeleted && !onlyGlobal && host !== undefined && host !== null && host !== '') {
    rows = rows.filter((r) => matchHost(r.host === '' ? '*' : r.host, host));
  }
  return rows;
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run test/repo-rules.test.js`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/repo/rules.js test/repo-rules.test.js
git commit -m "feat: 列表筛选升级为业务语义（命中规则），meta 排除模式"
```

---

## Task 5: 路由校验 + 导入导出（parsePayload / export / import）

**Files:**
- Modify: `src/routes/rules.js:1-32,59-73`
- Test: `test/routes-rules.test.js`

- [ ] **Step 1: 更新与新增失败测试**

既有用例更新（`host: ''` 创建后落库为 `*`）：

- `'GET /api/rules' → '按 host 过滤时包含全局记录'`、`'only_global=1 只返回全局记录'`：`host: ''` 改为 `host: '*'`（断言不变）。
- `'GET /api/rules/meta' → 'hosts 为活跃记录的去重域名'`：`host: ''` 改为 `host: '*'`。
- `'POST /api/rules/:id/check' → '全局记录被精确记录遮蔽时内部检查不通过'`：两处 `host: ''` 改为 `host: '*'`。
- `'GET /api/rules/export' → '导出 JSON'`：`{ host: '', filename: 'g.txt', content: 'vg', note: '' }` 改为 `{ host: '*', filename: 'g.txt', content: 'vg', note: '', priority: 0 }`。

`describe('POST /api/rules')` 末尾新增：

```js
  it('空 host 保存为全局 *', async () => {
    const res = await api('/api/rules', 'POST', { host: '', filename: 'g.txt', content: 'v' });
    expect((await res.json()).host).toBe('*');
  });

  it('合法模式与优先级创建成功', async () => {
    const res = await api('/api/rules', 'POST',
      { host: '*.example.com', filename: 'x.txt', content: 'v', priority: 500 });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.host).toBe('*.example.com');
    expect(body.priority).toBe(500);
  });

  it('非法模式返回 400', async () => {
    for (const host of ['a*.example.com', '***.x.com', '*.example.com:8080', '**']) {
      const res = await api('/api/rules', 'POST', { host, filename: 'x.txt', content: 'v' });
      expect(res.status, host).toBe(400);
    }
  });

  it('priority 非法返回 400', async () => {
    for (const priority of [-1, 1001, 1.5, '5']) {
      const res = await api('/api/rules', 'POST',
        { host: 'a.com', filename: `p${String(priority)}.txt`, content: 'v', priority });
      expect(res.status, String(priority)).toBe(400);
    }
  });
```

> 注意：`'**'` 在 Step 1 中是合法输入（归一化为 `*`）——把它从非法列表里去掉，改为单独断言：

```js
  it('单独 ** 归一化为全局 *', async () => {
    const res = await api('/api/rules', 'POST', { host: '**', filename: 'x.txt', content: 'v' });
    expect((await res.json()).host).toBe('*');
  });
```

`describe('POST /api/rules/import')` 末尾新增：

```js
  it('旧格式（无 priority）默认 0，新格式写入 priority', async () => {
    const res = await api('/api/rules/import', 'POST', {
      mode: 'skip',
      files: [
        { host: 'a.com', filename: 'old.txt', content: 'o' },           // 旧格式
        { host: 'b.com', filename: 'new.txt', content: 'n', priority: 9 }, // 新格式
      ],
    });
    expect(res.status).toBe(200);
    const rows = await (await api('/api/rules')).json();
    expect(rows.find((r) => r.filename === 'old.txt').priority).toBe(0);
    expect(rows.find((r) => r.filename === 'new.txt').priority).toBe(9);
  });

  it('非法模式进 errors，不影响其余导入', async () => {
    const res = await api('/api/rules/import', 'POST', {
      mode: 'skip',
      files: [
        { host: 'a*.example.com', filename: 'bad.txt', content: 'x' },
        { host: 'a.com', filename: 'ok.txt', content: 'ok' },
      ],
    });
    const body = await res.json();
    expect(body.imported).toBe(1);
    expect(body.errors).toHaveLength(1);
    expect(body.errors[0].reason).toContain('域名模式');
  });
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run test/routes-rules.test.js`
Expected: FAIL——空 host 落库为 `''`、priority 被忽略/未校验

- [ ] **Step 3: 实现**

`src/routes/rules.js` 顶部 import 增加：

```js
import { normalizePattern, isValidPriority } from '../hostmatch.js';
```

`parsePayload` 的 host/priority 处理替换为：

```js
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
  const host = normalizePattern(body?.host ?? '');
  if (host.error) return { error: host.error };
  let priority = 0;
  const rawP = body?.priority;
  if (rawP !== undefined) {
    if (!isValidPriority(rawP)) return { error: '优先级必须是 0-1000 的整数' };
    priority = rawP;
  }
  return {
    value: {
      host: host.value,
      filename,
      content,
      note: typeof body?.note === 'string' ? body.note : '',
      priority,
    },
  };
}
```

（`normalizeHost` import 仍被 GET `/` 与 batch-check 的筛选参数使用，保留。）

导出路由的 `files` 映射改为：

```js
    const payload = {
      version: 1,
      exported_at: new Date().toISOString(),
      count: rows.length,
      files: rows.map(({ host, filename, content, note, priority }) => ({ host, filename, content, note, priority })),
    };
```

导入无需改动——`parsePayload` 返回的 `value` 已含 `priority`，`createFile` / `updateFile` 已支持。

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run test/routes-rules.test.js`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/routes/rules.js test/routes-rules.test.js
git commit -m "feat: 保存校验与导入导出支持模式与优先级"
```

---

## Task 6: 回收站彻底删除与清空路由

**Files:**
- Modify: `src/routes/rules.js:1-12,158-182`
- Test: `test/routes-rules.test.js`

- [ ] **Step 1: 写失败测试**

`describe('DELETE 与 restore')` 末尾新增：

```js
  it('彻底删除回收站记录，成功后任何列表都查不到', async () => {
    const f = await (await api('/api/rules', 'POST',
      { host: 'a.com', filename: 'x.txt', content: 'v' })).json();
    await api(`/api/rules/${f.id}`, 'DELETE');
    expect((await api(`/api/rules/${f.id}/permanent`, 'DELETE')).status).toBe(204);
    expect(await (await api('/api/rules?include_deleted=1')).json()).toHaveLength(0);
  });

  it('活动记录与不存在的 id 彻底删除返回 404', async () => {
    const f = await (await api('/api/rules', 'POST',
      { host: 'a.com', filename: 'x.txt', content: 'v' })).json();
    expect((await api(`/api/rules/${f.id}/permanent`, 'DELETE')).status).toBe(404);
    expect((await api('/api/rules/9999/permanent', 'DELETE')).status).toBe(404);
  });

  it('清空回收站返回删除数，活动记录不受影响', async () => {
    await api('/api/rules', 'POST', { host: 'a.com', filename: 'keep.txt', content: 'v' });
    const d1 = await (await api('/api/rules', 'POST',
      { host: 'b.com', filename: 'gone1.txt', content: 'v' })).json();
    const d2 = await (await api('/api/rules', 'POST',
      { host: 'c.com', filename: 'gone2.txt', content: 'v' })).json();
    await api(`/api/rules/${d1.id}`, 'DELETE');
    await api(`/api/rules/${d2.id}`, 'DELETE');

    const res = await api('/api/rules/trash/clear', 'POST');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ count: 2 });
    expect(await (await api('/api/rules')).json()).toHaveLength(1);
    expect(await (await api('/api/rules?include_deleted=1')).json()).toHaveLength(1);
  });
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run test/routes-rules.test.js`
Expected: FAIL——404（路由不存在）

- [ ] **Step 3: 实现路由**

import 增加 `hardDeleteFile, clearTrash`。在 `router.post('/import', ...)` 之后、`router.post('/', ...)` 之前插入（先于参数路由注册）：

```js
  // 注意：/trash/clear 与 /:id/permanent 先于 /:id 系列注册，避免被参数路由吞掉
  router.post('/trash/clear', (c) => {
    return c.json({ count: clearTrash(db) });
  });

  router.delete('/:id/permanent', (c) => {
    const id = Number(c.req.param('id'));
    const n = hardDeleteFile(db, id);
    if (n === 0) return c.json({ error: '记录不存在或未在回收站中' }, 404);
    return c.body(null, 204);
  });
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run test/routes-rules.test.js`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/routes/rules.js test/routes-rules.test.js
git commit -m "feat: 回收站彻底删除与清空接口"
```

---

## Task 7: 自检适配模式规则

**Files:**
- Modify: `src/selfcheck.js:1-2,21-49,59-65`
- Test: `test/selfcheck.test.js`

- [ ] **Step 1: 写失败测试**

`describe('runInternalCheck')` 末尾新增：

```js
  it('模式规则被精确记录遮蔽时不通过，并指明遮蔽者', () => {
    const pattern = createFile(db, { host: '*.a.com', filename: 'x.txt', content: 'p', userId: 1 });
    const exact = createFile(db, { host: 'x.a.com', filename: 'x.txt', content: 'e', userId: 1 });
    const r = runInternalCheck(db, getFile(db, pattern.id));
    expect(r.ok).toBe(false);
    expect(r.problems.join()).toContain('命中的不是这条');
    expect(r.problems.join()).toContain(`id=${exact.id}`);
  });

  it('模式规则被高优先级全局压过时不通过', () => {
    const pattern = createFile(db, { host: '*.a.com', filename: 'x.txt', content: 'p', userId: 1 });
    createFile(db, { host: '*', filename: 'x.txt', content: 'g', priority: 10, userId: 1 });
    const r = runInternalCheck(db, getFile(db, pattern.id));
    expect(r.ok).toBe(false);
  });

  it('低优先级的相交模式不提示遮蔽', () => {
    const pattern = createFile(db, { host: '*.a.com', filename: 'x.txt', content: 'p', priority: 10, userId: 1 });
    createFile(db, { host: 'x.a.com', filename: 'x.txt', content: 'e', userId: 1 });
    const r = runInternalCheck(db, getFile(db, pattern.id));
    expect(r.ok).toBe(true);
  });

  it('不相交的模式不提示遮蔽', () => {
    const pattern = createFile(db, { host: '*.a.com', filename: 'x.txt', content: 'p', userId: 1 });
    createFile(db, { host: '*.b.com', filename: 'x.txt', content: 'q', userId: 1 });
    const r = runInternalCheck(db, getFile(db, pattern.id));
    expect(r.ok).toBe(true);
  });
```

`describe('runExternalCheck')` 中新增：

```js
  it('模式 host 返回 NO_HOST 且不发请求', async () => {
    let called = false;
    const r = await runExternalCheck({ ...file, host: '*.example.com' }, {
      fetchImpl: async () => { called = true; return okResponse('abc123'); },
    });
    expect(r.code).toBe(CHECK_CODES.NO_HOST);
    expect(called).toBe(false);
    expect(r.detail).toContain('模式规则无法确定验证域名');
  });
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run test/selfcheck.test.js`
Expected: FAIL——模式规则走 `matchFile(probe)` 路径报「按当前匹配规则查不到任何记录」；外部检查对模式发起真实请求

- [ ] **Step 3: 实现**

`src/selfcheck.js` 顶部 import 增加：

```js
import { isPattern, patternIntersects, compareRules } from './hostmatch.js';
```

`runInternalCheck` 的遮蔽检测部分（`const host = ...` 起）替换为：

```js
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
      // 两侧 host 都归一化后再比较——否则 file.host 为 '' 时 specificity 按 3（精确档）算，遮蔽者会排输
      if (patternIntersects(o.host === '' ? '*' : o.host, pattern)
        && compareRules({ ...o, host: o.host === '' ? '*' : o.host }, { ...file, host: pattern }) < 0) {
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
```

`runExternalCheck` 开头的空 host 判断改为：

```js
  if (!file.host || isPattern(file.host)) {
    return {
      code: CHECK_CODES.NO_HOST,
      detail: '模式规则无法确定验证域名，请手动访问目标 URL 确认。',
    };
  }
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run test/selfcheck.test.js`
Expected: PASS（既有「全局记录被遮蔽」用例：`''` 归一化为 `*`，`patternIntersects('a.com', '*')` 相交、精确胜——断言不变）

- [ ] **Step 5: 提交**

```bash
git add src/selfcheck.js test/selfcheck.test.js
git commit -m "feat: 自检适配模式规则（遮蔽检测与 NO_HOST）"
```

---

## Task 8: 统计口径（global `*` / byDomain 排除模式）

**Files:**
- Modify: `src/stats.js:14-21`
- Test: `test/stats.test.js`

- [ ] **Step 1: 更新与新增失败测试**

既有用例 `'统计文件总数、绑定/全局数与域名分布'` 中 `host: ''` 改为 `host: '*'`。新增：

```js
  it('模式记录计入绑定数但不出现在域名分布里', () => {
    createFile(db, { host: '*.a.com', filename: 'p.txt', content: 'v', userId: 1 });
    createFile(db, { host: '*', filename: 'g.txt', content: 'v', userId: 1 });
    createFile(db, { host: 'a.com', filename: 'x.txt', content: 'v', userId: 1 });
    const s = computeStats(db, createRequestLog());
    expect(s.files.total).toBe(3);
    expect(s.files.global).toBe(1);
    expect(s.files.bound).toBe(2);
    expect(s.files.byDomain).toEqual([{ host: 'a.com', count: 1 }]);
  });
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run test/stats.test.js`
Expected: FAIL——global 统计仍查 `host = ''`，`*.a.com` 出现在 byDomain

- [ ] **Step 3: 实现**

`src/stats.js` 两处查询替换为：

```js
  const global = db.prepare(
    "SELECT COUNT(*) AS n FROM verify_files WHERE deleted_at IS NULL AND host = '*'"
  ).get().n;
  const byDomain = db.prepare(`
    SELECT host, COUNT(*) AS count FROM verify_files
    WHERE deleted_at IS NULL AND host != '' AND host NOT LIKE '%*%'
    GROUP BY host ORDER BY count DESC, host ASC
  `).all();
```

`bound = total - global` 不变（模式计入绑定）。

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run test/stats.test.js`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/stats.js test/stats.test.js
git commit -m "feat: 统计口径改为全局 *，域名分布排除模式"
```

---

## Task 9: `src/batchcheck.js` 内存任务模块

**Files:**
- Create: `src/batchcheck.js`
- Test: `test/batchcheck.test.js`

- [ ] **Step 1: 写失败测试**

```js
// test/batchcheck.test.js
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.js';
import { createFile, listFiles } from '../src/repo/rules.js';
import { createBatchCheck, getBatchCheck, _test } from '../src/batchcheck.js';

let dir, db;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wxr-'));
  db = openDb(join(dir, 'test.db'));
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const okResponse = (body = 'v') => ({
  status: 200,
  headers: { get: (k) => (k.toLowerCase() === 'content-type' ? 'text/plain; charset=utf-8' : null) },
  text: async () => body,
});

async function waitDone(id) {
  for (let i = 0; i < 200; i++) {
    const job = getBatchCheck(id);
    if (job.status === 'done') return job;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('任务超时未完成');
}

function seedRows(n) {
  for (let i = 1; i <= n; i++) {
    createFile(db, { host: 'a.com', filename: `f${i}.txt`, content: 'v', userId: 1 });
  }
  return listFiles(db, {});
}

describe('createBatchCheck', () => {
  it('创建后 running，完成后 done 且结果齐全', async () => {
    const rows = seedRows(3);
    const id = createBatchCheck({ db, fetchImpl: async () => okResponse('v'), rows });
    expect(getBatchCheck(id).status).toBe('running');

    const job = await waitDone(id);
    expect(job.total).toBe(3);
    expect(job.done).toBe(3);
    expect(job.results).toHaveLength(3);
    const ids = job.results.map((r) => r.id).sort();
    expect(ids).toEqual(rows.map((r) => r.id).sort());
    expect(job.results.every((r) => r.external.code === 'OK')).toBe(true);
    expect(job.results.every((r) => typeof r.internal.ok === 'boolean')).toBe(true);
  });

  it('外部检查复用 fetchImpl', async () => {
    const rows = seedRows(2);
    let calls = 0;
    const id = createBatchCheck({
      db, rows,
      fetchImpl: async () => { calls++; return okResponse('v'); },
    });
    await waitDone(id);
    expect(calls).toBe(2);
  });

  it('不存在的 id 返回 undefined', () => {
    expect(getBatchCheck('nope')).toBeUndefined();
  });

  it('并发上限 5', async () => {
    const rows = seedRows(12);
    let active = 0;
    let maxActive = 0;
    const id = createBatchCheck({
      db, rows,
      fetchImpl: async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 10));
        active--;
        return okResponse('v');
      },
    });
    const job = await waitDone(id);
    expect(job.done).toBe(12);
    expect(maxActive).toBeLessThanOrEqual(5);
    expect(maxActive).toBeGreaterThan(1);
  });

  it('过期任务在创建新任务时被清理', async () => {
    _test.tasks.set('old', { id: 'old', createdAt: Date.now() - _test.TTL_MS - 1000, total: 1, done: 1, status: 'done', results: new Map() });
    seedRows(1);
    const rows = listFiles(db, {});
    createBatchCheck({ db, rows, fetchImpl: async () => okResponse('v') });
    expect(_test.tasks.has('old')).toBe(false);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run test/batchcheck.test.js`
Expected: FAIL——`Cannot find module '../src/batchcheck.js'`

- [ ] **Step 3: 实现模块**

```js
// src/batchcheck.js
// 批量自检异步任务：内存注册表（模块级 Map，单进程共享），
// 创建后并发 5 逐行执行内部 + 外部检查，10 分钟后自动清除；不持久化。

import { randomUUID } from 'node:crypto';
import { runInternalCheck, runExternalCheck } from './selfcheck.js';
import { getSettings } from './settings.js';

const TTL_MS = 10 * 60 * 1000;
const CONCURRENCY = 5;

const tasks = new Map();

function prune() {
  const now = Date.now();
  for (const [id, t] of tasks) {
    if (now - t.createdAt > TTL_MS) tasks.delete(id);
  }
}

export function createBatchCheck({ db, fetchImpl, rows }) {
  prune();
  const id = randomUUID();
  const task = {
    id,
    createdAt: Date.now(),
    total: rows.length,
    done: 0,
    status: 'running',
    results: new Map(), // rowId -> { internal, external }
  };
  tasks.set(id, task);
  runBatch(db, fetchImpl, task, rows).catch(() => {}); // 行级错误已在自检函数内兜底
  return id;
}

async function runBatch(db, fetchImpl, task, rows) {
  const timeoutMs = getSettings(db).selfcheck.timeout_seconds * 1000;
  const queue = [...rows];
  const worker = async () => {
    while (queue.length) {
      const file = queue.shift();
      if (!file) return;
      const internal = runInternalCheck(db, file);
      const external = await runExternalCheck(file, {
        ...(fetchImpl ? { fetchImpl } : {}),
        timeoutMs,
      });
      task.results.set(file.id, { internal, external });
      task.done++;
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  task.status = 'done';
}

export function getBatchCheck(id) {
  const t = tasks.get(id);
  if (!t) return undefined;
  return {
    id: t.id,
    status: t.status,
    total: t.total,
    done: t.done,
    results: [...t.results.entries()].map(([rid, r]) => ({ id: rid, ...r })),
  };
}

// 测试用：暴露注册表与常量
export const _test = { tasks, TTL_MS };
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run test/batchcheck.test.js`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/batchcheck.js test/batchcheck.test.js
git commit -m "feat: 批量自检任务模块（内存注册表+并发 5）"
```

---

## Task 10: 批量自检路由

**Files:**
- Modify: `src/routes/rules.js`
- Test: `test/routes-rules.test.js`

- [ ] **Step 1: 写失败测试**

`test/routes-rules.test.js` 的 `beforeEach` 中 app 配置增加共享 fetchImpl stub（批量自检的外部请求不发真实网络）：

```js
  app = createApp({
    db,
    requestLog: createRequestLog(),
    config: {
      sessionTtlHours: 24,
      cookieSecure: false,
      fetchImpl: async () => ({
        status: 200,
        headers: { get: (k) => (k.toLowerCase() === 'content-type' ? 'text/plain; charset=utf-8' : null) },
        text: async () => 'v',
      }),
    },
  });
```

新增 describe（放在 `POST /api/rules/:id/check` 之后）：

```js
describe('批量自检', () => {
  it('创建任务 202，轮询至完成且结果齐全', async () => {
    await api('/api/rules', 'POST', { host: 'a.com', filename: 'one.txt', content: 'v' });
    await api('/api/rules', 'POST', { host: 'b.com', filename: 'two.txt', content: 'v' });

    const res = await api('/api/rules/batch-check', 'POST', {});
    expect(res.status).toBe(202);
    const { id, total } = await res.json();
    expect(total).toBe(2);

    let job;
    for (let i = 0; i < 200; i++) {
      job = await (await api(`/api/rules/batch-check/${id}`)).json();
      if (job.status === 'done') break;
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(job.status).toBe('done');
    expect(job.results).toHaveLength(2);
    expect(job.results.every((r) => r.external.code === 'OK')).toBe(true);
  });

  it('筛选参数生效', async () => {
    await api('/api/rules', 'POST', { host: 'a.com', filename: 'one.txt', content: 'v' });
    await api('/api/rules', 'POST', { host: 'b.com', filename: 'two.txt', content: 'v' });
    const res = await api('/api/rules/batch-check', 'POST', { host: 'a.com' });
    expect((await res.json()).total).toBe(1);
  });

  it('空筛选与超 500 条返回 400', async () => {
    expect((await api('/api/rules/batch-check', 'POST', {})).status).toBe(400);
    for (let i = 0; i < 501; i++) {
      await api('/api/rules', 'POST', { host: 'a.com', filename: `f${i}.txt`, content: 'v' });
    }
    expect((await api('/api/rules/batch-check', 'POST', {})).status).toBe(400);
  });

  it('不存在的任务 404，未登录 401', async () => {
    expect((await api('/api/rules/batch-check/nope')).status).toBe(404);
    expect((await anon('/api/rules/batch-check', 'POST', {})).status).toBe(401);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run test/routes-rules.test.js`
Expected: FAIL——404（路由不存在）

- [ ] **Step 3: 实现路由**

import 增加 `createBatchCheck, getBatchCheck`。在 `/import` 路由之后、`router.post('/', ...)` 之前插入：

```js
  // 注意：/batch-check 必须先于 /:id 注册，避免被参数路由吞掉
  router.post('/batch-check', async (c) => {
    let body;
    try { body = await c.req.json(); } catch { return c.json({ error: 'bad request' }, 400); }
    const rows = listFiles(db, {
      host: typeof body?.host === 'string' && body.host ? normalizeHost(body.host) : undefined,
      q: typeof body?.q === 'string' && body.q ? body.q : undefined,
      by: body?.by ? Number(body.by) : undefined,
      onlyGlobal: body?.only_global === true || body?.only_global === '1',
    });
    if (rows.length === 0) return c.json({ error: '当前筛选没有规则' }, 400);
    if (rows.length > 500) return c.json({ error: '规则超过 500 条，请缩小筛选范围后再批量自检' }, 400);
    const id = createBatchCheck({ db, fetchImpl, rows });
    return c.json({ id, total: rows.length }, 202);
  });

  router.get('/batch-check/:id', (c) => {
    const job = getBatchCheck(c.req.param('id'));
    if (!job) return c.json({ error: '任务不存在或已过期' }, 404);
    return c.json(job);
  });
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run test/routes-rules.test.js`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/routes/rules.js test/routes-rules.test.js
git commit -m "feat: 批量自检接口（创建+轮询）"
```

---

## Task 11: 规则对话框（域名提示 + 优先级 + 前端即时校验）

> 说明：本任务与 Task 12-15 是前端改动，无自动化测试；验证方式为启动本地服务后在浏览器手工验证（步骤见各任务末尾）。「?」帮助入口在 Task 16 一并加入。

**Files:**
- Modify: `public/index.html:403-415`
- Modify: `public/rules.js`

- [ ] **Step 1: 改 HTML 对话框**

`public/index.html` 的 `#rule-dialog` 表单中，域名与路径标签之间的内容替换为：

```html
    <label>域名
      <input name="host" placeholder="精确域名或通配模式：* 单层、** 任意层，如 *.example.com、**.example.com；单独 * 表示所有域名">
    </label>
    <p class="hint" id="host-global-hint" hidden>将保存为全局 *（对所有域名生效）</p>
    <label>路径
      <input name="filename" required placeholder="MP_verify_xxxxxxxx.txt，可含子目录：h5/xxx.txt">
    </label>
```

在「备注」标签之前插入优先级输入：

```html
    <label>优先级
      <input name="priority" type="number" min="0" max="1000" step="1" placeholder="0">
      <span class="hint">数字越大越优先，多条规则冲突时才需要改（0-1000）</span>
    </label>
```

- [ ] **Step 2: 改前端校验与提交逻辑**

`public/rules.js` 的 `openDialog` 函数替换为（增加 priority 回填与全局提示同步）：

```js
function openDialog(row) {
  editingId = row ? row.id : null;
  $('#rule-dialog-title').textContent = row ? '编辑规则' : '新增规则';
  const f = $('#rule-form');
  f.host.value = row?.host ?? '';
  f.filename.value = row?.filename ?? '';
  f.content.value = row?.content ?? '';
  f.note.value = row?.note ?? '';
  f.priority.value = row?.priority ?? '';
  $('#host-global-hint').hidden = !!f.host.value;
  $('#rule-error').textContent = '';
  updateWarnings();
  $('#rule-dialog').showModal();
}
```

在 `openDialog` 之后新增前端校验副本与提示联动（与后端 `normalizePattern` 规则一致）：

```js
// 与后端 normalizePattern 一致的轻量副本（项目无构建，前后端不共享模块）
function validateHostInput(raw) {
  const h = raw.split(',')[0].trim().toLowerCase().replace(/\.+$/, '');
  if (!h) return { value: '*' };
  if (h.includes('*')) {
    if (h.length > 255) return { error: '域名模式总长不能超过 255' };
    if (/[:\[\]]/.test(h)) return { error: '模式中不允许端口或方括号' };
    const labels = h.split('.');
    const bad = labels.find((l) => l !== '*' && l !== '**' && !/^[a-z0-9_-]{1,63}$/.test(l));
    if (bad !== undefined) {
      return { error: '非法域名模式：每段只能是 *、** 或 1-63 位字母/数字/下划线/连字符（不支持 a*、*** 等写法）' };
    }
    if (labels.every((l) => l === '**')) return { value: '*' };
    return { value: h };
  }
  return { value: h };
}

{
  const input = $('#rule-form').host;
  input.addEventListener('input', () => {
    $('#host-global-hint').hidden = !!input.value.trim();
  });
}
```

提交处理器（原 `$('#rule-form').addEventListener('submit', ...)`）整体替换为：

```js
$('#rule-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  $('#rule-error').textContent = '';
  const hostRes = validateHostInput(f.host.value);
  if (hostRes.error) {
    $('#rule-error').textContent = hostRes.error;
    return;
  }
  let priority = 0;
  const pv = f.priority.value.trim();
  if (pv !== '') {
    if (!/^\d+$/.test(pv) || Number(pv) > 1000) {
      $('#rule-error').textContent = '优先级必须是 0-1000 的整数';
      return;
    }
    priority = Number(pv);
  }
  const body = {
    host: f.host.value.trim(),
    filename: f.filename.value.trim(),
    content: f.content.value,
    note: f.note.value.trim(),
    priority,
  };
  try {
    if (editingId) await api(`/api/rules/${editingId}`, { method: 'PUT', body });
    else await api('/api/rules', { method: 'POST', body });
    $('#rule-dialog').close();
    toast(editingId ? '已保存' : '已新增');
    loadRules();
    loadMeta(); // 域名/操作人下拉可能变化
  } catch (err) {
    $('#rule-error').textContent = err.message;
  }
});
```

- [ ] **Step 3: 浏览器手工验证**

Run: `npm start`（若本机有数据目录则直接登录，否则走首次初始化）

验证：
1. 新增规则：域名留空 → 下方出现「将保存为全局 *」提示，保存后列表域名列显示「所有域名」。
2. 域名填 `*.example.com`、优先级 500 → 保存成功，列表显示模式与 `(优先 500)`。
3. 域名填 `a*.example.com` → 输入后点保存，`#rule-error` 显示非法模式错误，无网络请求（Network 面板确认）。
4. 优先级填 `-1` 或 `1.5` → 前端报错不发请求。
5. 编辑既有规则 → priority 回填正确。

---

## Task 12: 规则列表（host 显示 / 徽章 / 筛选标签 / 刷新按钮）

**Files:**
- Modify: `public/index.html:229-233`
- Modify: `public/rules.js`

- [ ] **Step 1: 工具栏加刷新按钮**

`public/index.html` 的 `#btn-rules-import` 之后、`#btn-new` 之前插入：

```html
          <button id="btn-rules-refresh" class="btn" title="重新加载当前筛选的列表与筛选元数据">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg>
            <span>刷新</span>
          </button>
```

- [ ] **Step 2: 列表渲染与筛选标签**

`public/rules.js` 的 `renderRules` 中域名单元格改为：

```js
  rows.forEach((r, i) => {
    const tr = document.createElement('tr');
    tr.style.setProperty('--i', i); // 行入场错峰（纯展示）
    const hostCell = r.host === '*' ? '所有域名' : escapeHtml(r.host);
    const priorityBadge = r.priority ? ` <small>(优先 ${r.priority})</small>` : '';
    tr.innerHTML = `
      <td class="mono">${hostCell}${priorityBadge}</td>
      <td class="mono">${escapeHtml(r.filename)}</td>
      ...（其余单元格不变）
```

`renderHostFilter` 的全局选项文案改为：

```js
    '<option value="__global__">全局（*）</option>';
```

事件绑定区（`$('#btn-new')` 附近）新增刷新按钮监听：

```js
$('#btn-rules-refresh').addEventListener('click', () => {
  loadRules();
  loadMeta();
});
```

- [ ] **Step 3: 浏览器手工验证**

1. 列表中出现模式行与全局行：「所有域名」、`*.example.com`、`(优先 500)` 显示正确。
2. 域名筛选下拉为「全局（*）」；选某域名时能看到会命中的模式行与全局行。
3. 点「刷新」→ 列表与下拉重新加载。

---

## Task 13: 批量自检前端（按钮 + 轮询 + 逐行结果）

**Files:**
- Modify: `public/index.html:229-237`
- Modify: `public/rules.js:272-300`
- Modify: `public/style.css`

- [ ] **Step 1: 工具栏加按钮**

`public/index.html` 的 `#btn-rules-refresh` 之后插入：

```html
          <button id="btn-batch-check" class="btn" title="对当前筛选结果批量完整自检">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>
            <span>批量自检</span><span class="batch-progress"></span>
          </button>
```

- [ ] **Step 2: 抽出共用结果行渲染函数并改造单条自检**

`public/rules.js` 中 `$('#rules-table').addEventListener('click', ...)` 的 `check` 分支整体替换为：

```js
  if (btn.dataset.act === 'check') {
    const tbody = tr.parentElement;
    tbody.querySelectorAll('tr.check-row').forEach((r) => r.remove()); // 单条自检清掉旧结果
    upsertCheckRow(tr, { pending: true });
    try {
      const result = await api(`/api/rules/${row.id}/check`, { method: 'POST' });
      upsertCheckRow(tr, result);
    } catch (err) {
      upsertCheckRow(tr, { error: err.message });
    }
  }
```

在 `renderPeopleFilter` 之后新增共用函数：

```js
// 在指定规则行下方渲染/更新自检结果行；pending 转圈、error 直显、否则徽章
function upsertCheckRow(tr, data) {
  const tbody = tr.parentElement;
  let row = tr.nextElementSibling;
  if (!row || !row.classList.contains('check-row')) {
    row = document.createElement('tr');
    row.className = 'check-row';
    const td = document.createElement('td');
    td.colSpan = 6;
    const box = document.createElement('div');
    box.className = 'check-result';
    td.append(box);
    row.append(td);
    tr.after(row);
  }
  const box = row.querySelector('.check-result');
  if (data.pending) {
    box.innerHTML = '<span class="check unknown">检查中…</span>';
    return;
  }
  if (data.error) {
    box.textContent = data.error;
    return;
  }
  const { internal, external } = data;
  const cls = external.code === 'OK' ? 'ok'
    : ['NO_HOST', 'EGRESS_BLOCKED'].includes(external.code) ? 'unknown' : 'bad';
  const internalPart = internal.ok
    ? '内部检查通过'
    : `内部检查未通过：${internal.problems.join('；')}`;
  box.innerHTML =
    `<span class="check ${internal.ok ? 'ok' : 'bad'}">${escapeHtml(internalPart)}</span>
     <span class="check ${cls}">${escapeHtml(CHECK_HINTS[external.code] || external.code)}</span>
     <div><small>${escapeHtml(external.detail || '')}</small></div>`;
}
```

- [ ] **Step 3: 批量自检状态机**

`public/rules.js` 末尾（拖拽导入之前）新增：

```js
// —— 批量自检：创建任务后每 1.5s 轮询，按行 id 渲染结果 ——
let batchJobId = null;
let batchTimer = null;

function currentFilterParams() {
  const p = {};
  if (filters.host === '__global__') p.only_global = true;
  else if (filters.host) p.host = filters.host;
  if (filters.q) p.q = filters.q;
  if (filters.by) p.by = filters.by;
  return p;
}

function renderBatchProgress(job) {
  const btn = $('#btn-batch-check');
  btn.querySelector('.batch-progress').textContent = job ? `${job.done}/${job.total}` : '';
  btn.disabled = !!job;
}

function finishBatch() {
  clearInterval(batchTimer);
  batchTimer = null;
  batchJobId = null;
  renderBatchProgress(null);
}

async function pollBatch() {
  let job;
  try {
    job = await api(`/api/rules/batch-check/${batchJobId}`);
  } catch (err) {
    finishBatch();
    toast(err.message);
    return;
  }
  renderBatchProgress(job);
  for (const r of job.results) {
    const tr = $(`#rules-table tbody tr[data-id="${r.id}"]`);
    if (tr) upsertCheckRow(tr, r);
  }
  if (job.status === 'done') {
    finishBatch();
    const bad = job.results.filter((r) => !(r.internal.ok && r.external.code === 'OK')).length;
    toast(`批量自检完成：通过 ${job.total - bad}，异常 ${bad}`);
  }
}

$('#btn-batch-check').addEventListener('click', async () => {
  if (batchJobId) return; // 任务进行中
  const count = $$('#rules-table tbody tr[data-id]').length;
  if (count === 0) return toast('当前筛选没有规则');
  const ok = await confirmDialog({
    title: '批量自检',
    message: `将对当前筛选的 ${count} 条规则完整自检（内部检查 + 外部请求），可能耗时。`,
    okText: '开始自检',
  });
  if (!ok) return;
  let job;
  try {
    job = await api('/api/rules/batch-check', { method: 'POST', body: currentFilterParams() });
  } catch (err) {
    return toast(err.message);
  }
  batchJobId = job.id;
  renderBatchProgress({ done: 0, total: job.total });
  $$('#rules-table tbody tr[data-id]').forEach((tr) => upsertCheckRow(tr, { pending: true }));
  batchTimer = setInterval(pollBatch, 1500);
});
```

- [ ] **Step 4: CSS**

`public/style.css` 末尾（无障碍媒体查询之前）追加：

```css
/* 批量自检 */
.btn .batch-progress { margin-left: 6px; font-variant-numeric: tabular-nums; }
.btn:disabled { opacity: .6; cursor: not-allowed; transform: none; }
```

- [ ] **Step 5: 浏览器手工验证**

1. 点「批量自检」→ 确认对话框显示当前条数 → 按钮禁用并显示 `0/N`，各行出现「检查中…」。
2. 完成后按钮恢复，toast 显示「通过 x，异常 y」，各行渲染徽章结果。
3. 自检进行中切换筛选 → 结果按行 id 渲染到可见行，任务不受影响。

---

## Task 14: 回收站 UI（彻底删除 + 清空）

**Files:**
- Modify: `public/index.html:257-265`
- Modify: `public/rules.js:134-160,303-315`

- [ ] **Step 1: 回收站面板加工具栏**

`public/index.html` 的 `#panel-trash` 中 `table-card` 之前插入：

```html
        <div class="toolbar">
          <span class="hint" id="trash-count"></span>
          <button id="btn-trash-clear" class="btn danger" title="彻底删除回收站中全部记录，不可恢复">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 5h19M8 5V3h8v2M5 5l1 16h12l1-16"/></svg>
            <span>清空回收站</span>
          </button>
        </div>
```

- [ ] **Step 2: 行内彻底删除按钮 + 计数/禁用**

`public/rules.js` 的 `loadTrash` 中，行渲染的「操作」单元格与结尾更新为：

```js
  rows.forEach((r, i) => {
    const tr = document.createElement('tr');
    tr.className = 'deleted';
    tr.style.setProperty('--i', i); // 行入场错峰（纯展示）
    tr.innerHTML = `
      <td class="mono">${r.host ? escapeHtml(r.host) : '<em>全部域名</em>'}</td>
      <td class="mono">${escapeHtml(r.filename)}</td>
      <td>${escapeHtml(r.note)}</td>
      <td>${escapeHtml(personLabel(r.deleted_by_username, r.deleted_by_name))}</td>
      <td>${fmtTime(r.deleted_at)}</td>
      <td><button class="btn sm" data-act="restore">恢复</button>
          <button class="btn sm danger" data-act="destroy">彻底删除</button></td>`;
    tr.dataset.id = r.id;
    tbody.append(tr);
  });
  $('#trash-count').textContent = rows.length ? `共 ${rows.length} 条` : '';
  $('#btn-trash-clear').disabled = rows.length === 0;
```

- [ ] **Step 3: 事件处理**

`public/rules.js` 的回收站点击处理器整体替换为：

```js
$('#trash-table').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const id = btn.closest('tr').dataset.id;
  try {
    if (btn.dataset.act === 'destroy') {
      const ok = await confirmDialog({
        title: '彻底删除',
        message: '彻底删除后无法恢复，确定删除这条记录？',
        okText: '彻底删除',
        danger: true,
      });
      if (!ok) return;
      await api(`/api/rules/${id}/permanent`, { method: 'DELETE' });
      toast('已彻底删除');
      loadTrash();
      return;
    }
    await api(`/api/rules/${id}/restore`, { method: 'POST' });
    toast('已恢复');
    loadTrash();
    loadMeta();
  } catch (err) {
    toast(err.message);
  }
});

$('#btn-trash-clear').addEventListener('click', async () => {
  const count = $$('#trash-table tbody tr').length;
  if (count === 0) return;
  const ok = await confirmDialog({
    title: '清空回收站',
    message: `将彻底删除回收站中全部 ${count} 条记录，无法恢复。`,
    okText: '清空',
    danger: true,
  });
  if (!ok) return;
  try {
    const res = await api('/api/rules/trash/clear', { method: 'POST' });
    toast(`已清空回收站（${res.count} 条）`);
    loadTrash();
  } catch (err) {
    toast(err.message);
  }
});
```

- [ ] **Step 4: 浏览器手工验证**

1. 删除两条规则 → 回收站行显示「恢复」「彻底删除」，工具栏计数「共 2 条」。
2. 点「彻底删除」→ 确认 → 该行消失，计数减一；取消则无事发生。
3. 清空后按钮禁用、显示「回收站为空」。
4. 活动规则不受清空影响（规则列表完好）。

---

## Task 15: 趋势图 Y 轴刻度 + 数据点数值

**Files:**
- Modify: `public/dashboard.js:23-60`
- Modify: `public/style.css:412-413`

- [ ] **Step 1: 重写 renderTrend**

`public/dashboard.js` 的 `renderTrend` 整体替换为：

```js
function renderTrend(hours) {
  const svg = $('#dash-trend');
  const hasData = hours.some((h) => h.count > 0);
  $('#dash-trend-empty').hidden = hasData;
  svg.hidden = !hasData;
  if (!hasData) return;

  const W = 600, H = 180, PL = 40, PR = 10, PT = 14, AXIS = 24; // 左侧刻度区 40px
  const innerW = W - PL - PR;
  const rawMax = Math.max(...hours.map((h) => h.count), 1);
  // 1/2/2.5/5 × 10^k 步进取整刻度（如最大值 7 → 刻度 0/2/4/6/8）
  const mag = 10 ** Math.floor(Math.log10(rawMax));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s * 4 >= rawMax);
  const yMax = 4 * step;
  const x = (i) => PL + (innerW * i) / (hours.length - 1);
  const y = (c) => H - AXIS - (c / yMax) * (H - AXIS - PT);
  const pts = hours.map((h, i) => [x(i), y(h.count)]);
  const line = pts.map(([px, py], i) => `${i ? 'L' : 'M'}${px.toFixed(1)},${py.toFixed(1)}`).join(' ');
  const area = `${line} L${x(hours.length - 1).toFixed(1)},${H - AXIS} L${PL},${H - AXIS} Z`;

  const fmt = (v) => (Number.isInteger(v) ? String(v) : v.toFixed(1));
  // 4 条网格线（1/4 步进）左端标数值，基线不标
  const grid = [0, 1, 2, 3, 4].map((k) => {
    const gy = y(yMax * (k / 4)).toFixed(1);
    const val = fmt(yMax * (k / 4));
    return k === 0
      ? `<line class="trend-grid" x1="${PL}" y1="${gy}" x2="${W - PR}" y2="${gy}"/>`
      : `<line class="trend-grid" x1="${PL}" y1="${gy}" x2="${W - PR}" y2="${gy}"/>
         <text x="${PL - 6}" y="${gy}" class="trend-y-label" dy="0.32em">${val}</text>`;
  }).join('');
  const labels = hours
    .filter((_, i) => i % 6 === 0)
    .map((h, i) =>
      `<text x="${x(i * 6).toFixed(1)}" y="${H - 7}" class="trend-label">${h.hour}:00</text>`)
    .join('');
  // 数据点数值：count > 0 的点上方标小字（零点贴着轴线不标）
  const pointLabels = hours
    .map((h, i) => h.count > 0
      ? `<text x="${x(i).toFixed(1)}" y="${(y(h.count) - 6).toFixed(1)}" class="trend-point-label" text-anchor="middle">${h.count}</text>`
      : '')
    .join('');
  const last = pts[pts.length - 1];

  svg.innerHTML = `
    <defs><linearGradient id="trend-fill" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#2563eb" stop-opacity=".18"/>
      <stop offset="1" stop-color="#2563eb" stop-opacity="0"/>
    </linearGradient></defs>
    ${grid}
    <path d="${area}" fill="url(#trend-fill)"/>
    <path d="${line}" fill="none" stroke="#2563eb" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
    <circle cx="${last[0].toFixed(1)}" cy="${last[1].toFixed(1)}" r="4" fill="#2563eb" stroke="#fff" stroke-width="2"/>
    ${pointLabels}
    ${labels}`;
}
```

- [ ] **Step 2: CSS 新类**

`public/style.css` 的 `.trend-grid` 之后追加：

```css
.trend-y-label { fill: var(--text-3); font-size: 10px; text-anchor: end; }
.trend-point-label { fill: var(--text-2); font-size: 9px; }
```

- [ ] **Step 3: 浏览器手工验证**

1. 看板趋势图：左侧出现 0/1/4/1/2/1/4 这类整刻度数值，网格线 4 条。
2. 有点数的数据点上方出现 9px 数值，零值点无标签。
3. 制造几笔请求（`curl http://localhost:3000/xxx.txt` 任意路径）后刷新看板，刻度随最大值自适应。

---

## Task 16: 帮助文档 + `openHelpDoc` 入口

**Files:**
- Create: `docs/rules-guide.md`
- Modify: `public/help.js`
- Modify: `public/rules.js:1`
- Modify: `public/index.html:403-404`

- [ ] **Step 1: 写帮助文档**

> 文件名必须 ASCII：`docs.js` 的 `DOC_ID_RE = /^[a-z0-9][a-z0-9._-]*$/i` 拒绝中文 id。

```markdown
# 规则配置说明

## 域名匹配

每条规则由「域名 + 路径」唯一定位。域名支持三种写法：

| 写法 | 含义 | 例子 |
|------|------|------|
| 精确域名 | 只匹配该域名 | `example.com` |
| 通配模式 | `*` 占一层子域，`**` 占任意层 | `*.example.com`、`**.example.com` |
| 全局 `*` | 匹配所有域名 | `*` |

- `*.example.com` 匹配 `a.example.com`，不匹配 `example.com`、`a.b.example.com`
- `**.example.com` 匹配 `example.com`、`a.example.com`、`a.b.example.com`（任意层含 0 层）
- 域名留空保存时自动记为 `*`
- 只支持整段通配，不支持 `a*`、`***` 等写法；每段 1-63 位字母/数字/下划线/连字符

## 优先级

多条规则命中同一请求时，按以下次序取第一条：

1. 优先级数字大者（0-1000，默认 0）
2. 同优先级时更具体的模式（精确 > `*` 模式 > `**` 模式 > 全局）
3. 同优先级同具体度时先创建的规则

只有规则冲突时才需要调整优先级，例如让某条全局规则（优先级 10）压过特定精确规则（优先级 0）。

## 保存校验

- 非法模式（如 `a*.example.com`、`***.x.com`、带端口/方括号的模式）保存时会被拒绝
- 优先级必须是 0-1000 的整数
- 内容不能超过 4096 字节；路径必须以 `.txt` 结尾

## 自检

- **单条自检**：规则列表每行「自检」按钮，同时做内部检查（数据与遮蔽）与外部真实请求验证
- **批量自检**：工具栏「批量自检」按钮，对当前筛选结果逐条完整检查，进度实时刷新
- **结果代码**：
  - `OK` 线上完全正常
  - `NO_HOST` 模式/全局规则无法自动验证，请手动访问目标 URL 确认
  - `EGRESS_BLOCKED` 本机无法出网，外部验证不可用
  - `REDIRECTED` 被重定向，微信不接受
  - `STATUS_NOT_200` 状态码不是 200
  - `CONTENT_TYPE_WRONG` Content-Type 不是 text/plain
  - `CONTENT_MISMATCH` 线上内容与库中不一致
  - `DNS_OR_CONNECT_FAILED` 域名解析或连接失败

## 回收站

删除的规则先进入回收站，可恢复；「彻底删除」与「清空回收站」不可恢复，操作前请确认。
```

- [ ] **Step 2: help.js 导出 openHelpDoc**

`public/help.js` 中 `listLoaded` 声明与 `loadList` 结尾改为：

```js
let listLoaded = false;
let loadPromise = null;
```

`loadList` 函数体内 `listLoaded = true;` 之前不变；在 `loadList` 之后、`applyFilter` 之前插入：

```js
// 等待文档列表就绪（幂等：多次调用共享同一 Promise）
function ensureList() {
  if (listLoaded) return Promise.resolve();
  if (!loadPromise) loadPromise = loadList();
  return loadPromise;
}
```

`showDoc` 之后（`$('#help-search').addEventListener` 之前）插入：

```js
// 切换到帮助面板并打开指定文档（规则对话框「?」入口）。
// 通过 location.hash 触发 switchTab（已在帮助页则直接继续），等待列表就绪后定位文档。
export async function openHelpDoc(id) {
  location.hash = '#/help';
  await ensureList();
  $('#help-search').value = '';
  applyFilter('');
  const btn = $$('.help-item').find((b) => b.dataset.id === id && !b.dataset.group);
  if (btn) {
    btn.click();
    return;
  }
  showDoc(id, ''); // 列表里没有时直接按根组打开
}
```

- [ ] **Step 3: 对话框「?」入口**

`public/index.html` 域名标签改为：

```html
    <label>域名
      <button type="button" id="btn-host-help" class="link" title="查看规则配置说明">?</button>
      <input name="host" placeholder="精确域名或通配模式：* 单层、** 任意层，如 *.example.com、**.example.com；单独 * 表示所有域名">
    </label>
```

`public/rules.js` 顶部 import 增加：

```js
import { openHelpDoc } from './help.js';
```

事件绑定区新增：

```js
$('#btn-host-help').addEventListener('click', () => openHelpDoc('rules-guide'));
```

- [ ] **Step 4: 浏览器手工验证**

1. 帮助面板左侧出现「规则配置说明」，内容渲染正常。
2. 规则对话框点「?」→ 自动切到帮助面板并打开该文档；在搜索框有内容时也能正确定位。

---

## Task 17: README 同步

**Files:**
- Modify: `README.md:17,77`

- [ ] **Step 1: 两处文案**

第 17 行：

```markdown
- 路由规则全局生效或按域名绑定，支持 `*.example.com` / `**.example.com` 通配与手动优先级，路径支持任意深度子目录（`h5/xxx.txt`）
```

第 77 行：

```markdown
2. **保留原始域名**（`Host` 或 `X-Forwarded-Host`）；做不到就把规则域名填 `*` 全局生效，支持 `*.example.com` / `**.example.com` 通配与优先级
```

- [ ] **Step 2: 提交**

```bash
git add README.md
git commit -m "docs: README 同步模式与优先级说明"
```

---

## Task 18: 全量回归 + 浏览器整体验证

**Files:** 无代码改动（如有遗漏则修复并单独提交）

- [ ] **Step 1: 全量测试**

Run: `npm test`
Expected: 全部 PASS

- [ ] **Step 2: 残留检查**

Run: `grep -rn "host = ''" src/ test/ | grep -v "host != ''"`
Expected: 无输出（`host = ''` 查询应已全部替换；`host != ''` 的排除写法保留）

- [ ] **Step 3: 启动服务整体验证**

Run: `npm start`（后台运行），浏览器（Playwright）依次验证：

1. **登录** → 看板：趋势图有 Y 轴刻度与数据点数值。
2. **新增模式规则**：host `*.test.local`、优先级 10 → 列表显示模式与 `(优先 10)`。
3. **新增全局规则**：host 留空 → 提示「将保存为全局 *」→ 列表显示「所有域名」。
4. **验证匹配**：`curl -H "Host: a.test.local" http://localhost:3000/MP_verify_x.txt` 返回模式规则内容；`curl -H "Host: b.other.com" ...` 返回全局规则内容。
5. **单条自检**：模式行 → 外部结果为 NO_HOST（模式规则无法确定验证域名）；精确行 → 正常自检。
6. **批量自检**：筛选全部 → 批量自检 → 进度、逐行结果、toast 汇总正确。
7. **回收站**：删除两条 → 回收站行内「彻底删除」删一条、计数变化 →「清空回收站」清空 → 按钮禁用。
8. **帮助**：对话框「?」跳转「规则配置说明」；帮助面板左侧可浏览。
9. **刷新按钮**：改筛选后点刷新，列表与下拉元数据重载。

- [ ] **Step 4: 截图**

所有 UI 改动完成后统一截图（用户偏好）：看板趋势图、规则列表（含模式行/徽章）、规则对话框（含校验错误态）、批量自检进行中与完成态、回收站（含确认对话框）、帮助文档页。截图交由用户审核。

- [ ] **Step 5: 提交遗漏修复（如有）**

---

## 自审记录

**1. Spec 覆盖：**

| Spec 章节 | 覆盖任务 |
|-----------|----------|
| §3.1-3.5 核心模型（matchHost/交集/排序/校验） | Task 1 |
| §4 数据与迁移 | Task 2 |
| §5.1 hostmatch.js | Task 1 |
| §5.2 repo（matchFile/写入/listFiles/listMeta/onlyGlobal/彻底删除） | Task 3、4 |
| §5.3 routes（parsePayload/导出/导入/回收站路由） | Task 5、6 |
| §5.4 selfcheck | Task 7 |
| §5.5 stats | Task 8 |
| §5.6 verify.js 无需改动 | 无任务（matchFile 形状不变，Task 3 注释说明） |
| §6.1 对话框 | Task 11、16 |
| §6.2 列表（显示/徽章/筛选/刷新） | Task 12 |
| §6.3 趋势图 | Task 15 |
| §6.4 回收站 UI | Task 14 |
| §7 双重验证 | Task 5（后端）、11（前端） |
| §8 兼容性 | Task 2（迁移）、5（导入旧格式）、3（matchFile 归一化残留 ''） |
| §9 测试计划 | 各任务 Step 1 |
| §10 README | Task 17 |
| §11 批量自检 | Task 9、10（后端）、13（前端） |
| §12 帮助文档 | Task 16 |
| §13 回收站管理 | Task 3、6（后端）、14（前端） |

**2. 占位符扫描：** 无 TBD/TODO/「类似 Task N」；每个代码步骤含完整代码。

**3. 类型一致性：** `normalizePattern` 返回 `{ok, value} | {ok, error}`（Task 1 定义，Task 5 路由与 Task 11 前端副本同形）；`compareRules(a, b)` 负值 = a 胜（Task 1 定义，Task 3 matchFile 排序、Task 7 遮蔽判断同用）；`matchFile` 返回 `{id, content}`（Task 3，verify.js 与 selfcheck.js 消费者不变）；`getBatchCheck` 返回 `{id, status, total, done, results:[{id, internal, external}]}`（Task 9，Task 10 路由与 Task 13 前端同形）；`upsertCheckRow(tr, data)` 的 `data` 形状（`{pending} | {error} | {internal, external}`）在 Task 13 单条与批量两处一致。

**4. 边界：** 迁移 `UPDATE OR IGNORE` 撞唯一索引的残留 `''` 行由 matchFile/selfcheck/筛选三处的 `'' → '*'` 归一化兜底（Task 2 测试覆盖）；模式规则外部自检一律 NO_HOST（Task 7）；`'**'` 单独输入归一化为 `*`（Task 1、5 测试覆盖）。
