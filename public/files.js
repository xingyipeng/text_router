import { $, api, toast, fmtTime, personLabel, escapeHtml, listeners } from './app.js';

const filters = { host: '', q: '', by: '' };
let editingId = null;

const CHECK_HINTS = {
  OK: '线上完全正常',
  NO_HOST: '全局记录，无法自动验证',
  EGRESS_BLOCKED: '本机无法出网，外部验证不可用',
  DNS_OR_CONNECT_FAILED: '域名解析或连接失败',
  REDIRECTED: '被重定向，微信不接受',
  STATUS_NOT_200: '状态码不是 200',
  CONTENT_TYPE_WRONG: 'Content-Type 不是 text/plain',
  CONTENT_MISMATCH: '线上内容与库中不一致',
};

async function loadFiles() {
  const qs = new URLSearchParams();
  if (filters.host) qs.set('host', filters.host);
  if (filters.q) qs.set('q', filters.q);
  if (filters.by) qs.set('by', filters.by);
  const rows = await api(`/api/files?${qs}`);
  renderFiles(rows);
  renderPeopleFilter(rows);
}

function renderFiles(rows) {
  const tbody = $('#files-table tbody');
  tbody.innerHTML = '';
  $('#panel-files .empty').hidden = rows.length > 0;

  for (const r of rows) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="mono">${r.host ? escapeHtml(r.host) : '<em>全部域名</em>'}</td>
      <td class="mono">${escapeHtml(r.filename)}</td>
      <td>${escapeHtml(r.note)}</td>
      <td>${escapeHtml(personLabel(r.created_by_username, r.created_by_name))}</td>
      <td>${escapeHtml(personLabel(r.updated_by_username, r.updated_by_name))}<br>
          <small>${fmtTime(r.updated_at)}</small></td>
      <td>
        <button class="link" data-act="check">自检</button>
        <button class="link" data-act="edit">编辑</button>
        <button class="link danger" data-act="delete">删除</button>
        <div class="check-result"></div>
      </td>`;
    tr.dataset.id = r.id;
    tr.dataset.row = JSON.stringify(r);
    tbody.append(tr);
  }
}

function renderPeopleFilter(rows) {
  const sel = $('#f-by');
  const seen = new Map();
  for (const r of rows) {
    if (r.created_by) seen.set(r.created_by, personLabel(r.created_by_username, r.created_by_name));
    if (r.updated_by) seen.set(r.updated_by, personLabel(r.updated_by_username, r.updated_by_name));
  }
  const current = sel.value;
  sel.innerHTML = '<option value="">全部操作人</option>';
  for (const [id, label] of seen) {
    const o = document.createElement('option');
    o.value = id;
    o.textContent = label;
    sel.append(o);
  }
  sel.value = current;
}

function openDialog(row) {
  editingId = row ? row.id : null;
  $('#file-dialog-title').textContent = row ? '编辑校验文件' : '新增校验文件';
  const f = $('#file-form');
  f.host.value = row?.host ?? '';
  f.filename.value = row?.filename ?? '';
  f.content.value = row?.content ?? '';
  f.note.value = row?.note ?? '';
  $('#file-error').textContent = '';
  updateWarnings();
  $('#file-dialog').showModal();
}

function updateWarnings() {
  const v = $('#file-form').content.value;
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
  const rows = (await api('/api/files?include_deleted=1')).filter((r) => r.deleted_at);
  const tbody = $('#trash-table tbody');
  tbody.innerHTML = '';
  $('#panel-trash .empty').hidden = rows.length > 0;
  for (const r of rows) {
    const tr = document.createElement('tr');
    tr.className = 'deleted';
    tr.innerHTML = `
      <td class="mono">${r.host ? escapeHtml(r.host) : '<em>全部域名</em>'}</td>
      <td class="mono">${escapeHtml(r.filename)}</td>
      <td>${escapeHtml(r.note)}</td>
      <td>${escapeHtml(personLabel(r.deleted_by_username, r.deleted_by_name))}</td>
      <td>${fmtTime(r.deleted_at)}</td>
      <td><button class="link" data-act="restore">恢复</button></td>`;
    tr.dataset.id = r.id;
    tbody.append(tr);
  }
}

// —— 事件绑定 ——

$('#f-host').addEventListener('input', (e) => { filters.host = e.target.value.trim(); loadFiles(); });
$('#f-q').addEventListener('input', (e) => { filters.q = e.target.value.trim(); loadFiles(); });
$('#f-by').addEventListener('change', (e) => { filters.by = e.target.value; loadFiles(); });
$('#btn-new').addEventListener('click', () => openDialog(null));
$('#file-cancel').addEventListener('click', () => $('#file-dialog').close());
$('#file-form').content.addEventListener('input', updateWarnings);

$('#content-warnings').addEventListener('click', (e) => {
  if (e.target.id !== 'btn-clean') return;
  const f = $('#file-form');
  f.content.value = f.content.value
    .replace(/^\uFEFF/, '')
    .replace(/\r\n/g, '\n')
    .trim();
  updateWarnings();
});

$('#file-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const body = {
    host: f.host.value.trim(),
    filename: f.filename.value.trim(),
    content: f.content.value,
    note: f.note.value.trim(),
  };
  $('#file-error').textContent = '';
  try {
    if (editingId) await api(`/api/files/${editingId}`, { method: 'PUT', body });
    else await api('/api/files', { method: 'POST', body });
    $('#file-dialog').close();
    toast(editingId ? '已保存' : '已新增');
    loadFiles();
  } catch (err) {
    $('#file-error').textContent = err.message;
  }
});

$('#files-table').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const tr = btn.closest('tr');
  const row = JSON.parse(tr.dataset.row);

  if (btn.dataset.act === 'edit') return openDialog(row);

  if (btn.dataset.act === 'delete') {
    if (!confirm(`确定删除 ${row.filename}？删除后微信将无法抓取到它。可在回收站恢复。`)) return;
    await api(`/api/files/${row.id}`, { method: 'DELETE' });
    toast('已移入回收站');
    return loadFiles();
  }

  if (btn.dataset.act === 'check') {
    const box = $('.check-result', tr);
    box.textContent = '检查中…';
    try {
      const { internal, external } = await api(`/api/files/${row.id}/check`, { method: 'POST' });
      const cls = external.code === 'OK' ? 'ok'
        : ['NO_HOST', 'EGRESS_BLOCKED'].includes(external.code) ? 'unknown' : 'bad';
      const internalPart = internal.ok
        ? '内部检查通过'
        : `内部检查未通过：${internal.problems.join('；')}`;
      box.innerHTML =
        `<span class="check ${internal.ok ? 'ok' : 'bad'}">${escapeHtml(internalPart)}</span>
         <span class="check ${cls}">${escapeHtml(CHECK_HINTS[external.code] || external.code)}</span>
         <div><small>${escapeHtml(external.detail || '')}</small></div>`;
    } catch (err) {
      box.textContent = err.message;
    }
  }
});

$('#trash-table').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act="restore"]');
  if (!btn) return;
  const id = btn.closest('tr').dataset.id;
  try {
    await api(`/api/files/${id}/restore`, { method: 'POST' });
    toast('已恢复');
    loadTrash();
  } catch (err) {
    alert(err.message);
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
  if (!file.name.endsWith('.txt')) return alert('请拖入 .txt 文件');

  const raw = await file.text();
  const f = $('#file-form');
  f.filename.value = file.name;
  f.content.value = raw;
  updateWarnings();

  // <textarea> 按 HTML 规范会把 CRLF/CR 规范化成 LF。所以文件里若含回车符，
  // 输入框里的内容已经和原文件不是逐字节相同了。微信要求精确匹配，
  // 这个差异必须说出来，不能悄悄发生。
  if (f.content.value !== raw) {
    alert(
      `注意：${file.name} 含有回车符（CR），浏览器输入框已自动把换行规范化为 LF。\n` +
      `保存的内容将与原文件不是逐字节相同。若微信校验失败，请优先排查这一点。`
    );
  }

  toast(`已读取 ${file.name}`);
});

// —— 接入主流程 ——

listeners.onEnterMain.push(loadFiles);
document.addEventListener('tab:show', (e) => {
  if (e.detail === 'files') loadFiles();
  if (e.detail === 'trash') loadTrash();
});
