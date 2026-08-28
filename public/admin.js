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
        ? `<button class="btn sm" data-act="edit-user">编辑</button>
           <button class="btn sm" data-act="restore-user">恢复</button>
           <button class="btn sm danger" data-act="delete-user">删除</button>`
        : `<button class="btn sm" data-act="edit-user">编辑</button>
           <button class="btn sm" data-act="reset-pw">重置密码</button>
           <button class="btn sm danger" data-act="disable-user">禁用</button>
           <button class="btn sm danger" data-act="delete-user">删除</button>`;
    tr.innerHTML = `
      <td class="mono">${escapeHtml(u.username)}</td>
      <td>${escapeHtml(u.display_name)}</td>
      <td>${u.is_super ? '超级管理员' : '普通用户'}</td>
      <td>${u.disabled_at ? '已禁用' : '正常'}</td>
      <td>${fmtTime(u.created_at)}</td>
      <td class="actions">${actions}</td>`;
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
  if (f.get('password') !== f.get('confirm_password')) {
    $('#user-error').textContent = '两次输入的密码不一致';
    return;
  }
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
    } else if (btn.dataset.act === 'delete-user') {
      const ok = await confirmDialog({
        title: '删除用户',
        message: `永久删除 ${username}？此操作不可恢复。`,
        okText: '删除',
        danger: true,
      });
      if (!ok) return;
      await api(`/api/users/${id}/permanent`, { method: 'DELETE' });
      toast('用户已删除');
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

// —— 请求记录面板（持久化日志：完整 URL + 详情 + 分页）——

let reqRows = []; // 当前页数据（详情弹窗取用）
let reqBefore; // 当前页最旧一条的 id；undefined = 最新页
const reqStack = []; // 「上一页」回退栈

async function loadRequestLog() {
  const panel = $('#panel-requests');
  panel.classList.add('loading');
  let data;
  try {
    data = await api(`/api/request-log?limit=200${reqBefore !== undefined ? `&before=${reqBefore}` : ''}`);
  } finally {
    panel.classList.remove('loading');
  }
  const { rows, total, hasMore } = data;
  reqRows = rows;
  const tbody = $('#requests-table tbody');
  tbody.innerHTML = '';
  $('#panel-requests .empty').hidden = rows.length > 0;

  rows.forEach((r, i) => {
    const tr = document.createElement('tr');
    tr.style.setProperty('--i', i); // 行入场错峰（纯展示）
    const url = `${r.scheme || 'http'}://${r.resolvedHost || r.host}${r.path}`;
    tr.innerHTML = `
      <td>${fmtTime(r.at)}</td>
      <td class="td-url"><span class="req-url mono" title="${escapeHtml(url)}">${escapeHtml(url)}</span></td>
      <td><span class="check ${r.hit ? 'ok' : 'bad'}">${r.hit ? '命中' : '未命中'}</span></td>
      <td><button type="button" class="btn sm" data-act="req-detail" data-id="${r.id}">详情</button></td>`;
    tbody.append(tr);
  });

  $('#btn-req-prev').disabled = reqStack.length === 0;
  $('#btn-req-next').disabled = !hasMore;
  $('#req-total').textContent = total ? `共 ${total} 条` : '';
}

$('#btn-refresh-requests').addEventListener('click', () => {
  reqBefore = undefined; // 刷新回到最新一页
  reqStack.length = 0;
  loadRequestLog();
});

$('#btn-req-next').addEventListener('click', () => {
  if (!reqRows.length) return;
  reqStack.push(reqBefore);
  reqBefore = reqRows[reqRows.length - 1].id;
  loadRequestLog();
});

$('#btn-req-prev').addEventListener('click', () => {
  reqBefore = reqStack.pop();
  loadRequestLog();
});

// 详情弹窗：行数据已在列表 JSON 里，就地渲染
function openReqDetail(r) {
  const url = `${r.scheme || 'http'}://${r.resolvedHost || r.host}${r.path}`;
  $('#rd-url').textContent = url;
  $('#rd-url').title = url;
  $('#rd-at').textContent = new Date(r.at).toLocaleString('zh-CN', { hour12: false });
  $('#rd-method').textContent = r.method || '—';
  $('#rd-scheme').textContent = r.scheme || '—';
  $('#rd-host').textContent = r.host || '—';
  $('#rd-fwd').textContent = r.forwardedHost || '—';
  $('#rd-resolved').textContent = r.resolvedHost || '—';
  $('#rd-path').textContent = r.path;
  $('#rd-ua').textContent = r.ua || '—';
  $('#rd-ip').textContent = r.ip || '—';
  $('#rd-remote').textContent = r.remoteIp || '—';
  $('#rd-hit').innerHTML = r.hit
    ? `<span class="check ok">命中 #${r.fileId ?? ''}</span>`
    : '<span class="check bad">未命中</span>';
  $('#req-detail-dialog').showModal();
}

$('#requests-table tbody').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-act="req-detail"]');
  if (!btn) return;
  const r = reqRows.find((x) => String(x.id) === btn.dataset.id);
  if (r) openReqDetail(r);
});

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // http 环境 clipboard API 不可用时的降级
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
    document.body.append(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
    return ok;
  }
}

$('#btn-rd-copy').addEventListener('click', async () => {
  const ok = await copyText($('#rd-url').textContent);
  toast(ok ? '完整 URL 已复制' : '复制失败，请手动选择复制');
});

$('#btn-clear-requests').addEventListener('click', async () => {
  const ok = await confirmDialog({
    title: '清空请求记录',
    message: '将清空全部持久化请求记录与内存统计，此操作不可撤销。',
    okText: '清空',
    danger: true,
  });
  if (!ok) return;
  try {
    await api('/api/request-log/clear', { method: 'POST' });
    toast('请求记录已清空');
    reqBefore = undefined;
    reqStack.length = 0;
    loadRequestLog();
  } catch (err) {
    toast(err.message);
  }
});

document.addEventListener('tab:show', (e) => {
  if (e.detail === 'users') loadUsers();
  if (e.detail === 'requests') loadRequestLog();
});
