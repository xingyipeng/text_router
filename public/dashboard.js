import { $, api, escapeHtml } from './app.js';

// —— 汇总看板 ——

async function loadDashboard() {
  const panel = $('#panel-dashboard');
  try {
    const s = await api('/api/stats');
    $('#dash-total').textContent = s.files.total;
    $('#dash-total-sub').textContent = `${s.files.bound} 个绑定域名 · ${s.files.global} 个全局`;
    $('#dash-active').textContent = s.files.bound;
    $('#dash-today').textContent = s.requests.today;
    $('#dash-hits').textContent = s.requests.todayHits;
    $('#dash-misses').textContent = s.requests.todayMisses;
    renderTrend(s.requests.byHour);
    renderDomains(s.files.byDomain);
  } finally {
    // 数据就绪后关闭骨架微光（纯展示）
    panel.classList.add('loaded');
  }
}

function renderTrend(hours) {
  const svg = $('#dash-trend');
  const hasData = hours.some((h) => h.count > 0);
  $('#dash-trend-empty').hidden = hasData;
  svg.hidden = !hasData;
  if (!hasData) return;

  const W = 600, H = 180, PAD = 10, AXIS = 24;
  const max = Math.max(...hours.map((h) => h.count), 1);
  const step = (W - PAD * 2) / (hours.length - 1);
  const x = (i) => PAD + i * step;
  const y = (c) => H - AXIS - (c / max) * (H - AXIS - PAD);
  const pts = hours.map((h, i) => [x(i), y(h.count)]);
  const line = pts.map(([px, py], i) => `${i ? 'L' : 'M'}${px.toFixed(1)},${py.toFixed(1)}`).join(' ');
  const area = `${line} L${x(hours.length - 1).toFixed(1)},${H - AXIS} L${PAD},${H - AXIS} Z`;

  // 水平参考网格线（4 档）
  const grid = [0.25, 0.5, 0.75, 1]
    .map((f) => `<line class="trend-grid" x1="${PAD}" y1="${y(max * f).toFixed(1)}" x2="${W - PAD}" y2="${y(max * f).toFixed(1)}"/>`)
    .join('');
  const labels = hours
    .filter((_, i) => i % 6 === 0)
    .map((h, i) =>
      `<text x="${x(i * 6).toFixed(1)}" y="${H - 7}" class="trend-label">${h.hour}:00</text>`)
    .join('');
  const last = pts[pts.length - 1];

  svg.innerHTML = `
    <defs><linearGradient id="trend-fill" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#2563eb" stop-opacity=".18"/>
      <stop offset="1" stop-color="#2563eb" stop-opacity="0"/>
    </linearGradient></defs>
    ${grid}
    <path d="${area}" fill="url(#trend-fill)"/>
    <path d="${line}" fill="none" stroke="#2563eb" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
    <circle cx="${last[0].toFixed(1)}" cy="${last[1].toFixed(1)}" r="4" fill="#2563eb" stroke="#fff" stroke-width="2"/>
    ${labels}`;
}

function renderDomains(rows) {
  const box = $('#dash-domains');
  if (!rows.length) {
    box.innerHTML = '<p class="empty">暂无绑定域名的记录</p>';
    return;
  }
  const sorted = [...rows].sort((a, b) => b.count - a.count);
  const total = sorted.reduce((s, r) => s + r.count, 0);
  if (!total) {
    box.innerHTML = '<p class="empty">暂无绑定域名的记录</p>';
    return;
  }

  // 手工环形图：蓝色系柔和分段
  const COLORS = ['#2563eb', '#60a5fa', '#93c5fd', '#818cf8', '#a5b4fc', '#94a3b8', '#cbd5e1'];
  const R = 54, C = 2 * Math.PI * R;
  let acc = 0;
  const segs = sorted.map((r, i) => {
    const frac = r.count / total;
    const seg = `<circle cx="70" cy="70" r="${R}" fill="none"
      stroke="${COLORS[i % COLORS.length]}" stroke-width="17"
      stroke-dasharray="${(frac * C).toFixed(2)} ${C.toFixed(2)}"
      stroke-dashoffset="${(-acc * C).toFixed(2)}"
      transform="rotate(-90 70 70)"/>`;
    acc += frac;
    return seg;
  }).join('');

  box.innerHTML = `
    <div class="domain-chart">
      <div class="domain-donut">
        <svg viewBox="0 0 140 140" width="134" height="134" role="img" aria-label="域名分布环形图">
          <circle cx="70" cy="70" r="${R}" fill="none" stroke="#eef2f8" stroke-width="17"/>
          ${segs}
          <text x="70" y="66" text-anchor="middle" class="donut-total">${total}</text>
          <text x="70" y="84" text-anchor="middle" class="donut-cap">绑定域名</text>
        </svg>
      </div>
      <div class="domain-legend">
        ${sorted.map((r, i) => `
          <div class="domain-row">
            <span class="domain-dot" style="background:${COLORS[i % COLORS.length]}"></span>
            <span class="domain-host mono">${escapeHtml(r.host)}</span>
            <span class="domain-count">${r.count}</span>
          </div>`).join('')}
      </div>
    </div>`;
}

document.addEventListener('tab:show', (e) => {
  if (e.detail === 'dashboard') loadDashboard();
});
