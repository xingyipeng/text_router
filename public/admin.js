import { $, api, state, toast, fmtTime, escapeHtml } from './app.js';

// —— 用户管理 ——

async function loadUsers() {
  if (!state.me?.is_super) return;
  const includeDisabled = $('#u-show-disabled').checked;
  const rows = await api(`/api/users?include_disabled=${includeDisabled ? 1 : 0}`);
  const tbody = $('#users-table tbody');
  tbody.innerHTML = '';

  for (const u of rows) {
    const tr = document.createElement('tr');
    if (u.disabled_at) tr.className = 'deleted';
    const actions = u.is_super
      ? '<span class="hint">超管不可禁用</span>'
      : u.disabled_at
        ? '<button class="link" data-act="restore-user">恢复</button>'
        : `<button class="link" data-act="reset-pw">重置密码</button>
           <button class="link danger" data-act="disable-user">禁用</button>`;
    tr.innerHTML = `
      <td class="mono">${escapeHtml(u.username)}</td>
      <td>${escapeHtml(u.display_name)}</td>
      <td>${u.is_super ? '超级管理员' : '普通用户'}</td>
      <td>${u.disabled_at ? '已禁用' : '正常'}</td>
      <td>${fmtTime(u.created_at)}</td>
      <td>${actions}</td>`;
    tr.dataset.id = u.id;
    tr.dataset.username = u.username;
    tbody.append(tr);
  }
}

$('#u-show-disabled').addEventListener('change', loadUsers);
$('#btn-new-user').addEventListener('click', () => {
  $('#user-error').textContent = '';
  $('#user-form').reset();
  $('#user-dialog').showModal();
});
$('#user-cancel').addEventListener('click', () => $('#user-dialog').close());

$('#user-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  $('#user-error').textContent = '';
  try {
    await api('/api/users', {
      method: 'POST',
      body: {
        username: f.get('username').trim(),
        display_name: f.get('display_name').trim(),
        password: f.get('password'),
      },
    });
    $('#user-dialog').close();
    toast('用户已创建');
    loadUsers();
  } catch (err) {
    $('#user-error').textContent = err.message;
  }
});

$('#users-table').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const tr = btn.closest('tr');
  const { id, username } = tr.dataset;

  try {
    if (btn.dataset.act === 'disable-user') {
      if (!confirm(`禁用 ${username}？该用户将立即被踢下线，但其创建的记录归属会保留。`)) return;
      await api(`/api/users/${id}`, { method: 'DELETE' });
      toast('已禁用');
    } else if (btn.dataset.act === 'restore-user') {
      await api(`/api/users/${id}/restore`, { method: 'POST' });
      toast('已恢复');
    } else if (btn.dataset.act === 'reset-pw') {
      const pw = prompt(`为 ${username} 设置新密码（至少 12 位）`);
      if (!pw) return;
      await api(`/api/users/${id}/password`, { method: 'POST', body: { new_password: pw } });
      toast('密码已重置，该用户已被踢下线');
    }
    loadUsers();
  } catch (err) {
    alert(err.message);
  }
});

// —— 诊断面板 ——

async function loadDiagnostics() {
  const rows = await api('/api/diagnostics/recent-requests');
  const tbody = $('#diag-table tbody');
  tbody.innerHTML = '';
  $('#panel-diag .empty').hidden = rows.length > 0;

  for (const r of rows) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${fmtTime(r.at)}</td>
      <td class="mono">${r.host ? escapeHtml(r.host) : '<em>无</em>'}</td>
      <td class="mono">${r.forwardedHost ? escapeHtml(r.forwardedHost) : '<em>无</em>'}</td>
      <td class="mono">${r.resolvedHost ? escapeHtml(r.resolvedHost) : '<em>空</em>'}</td>
      <td class="mono">${escapeHtml(r.path)}</td>
      <td><span class="check ${r.hit ? 'ok' : 'bad'}">${r.hit ? `命中 #${r.fileId}` : '未命中'}</span></td>`;
    tbody.append(tr);
  }
}

$('#btn-refresh-diag').addEventListener('click', loadDiagnostics);

document.addEventListener('tab:show', (e) => {
  if (e.detail === 'users') loadUsers();
  if (e.detail === 'diag') loadDiagnostics();
});
