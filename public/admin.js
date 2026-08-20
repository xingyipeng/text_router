import { $, api, state, toast, fmtTime, escapeHtml, confirmDialog, promptDialog, showMain } from './app.js';

// —— 用户管理 ——

async function loadUsers() {
  if (!state.me?.is_super) return;
  const includeDisabled = $('#u-show-disabled').checked;
  const panel = $('#panel-users');
  panel.classList.add('loading');
  let rows;
  try {
    rows = await api(`/api/users?include_disabled=${includeDisabled ? 1 : 0}`);
  } finally {
    panel.classList.remove('loading');
  }
  const tbody = $('#users-table tbody');
  tbody.innerHTML = '';
  $('#panel-users .empty').hidden = rows.length > 0;

  rows.forEach((u, i) => {
    const tr = document.createElement('tr');
    tr.style.setProperty('--i', i); // 行入场错峰（纯展示）
    if (u.disabled_at) tr.className = 'deleted';
    const actions = u.is_super
      ? '<button class="btn sm" data-act="edit-user">编辑</button><span class="hint">超管不可禁用</span>'
      : u.disabled_at
        ? '<button class="btn sm" data-act="edit-user">编辑</button><button class="btn sm" data-act="restore-user">恢复</button>'
        : `<button class="btn sm" data-act="edit-user">编辑</button>
           <button class="btn sm" data-act="reset-pw">重置密码</button>
           <button class="btn sm danger" data-act="disable-user">禁用</button>`;
    tr.innerHTML = `
      <td class="mono">${escapeHtml(u.username)}</td>
      <td>${escapeHtml(u.display_name)}</td>
      <td>${u.is_super ? '超级管理员' : '普通用户'}</td>
      <td>${u.disabled_at ? '已禁用' : '正常'}</td>
      <td>${fmtTime(u.created_at)}</td>
      <td>${actions}</td>`;
    tr.dataset.id = u.id;
    tr.dataset.username = u.username;
    tr.dataset.displayName = u.display_name;
    tbody.append(tr);
  });
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

// —— 编辑用户信息（显示名 / 用户名） ——
let editingUserId = null;
$('#user-edit-cancel').addEventListener('click', () => $('#user-edit-dialog').close());

$('#user-edit-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  $('#user-edit-error').textContent = '';
  try {
    const user = await api(`/api/users/${editingUserId}`, {
      method: 'PUT',
      body: {
        username: f.get('username').trim(),
        display_name: f.get('display_name').trim(),
      },
    });
    $('#user-edit-dialog').close();
    toast('已保存');
    // 改的是自己：同步顶栏显示
    if (user.id === state.me?.id) {
      state.me.username = user.username;
      state.me.display_name = user.display_name;
      showMain();
    }
    loadUsers();
  } catch (err) {
    $('#user-edit-error').textContent = err.message;
  }
});

$('#users-table').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const tr = btn.closest('tr');
  const { id, username } = tr.dataset;

  try {
    if (btn.dataset.act === 'edit-user') {
      const f = $('#user-edit-form');
      f.username.value = tr.dataset.username;
      f.display_name.value = tr.dataset.displayName ?? '';
      $('#user-edit-error').textContent = '';
      editingUserId = Number(id);
      $('#user-edit-dialog').showModal();
      return;
    }

    if (btn.dataset.act === 'disable-user') {
      const ok = await confirmDialog({
        title: '禁用用户',
        message: `禁用 ${username}？该用户将立即被踢下线，但其创建的记录归属会保留。`,
        okText: '禁用',
        danger: true,
      });
      if (!ok) return;
      await api(`/api/users/${id}`, { method: 'DELETE' });
      toast('已禁用');
    } else if (btn.dataset.act === 'restore-user') {
      await api(`/api/users/${id}/restore`, { method: 'POST' });
      toast('已恢复');
    } else if (btn.dataset.act === 'reset-pw') {
      const pw = await promptDialog({
        title: '重置密码',
        label: `为 ${username} 设置新密码（至少 8 位）`,
        password: true,
        validate: (v) => (v.length < 8 ? '密码至少需要 8 位' : ''),
      });
      if (!pw) return;
      await api(`/api/users/${id}/password`, { method: 'POST', body: { new_password: pw } });
      toast('密码已重置，该用户已被踢下线');
    }
    loadUsers();
  } catch (err) {
    toast(err.message);
  }
});

// —— 请求记录面板 ——

async function loadRequestLog() {
  const panel = $('#panel-requests');
  panel.classList.add('loading');
  let rows;
  try {
    rows = await api('/api/request-log');
  } finally {
    panel.classList.remove('loading');
  }
  const tbody = $('#requests-table tbody');
  tbody.innerHTML = '';
  $('#panel-requests .empty').hidden = rows.length > 0;

  rows.forEach((r, i) => {
    const tr = document.createElement('tr');
    tr.style.setProperty('--i', i); // 行入场错峰（纯展示）
    tr.innerHTML = `
      <td>${fmtTime(r.at)}</td>
      <td class="mono">${r.host ? escapeHtml(r.host) : '<em>无</em>'}</td>
      <td class="mono">${r.forwardedHost ? escapeHtml(r.forwardedHost) : '<em>无</em>'}</td>
      <td class="mono">${r.resolvedHost ? escapeHtml(r.resolvedHost) : '<em>空</em>'}</td>
      <td class="mono">${escapeHtml(r.path)}</td>
      <td><span class="check ${r.hit ? 'ok' : 'bad'}">${r.hit ? `命中 #${r.fileId}` : '未命中'}</span></td>`;
    tbody.append(tr);
  });
}

$('#btn-refresh-requests').addEventListener('click', loadRequestLog);

document.addEventListener('tab:show', (e) => {
  if (e.detail === 'users') loadUsers();
  if (e.detail === 'requests') loadRequestLog();
});
