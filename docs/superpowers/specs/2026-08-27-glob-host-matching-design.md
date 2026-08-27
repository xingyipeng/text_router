# wx_router — glob 域名匹配与手动优先级设计

**日期**：2026-08-27
**状态**：设计已确认，待实现

---

## 1. 背景与目标

现状：路由规则按「域名 + 文件名」匹配。域名支持两种取值——精确域名，或**留空**表示全局生效。问题：「留空 = 全局」是隐式约定，容易造成误区（用户不知道留空有特殊含义，或误以为空 = 无效）。

目标：

1. 用**显式 glob 模式**取代隐式留空：`*.example.com` 匹配单层子域、`**.example.com` 匹配任意层子域（含域名本身），`*` 表示全局。
2. 规则增加**手动优先级**参数，多条规则命中同一请求时由优先级决定胜负。
3. 保存时前后端双重校验，非法模式即时报错。
4. 附带：看板 24 小时趋势图增加 Y 轴刻度尺与数据点数值。
5. 规则列表支持对**当前筛选结果**一键批量完整自检（内部 + 外部），逐行展示结果。
6. 回收站支持**单条彻底删除**与**一键清空**。

## 2. 非目标（YAGNI）

- **不做裸正则**。只支持 `*` 整段标签通配，匹配用标签比较实现，不引入正则（无转义错误、无 ReDoS）。
- **`*` 与 `**` 之外不做其他通配**。`*` 单层、`**` 任意层（gitignore 惯例），不支持 `a*`、`***` 等半段/叠加写法。
- **不给列表页加优先级排序列**。优先级只在冲突时起作用，非 0 时在域名旁显示小标记。
- **不动域名分布环形图**。本次只改趋势图。

## 3. 核心模型

### 3.1 host 字段三种取值

| 取值 | 含义 | 例子 |
|------|------|------|
| 精确域名 | 只匹配该域名 | `example.com` |
| glob 模式 | `*` 占一个整段标签（单层）；`**` 占任意层（含 0 层） | `*.example.com`；`**.example.com` |
| 全局 | 兜底所有域名 | `*` |

`**.example.com` 匹配 `example.com` 本身及其任意层子域；`*.example.com` 只匹配单层子域。

### 3.2 匹配与优先级排序

同一 `filename` 的所有活跃规则中，命中请求 host 的按以下次序取第一条：

```
priority 数字大者 > 同优先级具体度高者（精确 > `*` 模式 > `**` 模式 > 全局） > 同优先级同具体度先建者（id 小）
```

- `priority` 是新字段：**整数，默认 0，越大越优先**，范围 0~1000。
- 全部用默认值时行为与现状一致（精确 > 全局），零惊讶。
- 想要例外时手动调数字，例如让 `*` 全局记录（priority 10）压过某条精确规则（priority 0）。

### 3.3 匹配实现：标签比较，不用正则

glob 只允许 `*` / `**` 作为整段标签，因此带回溯的标签比较即可表达全部语义（无正则、无 ReDoS）：

```
matchHost(pattern, host):
  pattern === '*'            → 命中所有（含空 host）
  标签游标递归匹配：
    p[i] === '**'  → 消费 0..n 个 host 标签（回溯尝试）
    p[i] === '*'   → 恰好消费 1 个 host 标签
    p[i] === h[j]  → 相等则各进 1
    其余           → 不命中
```

`*.example.com` 匹配 `www.example.com`、不匹配 `a.b.example.com`；`**.example.com` 匹配 `example.com`、`a.example.com`、`a.b.example.com`。

`matchFile` 从一条 SQL 改为「按 filename 索引查候选行 + JS 过滤排序取第一条」，规则行数量级下开销可忽略。返回形状不变（`{id, content}`），`verify.js` 无需改动。

### 3.4 模式校验规则（normalizePattern）

保存/导入时执行：

- 空字符串 → 归一化为 `*`
- 统一小写、去尾点、取逗号首段（与现有 `normalizeHost` 习惯一致）
- 含 `*` 时按模式校验：每段要么是 `*`、`**` 要么是 `[a-z0-9_-]{1,63}`（DNS 标签上限）；不允许端口、方括号、`a*`、`***` 这类半段/叠加通配；总长 ≤ 255；单独 `**` 归一化为 `*`
- 不含 `*` 走现有 `normalizeHost`（去端口/括号/尾点）

### 3.5 模式交集（供自检用）

