import { $, $$, api, toast, fmtTime, personLabel, escapeHtml, listeners, confirmDialog } from './app.js';
import { openHelpDoc } from './help.js';

const filters = { host: '', q: '', by: '', sort: 'updated', dir: 'desc' };
// 各排序键的默认方向：时间类默认新→旧，文本类默认 A→Z
const SORT_DEFAULT_DIRS = { updated: 'desc', created: 'desc', host: 'asc', filename: 'asc', created_by: 'asc' };
let editingId = null;
// 批量删除勾选：Set 存规则 id，每次重载列表清空（勾选只作用于当前列表）
const selected = new Set();
// 筛选器元数据：全部现有域名与全部操作人（来自 /api/rules/meta，独立于当前筛选结果）
let meta = { hosts: [], persons: [] };

const ICONS = {
  check: '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M8 1.5l4.5 1.8v3.9c0 3.2-1.9 5.5-4.5 6.4-2.6-.9-4.5-3.2-4.5-6.4V3.3z"/><path d="M5.8 8l1.6 1.6 2.8-3"/></svg>',
  edit: '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M11.3 2.3l2.4 2.4L5.5 13H3v-2.5z"/></svg>',
  del: '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M2.5 4h11M6.5 2h3M4 4l.7 9.5h6.6L12 4M6.5 6.5v4.5M9.5 6.5v4.5"/></svg>',
};

const CHECK_HINTS = {
  OK: '线上完全正常',
  NO_HOST: '无法自动验证',
  EGRESS_BLOCKED: '本机无法出网，外部验证不可用',
  DNS_OR_CONNECT_FAILED: '域名解析或连接失败',
  REDIRECTED: '被重定向，微信不接受',
  STATUS_NOT_200: '状态码不是 200',
  CONTENT_TYPE_WRONG: 'Content-Type 不是 text/plain',
  CONTENT_MISMATCH: '线上内容与库中不一致',
};

async function loadRules() {
  const panel = $('#panel-rules');
  panel.classList.add('loading');
  try {
    const qs = new URLSearchParams();
    if (filters.host === '__global__') qs.set('only_global', '1');
    else if (filters.host) qs.set('host', filters.host);
    if (filters.q) qs.set('q', filters.q);
    if (filters.by) qs.set('by', filters.by);
    if (filters.sort) qs.set('sort', filters.sort);
    if (filters.dir) qs.set('dir', filters.dir);
    const rows = await api(`/api/rules?${qs}`);
    renderRules(rows);
  } finally {
    panel.classList.remove('loading');
  }
}

// 加载筛选器元数据（域名下拉 + 操作人下拉），与当前筛选结果无关。
// 数据变化（增删改、恢复）后调用一次即可保持下拉最新。
async function loadMeta() {
  meta = await api('/api/rules/meta');
  renderHostFilter();
  renderPeopleFilter();
}

function renderRules(rows) {
  const tbody = $('#rules-table tbody');
  tbody.innerHTML = '';
  selected.clear();
  $('#panel-rules .empty').hidden = rows.length > 0;
  $('#r-count').textContent = rows.length ? `共 ${rows.length} 条` : '';

  rows.forEach((r, i) => {
    const tr = document.createElement('tr');
    tr.style.setProperty('--i', i); // 行入场错峰（纯展示）
    const hostCell = r.host === '*' ? '所有域名' : escapeHtml(r.host);
    const priorityBadge = r.priority ? ` <small>(优先 ${r.priority})</small>` : '';
    tr.innerHTML = `
      <td class="mono">${hostCell}${priorityBadge}</td>
      <td class="mono">${escapeHtml(r.filename)}</td>
      <td>${escapeHtml(r.note)}</td>
      <td>${escapeHtml(personLabel(r.created_by_username, r.created_by_name))}</td>
      <td>${escapeHtml(personLabel(r.updated_by_username, r.updated_by_name))}<br>
          <small>${fmtTime(r.updated_at)}</small></td>
      <td class="actions">
        <button class="btn sm" data-act="check" title="自检">${ICONS.check}自检</button>
        <button class="btn sm" data-act="edit" title="编辑">${ICONS.edit}编辑</button>
        <button class="btn sm danger" data-act="delete" title="删除">${ICONS.del}删除</button>
      </td>`;
    tr.dataset.id = r.id;
    tr.dataset.row = JSON.stringify(r);
    const selTd = document.createElement('td');
    selTd.className = 'col-check';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = selected.has(r.id);
    cb.title = '选择此条';
    cb.addEventListener('change', () => {
      if (cb.checked) selected.add(r.id); else selected.delete(r.id);
      updateBatchDelete();
    });
    selTd.append(cb);
    tr.prepend(selTd);
    tbody.append(tr);
  });
  updateBatchDelete();
}

