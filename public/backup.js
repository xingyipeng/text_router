import { $, api, toast, fmtTime, escapeHtml, confirmDialog } from './app.js';

// —— 备份管理（仅超管可见） ——

function fmtSize(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

async function loadSettings() {
  try {
    const s = await api('/api/backups/settings');
    $('#bk-enabled').checked = s.enabled;
    $('#bk-time').value = s.time;
    $('#bk-keep').value = s.keep;
  } catch (err) {
    toast(err.message);
  }
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

$('#bk-settings-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('#btn-save-settings');
  btn.disabled = true;
  btn.classList.add('loading');
  try {
    const saved = await api('/api/backups/settings', {
      method: 'PUT',
      body: {
        enabled: $('#bk-enabled').checked,
        time: $('#bk-time').value,
        keep: Number($('#bk-keep').value),
      },
    });
    // 以服务端校验后的值为准回填
    $('#bk-enabled').checked = saved.enabled;
    $('#bk-time').value = saved.time;
    $('#bk-keep').value = saved.keep;
    toast(saved.enabled ? `已启用定时备份：每天 ${saved.time}` : '已保存（定时备份保持关闭）');
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

document.addEventListener('tab:show', (e) => {
  if (e.detail !== 'backups') return;
  loadSettings();
  loadList();
});