两个模式存在共同可命中的域名，当且仅当标签游标 (i, j) 从 (0,0) BFS 可达终点：每步消费 1 个 host 标签——候选标签取「双方模式中出现的字面量 ∪ {一个不与任何字面量相等的占位标签}」；`*` 必须消费、`**` 可消费 0 或多个、字面量必须相等；能同时走完两个模式即相交。仅自检使用。

## 4. 数据与迁移

`verify_files` 表新增列：

```sql
ALTER TABLE verify_files ADD COLUMN priority INTEGER NOT NULL DEFAULT 0;
UPDATE verify_files SET host = '*' WHERE host = '';  -- 存量全局记录一次性转换
```

- 迁移在 `openDb` 中幂等执行：`SCHEMA`（新建库）直接含 `priority` 列；`PRAGMA table_info` 检测旧库缺列时执行 ALTER + UPDATE。
- 唯一索引 `idx_active_host_filename (host, filename)` 不变。
- 保存时空 host 自动归一化为 `*`，此后库里不再产生 `''`。

## 5. 各模块改动

### 5.1 新模块 `src/hostmatch.js`（纯函数）

| 函数 | 职责 |
|------|------|
| `matchHost(pattern, host)` | §3.3 标签比较 |
| `patternIntersects(a, b)` | §3.5 模式交集 |
| `compareRules(a, b)` | §3.2 排序比较器（priority → 具体度 → id） |
| `isPattern(host)` | 是否含 `*`（决定自检/统计口径） |
| `normalizePattern(raw)` | §3.4 校验 + 归一化，返回 `{ ok, value }` 或 `{ ok, error }` |
| `isValidPriority(v)` | 0~1000 整数 |

### 5.2 `src/repo/rules.js`

- `matchFile`：`SELECT id, host, content, priority FROM verify_files WHERE filename = ? AND deleted_at IS NULL` → JS 过滤 `matchHost` → `compareRules` 排序 → 取第一条。
- `createFile` / `updateFile`：写入 `priority`（默认 0）。
- `listFiles` 筛选升级为业务语义：选某域名时显示**该域名会命中的全部规则**——SQL 取 `host = ?` 与含 `*` 的行（`host LIKE '%*%'`），JS 按 `matchHost` 过滤。
- `listMeta.hosts` 只列精确域名（排除含 `*` 的行），模式不进下拉。
- `onlyGlobal` 语义改为 `host = '*'`。
- 新增 `hardDeleteFile(db, id)`：`DELETE FROM verify_files WHERE id = ? AND deleted_at IS NOT NULL`（仅回收站中的行可被彻底删除），返回删除数。
- 新增 `clearTrash(db)`：`DELETE FROM verify_files WHERE deleted_at IS NOT NULL`，返回删除数。

### 5.3 `src/routes/rules.js`

- `parsePayload`：host 走 `normalizePattern`，priority 走 `isValidPriority`，非法返回 400 中文错误；缺省 priority 补 0。
- 导出文件每条增加 `priority` 字段。
- 导入复用 `parsePayload` 校验；旧格式（无 priority）默认 0，向后兼容。
- 新增 `DELETE /:id/permanent`：彻底删除（不可恢复）。记录不存在或未在回收站（`deleted_at` 为空）返回 404，成功 204。
- 新增 `POST /trash/clear`：清空回收站，返回 `{count}`。两条路由注册在 `/:id` 之前。

### 5.4 `src/selfcheck.js`

- 外部验证：`isPattern(file.host)` → `NO_HOST`，文案改为「模式规则无法确定验证域名，请手动访问目标 URL 确认」。
- 内部遮蔽检测统一为新排序逻辑，与线上匹配同源：
  - 精确规则：`matchFile(db, host, filename)` 比对（现状不变）。
  - 模式/全局规则：扫描同 filename 的其他活跃行，凡「`patternIntersects` 非空 且 `compareRules` 赢过它」的列入遮蔽提示。

### 5.5 `src/stats.js`

- `global` 统计改为 `host = '*'`。
- `byDomain` 只计精确域名（排除含 `*` 的行）。
- `bound = total - global` 不变（模式计入绑定），看板文案无需改。

### 5.6 `src/verify.js`

无需改动（`matchFile` 返回形状不变，请求日志字段不变）。

## 6. UI 改动

### 6.1 规则对话框（`public/index.html` + `public/rules.js`）

