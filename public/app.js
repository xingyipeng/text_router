export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export const state = { me: null };
export const listeners = { onEnterMain: [] };

export async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  // 登录接口的 401 含义是"凭据不对"，不是"会话过期"。
  // 若一并拦截，会把服务端准确的错误文案盖成一句无用的"未登录"，
  // 而且会在用户本就停留的登录页上再触发一次跳转。
  if (res.status === 401 && path !== '/api/auth/login') {
    state.me = null;
    showLogin();
    throw new Error('登录已失效，请重新登录');
  }

  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(data?.error || `请求失败（HTTP ${res.status}）`);
  return data;
}

export function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => { el.hidden = true; }, 2600);
}

export function fmtTime(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function personLabel(username, displayName) {
  if (!username) return '—';
  return displayName && displayName !== username ? `${displayName}（${username}）` : username;
}

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g,
    (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function showLogin() {
  $('#login-view').hidden = false;
  $('#main-view').hidden = true;
}

function showMain() {
  $('#login-view').hidden = true;
  $('#main-view').hidden = false;
  $('#me-name').textContent = personLabel(state.me.username, state.me.display_name);
  $('#tab-users').hidden = !state.me.is_super;
}

function switchTab(name) {
  $$('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  for (const [tab, panel] of Object.entries({
    files: '#panel-files', trash: '#panel-trash', users: '#panel-users', diag: '#panel-diag',
  })) {
    $(panel).hidden = tab !== name;
  }
  document.dispatchEvent(new CustomEvent('tab:show', { detail: name }));
}

function enterMain() {
  showMain();
  listeners.onEnterMain.forEach((fn) => fn());
  switchTab('files');
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = new FormData(e.target);
  $('#login-error').textContent = '';
  try {
    state.me = await api('/api/auth/login', {
      method: 'POST',
      body: { username: form.get('username'), password: form.get('password') },
    });
    enterMain();
  } catch (err) {
    $('#login-error').textContent = err.message;
  }
});

$('#btn-logout').addEventListener('click', async () => {
  await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
  state.me = null;
  showLogin();
});

$('#btn-password').addEventListener('click', () => {
  $('#password-error').textContent = '';
  $('#password-form').reset();
  $('#password-dialog').showModal();
});
$('#password-cancel').addEventListener('click', () => $('#password-dialog').close());

$('#password-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = new FormData(e.target);
  $('#password-error').textContent = '';
  try {
    await api('/api/auth/password', {
      method: 'POST',
      body: {
        old_password: form.get('old_password'),
        new_password: form.get('new_password'),
      },
    });
    $('#password-dialog').close();
    e.target.reset();
    toast('密码已修改，其他设备上的登录已失效');
  } catch (err) {
    $('#password-error').textContent = err.message;
  }
});

$$('.tab').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));

// 由 main.js 在所有模块注册完监听器之后调用，顺序不能提前
export async function boot() {
  try {
    state.me = await api('/api/auth/me');
    enterMain();
  } catch {
    showLogin();
  }
}
