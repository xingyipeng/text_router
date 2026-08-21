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

// —— 统一确认对话框（替代原生 confirm）——
function setupConfirm() {
  const dlg = $('#confirm-dialog');
  let resolveFn = null;
  const finish = (v) => {
    const r = resolveFn; resolveFn = null;
    dlg.close();
    if (r) r(v);
  };
  $('#confirm-ok').addEventListener('click', () => finish(true));
  $('#confirm-cancel').addEventListener('click', () => finish(false));
  dlg.addEventListener('close', () => {
    // ESC 或其它方式关闭都按取消处理
    const r = resolveFn; resolveFn = null;
    if (r) r(false);
  });
  return ({ title = '请确认', message = '', okText = '确认', danger = false } = {}) => {
    $('#confirm-title').textContent = title;
    $('#confirm-message').textContent = message;
    const ok = $('#confirm-ok');
    ok.textContent = okText;
    ok.classList.toggle('danger', danger);
    return new Promise((resolve) => { resolveFn = resolve; dlg.showModal(); });
  };
}
export const confirmDialog = setupConfirm();

// —— 统一输入对话框（替代原生 prompt）——
function setupPrompt() {
  const dlg = $('#prompt-dialog');
  const input = $('#prompt-input');
  let state = null; // { validate, resolve, settled }
  const finish = (v) => {
    if (!state || state.settled) return;
    state.settled = true;
    const r = state.resolve;
    state = null;
    dlg.close();
    r(v);
  };
  $('#prompt-ok').addEventListener('click', () => {
    if (!state) return;
    const err = state.validate ? state.validate(input.value) : '';
    if (err) { $('#prompt-error').textContent = err; return; }
    finish(input.value);
  });
  $('#prompt-cancel').addEventListener('click', () => finish(null));
  dlg.addEventListener('close', () => { if (state && !state.settled) finish(null); });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#prompt-ok').click(); });
  return ({ title = '', label = '', password = false, validate } = {}) => {
    $('#prompt-title').textContent = title;
    $('#prompt-label').textContent = label;
    $('#prompt-error').textContent = '';
    input.type = password ? 'password' : 'text';
    input.value = '';
    return new Promise((resolve) => {
      state = { validate, resolve, settled: false };
      dlg.showModal();
      input.focus();
    });
  };
}
export const promptDialog = setupPrompt();

function showLogin() {
  $('#login-view').hidden = false;
  $('#main-view').hidden = true;
}

export function showMain() {
  $('#login-view').hidden = true;
  $('#main-view').hidden = false;
  $('#me-name').textContent = personLabel(state.me.username, state.me.display_name);
  const av = $('#me-avatar');
  if (av) av.textContent = (state.me.display_name || state.me.username || '?').trim().charAt(0).toUpperCase();
  $('#tab-users').hidden = !state.me.is_super;
  $('#tab-backups').hidden = !state.me.is_super;
  $('#tab-settings').hidden = !state.me.is_super;
}

const TABS = {
  dashboard: '#panel-dashboard', rules: '#panel-rules', trash: '#panel-trash',
  users: '#panel-users', backups: '#panel-backups', settings: '#panel-settings',
  requests: '#panel-requests', help: '#panel-help',
};

let activeTab = null;

function tabFromHash() {
  const name = location.hash.replace(/^#\/?/, '');
  return TABS[name] ? name : 'dashboard';
}

function switchTab(name) {
  // 未知标签与非超管访问超管专属页时回落到默认页
  if (!TABS[name] || ((name === 'users' || name === 'backups' || name === 'settings') && !state.me?.is_super)) name = 'dashboard';
  const hash = `#/${name}`;
  if (location.hash !== hash) location.hash = hash; // 会异步触发 hashchange，由下方守卫去重
  if (name === activeTab) return;
  activeTab = name;
  $$('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  for (const [tab, panel] of Object.entries(TABS)) {
    $(panel).hidden = tab !== name;
  }
  // 页头标题跟随当前标签（纯展示）
  const titleBtn = $$('.tab').find((b) => b.dataset.tab === name);
  const titleEl = $('#page-title');
  if (titleBtn && titleEl) titleEl.textContent = titleBtn.textContent.trim();
  document.dispatchEvent(new CustomEvent('tab:show', { detail: name }));
}

function enterMain() {
  showMain();
  listeners.onEnterMain.forEach((fn) => fn());
  switchTab(tabFromHash());
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = new FormData(e.target);
  const submitBtn = e.target.querySelector('button[type="submit"]');
  $('#login-error').textContent = '';
  submitBtn.disabled = true;
  submitBtn.classList.add('loading');
  try {
    state.me = await api('/api/auth/login', {
      method: 'POST',
      body: { username: form.get('username'), password: form.get('password') },
    });
    enterMain();
  } catch (err) {
    $('#login-error').textContent = err.message;
  } finally {
    submitBtn.disabled = false;
    submitBtn.classList.remove('loading');
  }
});

$('#btn-help').addEventListener('click', () => switchTab('help'));

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
window.addEventListener('hashchange', () => switchTab(tabFromHash()));

// 侧边菜单收缩：只留图标，状态存 localStorage
{
  const KEY = 'wxr-sidebar-collapsed';
  const sidebar = $('.sidebar');
  const btn = $('#btn-collapse');
  const apply = (collapsed) => {
    sidebar.classList.toggle('collapsed', collapsed);
    const label = collapsed ? '展开菜单' : '收起菜单';
    btn.title = label;
    btn.setAttribute('aria-label', label);
  };
  btn.addEventListener('click', () => {
    apply(!sidebar.classList.contains('collapsed'));
    try { localStorage.setItem(KEY, sidebar.classList.contains('collapsed') ? '1' : '0'); } catch {}
  });
  let saved = false;
  try { saved = localStorage.getItem(KEY) === '1'; } catch {}
  apply(saved);
}

// 由 main.js 在所有模块注册完监听器之后调用，顺序不能提前
export async function boot() {
  try {
    state.me = await api('/api/auth/me');
    enterMain();
  } catch {
    showLogin();
  }
}