- 域名输入框提示改为「精确域名或通配模式：`*` 单层、`**` 任意层，如 `*.example.com`、`**.example.com`；单独 `*` 表示所有域名」。
- 域名输入框旁增加「?」帮助链接：点击切换到帮助面板并打开「规则配置说明」文档（见 §12）。
- 新增「优先级」数字输入框，默认 0，提示「数字越大越优先，冲突时才需要改」。
- **提交前前端校验**（§7 双重验证）：同一套规则在 `public/rules.js` 写轻量副本（项目无构建、前后端不共享模块），错误显示在 `#rule-error`，不发请求；host 留空时提示「将保存为全局 *」。

### 6.2 规则列表（`public/rules.js`）

- host 列：`*` 显示为「所有域名」、模式与精确域名原样显示（不再有「全部域名」的斜体 em 特判）。
- 优先级非 0 时域名旁加小标记 `(优先 N)`。
- 筛选下拉：「全局（未指定域名）」改为「全局（*）」。
- 工具栏（与「新增」「批量自检」并排）新增「刷新」按钮：重新加载当前筛选的规则列表与筛选元数据（`loadRules` + `loadMeta`）。

### 6.3 看板趋势图（`public/dashboard.js` + `public/style.css`）

- **Y 轴刻度尺**：左侧预留 34px 标签区，按 `1/2/2.5/5 × 10^k` 步进取整刻度（如最大值 7 → 刻度 0/2/4/6/8），4 条网格线左端标数值；横轴时间标签（每 6 小时）不变。
- **数据点数值**：每个 count > 0 的点上方标 9px 小字数值；零点不标（贴着轴线会与时间标签打架）；末尾点圆点标记保留。
- 新增 CSS 类 `trend-y-label`、`trend-point-label`。

### 6.4 回收站（`public/index.html` + `public/rules.js`）

- 回收站面板增加工具栏：「清空回收站」按钮（danger 样式）。
- 每行「恢复」旁增加「彻底删除」按钮（danger），点击 → 确认对话框（「彻底删除后无法恢复」）→ `DELETE /api/rules/:id/permanent` → toast「已彻底删除」→ `loadTrash()`。
- 清空回收站点击 → 确认对话框（「将彻底删除回收站中全部 N 条记录，无法恢复」）→ `POST /api/rules/trash/clear` → toast「已清空回收站」→ `loadTrash()`。
- 回收站为空时禁用「清空回收站」按钮。

## 7. 保存时双重验证

- **后端（权威）**：`normalizePattern` + `isValidPriority`，非法 400。新建、编辑、导入三条路径共用同一套校验。
- **前端（即时反馈）**：提交前本地校验，非法时 `#rule-error` 显示错误、不发请求。前端校验只是体验优化，后端校验是最终裁决。

## 8. 兼容性

- 旧库启动时自动迁移（§4），存量全局记录变为 `*`，行为不变。
- 导入旧导出文件（无 priority）默认 0。
- API 响应中 host 恒非空（`*` / 模式 / 精确域名之一）。

## 9. 测试计划

| 文件 | 覆盖 |
|------|------|
| `test/hostmatch.test.js`（新增） | matchHost（精确/`*` 单层/`**` 多层与 0 层/全局/空 host）、patternIntersects（含 `**` 相交用例）、compareRules（priority/具体度/id 三级，具体度含 `*` 与 `**` 分层）、normalizePattern（空→*、单独 `**`→*、非法模式拒绝、大小写/尾点归一化）、isValidPriority |
| `test/repo-rules.test.js`（更新） | matchFile 模式命中、优先级覆盖、同优先级具体度兜底；listFiles 筛选业务语义（模式行出现在命中域名筛选中）；onlyGlobal 用 `*`；listMeta 排除模式；hardDeleteFile 只删回收站行/活动行删不掉；clearTrash 计数 |
| `test/routes-rules.test.js`（更新） | parsePayload：空 host → `*`、非法模式 400、priority 越界/非整数 400；导出含 priority；旧格式导入默认 0；permanent 删除成功/活动行 404/不存在 404；trash/clear 计数 |
| `test/selfcheck.test.js`（更新） | 模式规则 NO_HOST；遮蔽检测（模式被精确遮蔽、被高优先级全局遮蔽、低优先级不提示） |
| `test/stats.test.js`（更新） | global 统计 `*`；byDomain 排除模式 |
| 迁移测试 | 旧库（无 priority 列、host=''）openDb 后：列存在、host 变 `*`、行为等价 |

