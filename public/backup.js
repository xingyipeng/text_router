import { $, api, toast, fmtTime, escapeHtml, confirmDialog } from './app.js';

// —— 备份管理（仅超管可见） ——

function fmtSize(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

async function loadList() {
  const panel = $('#panel-backups');
  panel.classList.add('loading');
  let rows;
  try {
    rows = await api('/api/backups');
  } catch (err) {
    toast(err.message);
    return;
  } finally {
    panel.classList.remove('loading');
  }
  const tbody = $('#backups-table tbody');
  tbody.innerHTML = '';
  $('#panel-backups .empty').hidden = rows.length > 0;

  rows.forEach((b, i) => {
    const tr = document.createElement('tr');
    tr.style.setProperty('--i', i); // 行入场错峰（纯展示）
    tr.dataset.name = b.name;
    tr.innerHTML = `
      <td>${fmtTime(b.mtimeMs)}<br><small class="mono">${escapeHtml(b.name)}</small></td>
      <td class="mono">${fmtSize(b.size)}</td>
      <td class="actions">
        <a class="btn sm" href="/api/backups/${encodeURIComponent(b.name)}/download" download>下载</a>
        <button class="btn sm" data-act="restore-backup">恢复</button>
        <button class="btn sm danger" data-act="delete-backup">删除</button>
      </td>`;
    tbody.append(tr);
  });
}

$('#btn-backup-now').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  btn.classList.add('loading');
  try {
    const r = await api('/api/backups', { method: 'POST' });
    toast(`备份完成：${r.filename}（${r.sizeKb} KB）`);
    loadList();
  } catch (err) {
    toast(err.message);
  } finally {
    btn.disabled = false;
    btn.classList.remove('loading');
  }
});

$('#backups-table').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const name = btn.closest('tr').dataset.name;

  try {
    if (btn.dataset.act === 'restore-backup') {
      const ok = await confirmDialog({
        title: '恢复备份',
        message: `将用 ${name} 覆盖当前数据库，服务会自动重启，期间短暂不可用。建议先「立即备份」留底。`,
        okText: '恢复',
        danger: true,
      });
      if (!ok) return;
      await api(`/api/backups/${encodeURIComponent(name)}/restore`, { method: 'POST' });
      toast('恢复完成，服务即将重启');
    } else if (btn.dataset.act === 'delete-backup') {
      const ok = await confirmDialog({
        title: '删除备份',
        message: `删除 ${name}？此操作不可恢复。`,
        okText: '删除',
        danger: true,
      });
      if (!ok) return;
      await api(`/api/backups/${encodeURIComponent(name)}`, { method: 'DELETE' });
      toast('已删除');
      loadList();
    }
  } catch (err) {
    toast(err.message);
  }
});

// —— 上传数据库恢复（迁移用） ——
// 上传即恢复：服务端校验完整性后替换库文件并自动重启。
// 文件走裸 fetch——api() 助手只支持 JSON 请求体。
$('#btn-backup-upload').addEventListener('click', () => $('#backup-upload-input').click());

$('#backup-upload-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const ok = await confirmDialog({
    title: '上传恢复',
    message: `将用 ${file.name} 覆盖当前数据库，服务会自动重启，期间短暂不可用。上传前会校验数据库完整性，旧库会留底 .before-restore。`,
    okText: '恢复',
    danger: true,
  });
  if (!ok) { e.target.value = ''; return; }
  try {
    const res = await fetch('/api/backups/upload', {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: file,
    });
    const text = await res.text();
    const data = text ? JSON.parse(text) : null;
    if (!res.ok) throw new Error(data?.error || `请求失败（HTTP ${res.status}）`);
    toast('恢复完成，服务即将重启');
  } catch (err) {
    toast(err.message);
  } finally {
    e.target.value = '';
  }
});

document.addEventListener('tab:show', (e) => {
  if (e.detail === 'backups') loadList();
});