function renderHostFilter() {
  const sel = $('#r-host');
  const current = sel.value;
  sel.innerHTML =
    '<option value="">全部域名</option>' +
    '<option value="__global__">全局（*）</option>';
  for (const host of meta.hosts) {
    const o = document.createElement('option');
    o.value = host;
    o.textContent = host;
    sel.append(o);
  }
  sel.value = current;
}

function renderPeopleFilter() {
  const sel = $('#r-by');
  const current = sel.value;
  sel.innerHTML = '<option value="">全部操作人</option>';
  for (const p of meta.persons) {
    const o = document.createElement('option');
    o.value = p.id;
    o.textContent = personLabel(p.username, p.display_name);
    sel.append(o);
  }
  sel.value = current;
}

// 在指定规则行下方渲染/更新自检结果行；pending 转圈、error 直显、否则徽章
function upsertCheckRow(tr, data) {
  const tbody = tr.parentElement;
  let row = tr.nextElementSibling;
  if (!row || !row.classList.contains('check-row')) {
    row = document.createElement('tr');
    row.className = 'check-row';
    const td = document.createElement('td');
    td.colSpan = 7; // 域名/路径/备注/创建人/最后修改/操作 + 勾选列
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
  if (/[\[\]]/.test(h)) {
    return { error: '非法域名：不支持方括号与 [0-9a-z] 这类字符类写法' };
  }
  return { value: h };
}

{
  const input = $('#rule-form').host;
  input.addEventListener('input', () => {
    $('#host-global-hint').hidden = !!input.value.trim();
  });
}

function updateWarnings() {
  const v = $('#rule-form').content.value;
  const bytes = new TextEncoder().encode(v).length;
  const w = [];
  if (v.charCodeAt(0) === 0xfeff) w.push('含 BOM');
  if (v.includes('\r\n')) w.push('含 CRLF 换行');
  if (/^\s/.test(v)) w.push('首部有空白');
  if (/\s$/.test(v)) w.push('尾部有空白');
  $('#content-warnings').innerHTML = w.length
    ? `⚠ ${w.join('、')}（${bytes} 字节）　<button type="button" class="link" id="btn-clean">一键清理</button>`
    : `${bytes} 字节`;
}

async function loadTrash() {
  const panel = $('#panel-trash');
  panel.classList.add('loading');
  let rows;
  try {
    rows = (await api('/api/rules?include_deleted=1')).filter((r) => r.deleted_at);
  } finally {
    panel.classList.remove('loading');
  }
  const tbody = $('#trash-table tbody');
  tbody.innerHTML = '';
  $('#panel-trash .empty').hidden = rows.length > 0;
  rows.forEach((r, i) => {
    const tr = document.createElement('tr');
    tr.className = 'deleted';
    tr.style.setProperty('--i', i); // 行入场错峰（纯展示）
    tr.innerHTML = `
      <td class="mono">${r.host === '*' ? '所有域名' : escapeHtml(r.host)}</td>
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
}

// —— 事件绑定 ——

const debounce = (fn, ms) => {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
};

// 关键词搜索输入框：防抖 + 清除按钮
{
  const input = $('#r-q');
  const btn = $(`button[data-clear="q"]`);
  const apply = debounce(() => {
    filters.q = input.value.trim();
    btn.hidden = !input.value;
    loadRules();
  }, 250);
  input.addEventListener('input', apply);
  btn.addEventListener('click', () => {
    input.value = '';
    btn.hidden = true;
    filters.q = '';
    loadRules();
    input.focus();
  });
}
$('#r-host').addEventListener('change', (e) => { filters.host = e.target.value; loadRules(); });
$('#r-by').addEventListener('change', (e) => { filters.by = e.target.value; loadRules(); });

// 表头点击排序：点当前排序列切换升降序，点其他列切换为该列（按其默认方向）
function renderSortState() {
  $('#rules-table').querySelectorAll('th.sortable').forEach((th) => {
    const active = th.dataset.sort === filters.sort;
    th.classList.toggle('sort-asc', active && filters.dir === 'asc');
    th.classList.toggle('sort-desc', active && filters.dir === 'desc');
  });
}
$('#rules-table thead').addEventListener('click', (e) => {
  const th = e.target.closest('th.sortable');
  if (!th) return;
  const key = th.dataset.sort;
  if (filters.sort === key) {
    filters.dir = filters.dir === 'asc' ? 'desc' : 'asc';
  } else {
    filters.sort = key;
    filters.dir = SORT_DEFAULT_DIRS[key] || 'asc';
  }
  renderSortState();
  loadRules();
});
renderSortState();
$('#btn-rules-refresh').addEventListener('click', () => {
  loadRules();
  loadMeta();
});
$('#btn-new').addEventListener('click', () => openDialog(null));
$('#btn-host-help').addEventListener('click', () => {
  $('#rule-dialog').close(); // 跳到帮助页前先关弹窗，避免浮在帮助页上
  openHelpDoc('rules-guide');
});
$('#rule-cancel').addEventListener('click', () => $('#rule-dialog').close());
$('#rule-form').content.addEventListener('input', updateWarnings);

$('#content-warnings').addEventListener('click', (e) => {
  if (e.target.id !== 'btn-clean') return;
  const f = $('#rule-form');
  f.content.value = f.content.value
    .replace(/^\uFEFF/, '')
    .replace(/\r\n/g, '\n')
    .trim();
  updateWarnings();
});

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

$('#rules-table').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const tr = btn.closest('tr');
  const row = JSON.parse(tr.dataset.row);

  if (btn.dataset.act === 'edit') return openDialog(row);

  if (btn.dataset.act === 'delete') {
    const ok = await confirmDialog({
      title: '删除规则',
      message: `确定删除 ${row.filename}？删除后微信将无法抓取到它，可在回收站恢复。`,
      okText: '删除',
      danger: true,
    });
    if (!ok) return;
    await api(`/api/rules/${row.id}`, { method: 'DELETE' });
    toast('已移入回收站');
    tr.classList.add('removing'); // 行淡出后刷新（纯展示）
    setTimeout(loadRules, 240);
    loadMeta();
    return;
  }

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
});

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
  if (job.status === 'done' || job.status === 'failed') {
    finishBatch();
    if (job.status === 'failed') { toast('批量自检失败，请重试'); return; }
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

// —— 批量删除 ——

function updateBatchDelete() {
  $('#btn-batch-delete').disabled = selected.size === 0;
  const boxes = $$('#rules-table tbody input[type="checkbox"]');
  const checked = boxes.filter((b) => b.checked).length;
  const all = $('#rules-check-all');
  all.checked = boxes.length > 0 && checked === boxes.length;
  all.indeterminate = checked > 0 && checked < boxes.length;
}

$('#rules-check-all').addEventListener('change', (e) => {
  $$('#rules-table tbody input[type="checkbox"]').forEach((cb) => {
    cb.checked = e.target.checked;
    const id = Number(cb.closest('tr').dataset.id);
    if (cb.checked) selected.add(id); else selected.delete(id);
  });
  updateBatchDelete();
});

$('#btn-batch-delete').addEventListener('click', async () => {
  const ids = [...selected];
  if (ids.length === 0) return;
  const ok = await confirmDialog({
    title: '批量删除',
    message: `确定删除选中的 ${ids.length} 条规则？删除后微信将无法抓取到它们，可在回收站恢复。`,
    okText: '删除',
    danger: true,
  });
  if (!ok) return;
  try {
    const res = await api('/api/rules/batch-delete', { method: 'POST', body: { ids } });
    toast(`已移入回收站（${res.count} 条）`);
    loadRules();
    loadMeta();
  } catch (err) {
    toast(err.message);
  }
});

// —— 拖拽导入 ——

const dz = $('#dropzone');
['dragenter', 'dragover'].forEach((ev) =>
  dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('over'); }));
['dragleave', 'drop'].forEach((ev) =>
  dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove('over'); }));

dz.addEventListener('drop', async (e) => {
  const file = e.dataTransfer.files[0];
  if (!file) return;
  if (!file.name.endsWith('.txt')) return toast('请拖入 .txt 文件');

  const raw = await file.text();
  const f = $('#rule-form');
  f.filename.value = file.name;
  f.content.value = raw;
  updateWarnings();

  // <textarea> 按 HTML 规范会把 CRLF/CR 规范化成 LF。所以文件里若含回车符，
  // 输入框里的内容已经和原文件不是逐字节相同了。微信要求精确匹配，
  // 这个差异必须说出来，不能悄悄发生。
  if (f.content.value !== raw) {
    toast(
      `注意：${file.name} 含回车符（CR），输入框已自动规范化为 LF，内容将与原文件非逐字节相同；若微信校验失败请优先排查这一点`
    );
  }

  toast(`已读取 ${file.name}`);
});

// —— 规则 JSON 导入 ——
// 导出是纯下载链接（index.html 里的 <a href="/api/rules/export" download>），无需 JS。

// 拖拽的文件无法写入 <input type="file">（安全限制），单独存变量，提交时优先使用
let importFile = null;

function setImportFileName(file) {
  importFile = file;
  const nameEl = $('#import-file-name');
  nameEl.textContent = file.name;
  nameEl.hidden = false;
}

const impDz = $('#import-dropzone');
['dragenter', 'dragover'].forEach((ev) =>
  impDz.addEventListener(ev, (e) => { e.preventDefault(); impDz.classList.add('over'); }));
['dragleave', 'drop'].forEach((ev) =>
  impDz.addEventListener(ev, (e) => { e.preventDefault(); impDz.classList.remove('over'); }));
impDz.addEventListener('drop', (e) => {
  const file = e.dataTransfer.files[0];
  if (!file) return;
  if (!file.name.toLowerCase().endsWith('.json')) return toast('请拖入 .json 文件');
  setImportFileName(file);
});
$('#rules-import-file').addEventListener('change', (e) => {
  if (e.target.files[0]) setImportFileName(e.target.files[0]);
});

$('#btn-rules-import').addEventListener('click', () => {
  $('#rules-import-error').textContent = '';
  $('#rules-import-result').hidden = true;
  $('#rules-import-file').value = '';
  importFile = null;
  $('#import-file-name').hidden = true;
  const submitBtn = $('#rules-import-form button[value="save"]');
  submitBtn.type = 'submit';
  submitBtn.textContent = '开始导入';
  $('#rules-import-dialog').showModal();
});
$('#rules-import-cancel').addEventListener('click', () => $('#rules-import-dialog').close());
// 导入成功后主按钮变为「完成」（type=button，不再触发表单提交），点击关闭弹窗
$('#rules-import-form button[value="save"]').addEventListener('click', (e) => {
  if (e.currentTarget.type === 'button') $('#rules-import-dialog').close();
});

$('#rules-import-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const file = importFile || $('#rules-import-file').files[0];
  const errEl = $('#rules-import-error');
  const resultEl = $('#rules-import-result');
  errEl.textContent = '';
  resultEl.hidden = true;
  if (!file) { errEl.textContent = '请先选择 JSON 文件'; return; }

  let data;
  try {
    data = JSON.parse(await file.text());
  } catch {
    errEl.textContent = '文件不是合法的 JSON';
    return;
  }
  if (!Array.isArray(data?.files)) {
    errEl.textContent = '不是有效的规则导出文件（缺少 files 数组）';
    return;
  }

  const mode = $('#rules-import-form').querySelector('input[name="import-mode"]:checked').value;
  const submitBtn = e.target.querySelector('button[type="submit"]');
  submitBtn.disabled = true;
  submitBtn.classList.add('loading');
  try {
    const r = await api('/api/rules/import', { method: 'POST', body: { mode, files: data.files } });
    let html = `导入 ${r.imported} 条，跳过 ${r.skipped} 条`;
    if (r.errors.length) {
      html += `<ul>${r.errors.map((er) =>
        `<li>${escapeHtml(er.filename || '（无文件名）')}（${escapeHtml(er.host || '全部域名')}）：${escapeHtml(er.reason)}</li>`
      ).join('')}</ul>`;
    }
    resultEl.innerHTML = html;
    resultEl.hidden = false;
    submitBtn.type = 'button';
    submitBtn.textContent = '完成';
    loadRules();
    loadMeta();
  } catch (err) {
    errEl.textContent = err.message;
  } finally {
    submitBtn.disabled = false;
    submitBtn.classList.remove('loading');
  }
});

// —— 接入主流程 ——

listeners.onEnterMain.push(loadMeta, loadRules);
document.addEventListener('tab:show', (e) => {
  if (e.detail === 'rules') loadRules();
  if (e.detail === 'trash') loadTrash();
});