## 10. 文档同步

- README 第 17 行「路由规则全局生效或按域名绑定」→ 补「支持通配模式与手动优先级」。
- README 第 77 行「把规则域名留空，全局生效」→ 「把规则域名填 `*` 全局生效，支持 `*.example.com` / `**.example.com` 通配与优先级」。

## 11. 批量自检（异步任务 + 轮询）

### 11.1 后端

新模块 `src/batchcheck.js`：内存任务注册表（模块级 Map，单进程内共享）：

- `POST /api/rules/batch-check`：body 为与 `GET /api/rules` 相同的筛选参数（host/q/by，不含回收站），服务端解析出行集合（上限 500 条，超出返回 400 提示缩小筛选范围），创建任务 `{id, total, done, results}` 并立即以**并发 5** 逐行执行 `runInternalCheck` + `runExternalCheck`（复用现有实现，走同一 `fetchImpl` 与自检超时设置）。任务 10 分钟后自动清除。
- `GET /api/rules/batch-check/:id`：返回 `{status: running|done, total, done, results: [{id, internal, external}]}`；不存在返回 404。
- 任务不持久化：进程重启后任务消失，重新点击即可。
- 批量自检路由注册在参数路由 `/:id` 之前，避免被吞。
- 单条自检 `POST /:id/check` 保持不变。

### 11.2 前端

- 规则列表筛选栏旁新增「批量自检」按钮：点击 → 确认对话框（「将对当前筛选的 N 条规则完整自检，可能耗时」）→ 创建任务 → 按钮变为进度 `x/y` 并禁用 → 每 1.5s 轮询一次，按行 id 把结果渲染到各行（复用现有 `CHECK_HINTS` 徽章样式，进行中行显示转圈）。
- 完成后：按钮恢复，toast 汇总「通过 x，异常 y」；行内结果保留到下次刷新。
- 轮询期间切换筛选或刷新列表：结果按行 id 渲染，不在当前视图的行自然不可见；任务不受影响继续跑完。
- 不做取消按钮（YAGNI）：任务自然结束或 10 分钟过期。

### 11.3 测试

- `test/batchcheck.test.js`（新增）：任务创建/轮询状态流转、完成后结果完整、筛选参数解析、超限 400、过期清理、并发上限（fetchImpl stub 计数）。
- `test/routes-rules.test.js`（更新）：批量自检路由用例（fetchImpl stub 注入）。

## 12. 帮助文档与入口

- 新增顶层帮助文档（帮助面板自动渲染 docs/ 下 .md，无需注册）。文件名必须是 ASCII（`docs.js` 的 `DOC_ID_RE` 拒绝中文 id），定为 `docs/rules-guide.md`，标题 `# 规则配置说明`：
  - host 匹配语法：精确域名、`*`（单层）、`**`（任意层含 0 层）、全局 `*`，各配例子
  - 优先级：排序次序（priority → 具体度 → 先建）、默认 0、范围 0~1000
  - 保存校验规则与常见错误示例
  - 单条自检与批量自检用法、结果代码含义（对齐 `CHECK_HINTS`）
- `public/help.js` 增加 `openHelpDoc(id)`：切换到帮助面板、定位并打开指定文档；规则对话框的「?」链接调用它。

## 13. 回收站管理

彻底删除是不可逆操作，不做可恢复的第二层保险；依赖前端确认对话框把关。

| 层级 | 改动 |
|------|------|
| repo | `hardDeleteFile(db, id)`：仅当 `deleted_at IS NOT NULL` 时物理删除，返回删除行数（活动行 0 行）；`clearTrash(db)`：物理删除全部回收站行，返回删除行数 |
| 路由 | `DELETE /api/rules/:id/permanent`：记录不存在或未删除 → 404；成功 204。`POST /api/rules/trash/clear` → `{count}`。均注册在 `/:id` 之前 |
| UI | 回收站面板加工具栏「清空回收站」（danger）；每行加「彻底删除」（danger）；两个操作均走 `confirmDialog`；操作后 `loadTrash()` 刷新；回收站为空时禁用清空按钮 |
| 测试 | 见 §9（repo 与 routes 两行） |

安全边界：彻底删除只作用于 `deleted_at IS NOT NULL` 的行，活动规则不会被误删；清空回收站同理，活跃数据不受影响。
