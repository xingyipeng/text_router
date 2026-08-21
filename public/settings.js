import { $, api, toast } from './app.js';

// —— 统一设置（仅超管可见）：备份 + 会话 + 自检 + 请求记录 ——

async function loadSettings() {
  try {
    fill(await api('/api/settings'));
  } catch (err) {
    toast(err.message);
  }
}

// 以服务端返回的（校验后的）值为准回填
function fill(s) {
  $('#bk-enabled').checked = s.backup.enabled;
  $('#bk-time').value = s.backup.time;
  $('#bk-keep').value = s.backup.keep;
  $('#s-ttl').value = s.session.ttl_hours;
  $('#s-single').checked = s.session.single_session;
  $('#s-check-timeout').value = s.selfcheck.timeout_seconds;
  $('#s-log-capacity').value = s.requestlog.capacity;
}

$('#settings-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('#btn-save-settings');
  const errEl = $('#settings-error');
  errEl.textContent = '';
  btn.disabled = true;
  btn.classList.add('loading');
  try {
    const saved = await api('/api/settings', {
      method: 'PUT',
      body: {
        backup: {
          enabled: $('#bk-enabled').checked,
          time: $('#bk-time').value,
          keep: Number($('#bk-keep').value),
        },
        session: {
          ttl_hours: Number($('#s-ttl').value),
          single_session: $('#s-single').checked,
        },
        selfcheck: { timeout_seconds: Number($('#s-check-timeout').value) },
        requestlog: { capacity: Number($('#s-log-capacity').value) },
      },
    });
    fill(saved);
    toast(saved.backup.enabled ? `已保存；定时备份每天 ${saved.backup.time}` : '设置已保存');
  } catch (err) {
    errEl.textContent = err.message;
  } finally {
    btn.disabled = false;
    btn.classList.remove('loading');
  }
});

document.addEventListener('tab:show', (e) => {
  if (e.detail === 'settings') loadSettings();
});
