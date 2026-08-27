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
    renderMainDomains(s.files.byMainDomain);
    renderRuleHosts(s.files.byRuleHost);
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

  const W = 600, H = 180, PL = 40, PR = 10, PT = 14, AXIS = 24; // 左侧刻度区 40px
  const innerW = W - PL - PR;
  const rawMax = Math.max(...hours.map((h) => h.count), 1);
  // 1/2/2.5/5 × 10^k 步进取整刻度（如最大值 7 → 刻度 0/2/4/6/8）
  const mag = 10 ** Math.floor(Math.log10(rawMax));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s * 4 >= rawMax);
  const yMax = 4 * step;
  const x = (i) => PL + (innerW * i) / (hours.length - 1);
  const y = (c) => H - AXIS - (c / yMax) * (H - AXIS - PT);
  const pts = hours.map((h, i) => [x(i), y(h.count)]);
  const line = pts.map(([px, py], i) => `${i ? 'L' : 'M'}${px.toFixed(1)},${py.toFixed(1)}`).join(' ');
  const area = `${line} L${x(hours.length - 1).toFixed(1)},${H - AXIS} L${PL},${H - AXIS} Z`;

  const fmt = (v) => (Number.isInteger(v) ? String(v) : v.toFixed(1));
  // 4 条网格线（1/4 步进）左端标数值，基线不标
  const grid = [0, 1, 2, 3, 4].map((k) => {
    const gy = y(yMax * (k / 4)).toFixed(1);
    const val = fmt(yMax * (k / 4));
    return k === 0
      ? `<line class="trend-grid" x1="${PL}" y1="${gy}" x2="${W - PR}" y2="${gy}"/>`
      : `<line class="trend-grid" x1="${PL}" y1="${gy}" x2="${W - PR}" y2="${gy}"/>
         <text x="${PL - 6}" y="${gy}" class="trend-y-label" dy="0.32em">${val}</text>`;
  }).join('');
  const labels = hours
    .filter((_, i) => i % 6 === 0)
    .map((h, i) =>
      `<text x="${x(i * 6).toFixed(1)}" y="${H - 7}" class="trend-label">${h.hour}:00</text>`)
    .join('');
  // 数据点数值：count > 0 的点上方标小字（零点贴着轴线不标）
  const pointLabels = hours
    .map((h, i) => h.count > 0
      ? `<text x="${x(i).toFixed(1)}" y="${(y(h.count) - 6).toFixed(1)}" class="trend-point-label" text-anchor="middle">${h.count}</text>`
      : '')
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
    ${pointLabels}
    ${labels}`;
}

// 手工环形图：蓝色系柔和分段
const COLORS = ['#2563eb', '#60a5fa', '#93c5fd', '#818cf8', '#a5b4fc', '#94a3b8', '#cbd5e1'];

function renderMainDomains(rows) {
  const box = $('#dash-domains');
  if (!rows.length) {
    box.innerHTML = '<p class="empty">暂无绑定域名的记录</p>';
    return;
  }
  const total = rows.reduce((s, r) => s + r.count, 0);
  if (!total) {
    box.innerHTML = '<p class="empty">暂无绑定域名的记录</p>';
    return;
  }

  const R = 54, C = 2 * Math.PI * R;
  let acc = 0;
  const segs = rows.map((r, i) => {
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
        <svg viewBox="0 0 140 140" width="134" height="134" role="img" aria-label="主域名分布环形图">
          <circle cx="70" cy="70" r="${R}" fill="none" stroke="#eef2f8" stroke-width="17"/>
          ${segs}
          <text x="70" y="66" text-anchor="middle" class="donut-total">${total}</text>
          <text x="70" y="84" text-anchor="middle" class="donut-cap">主域名</text>
        </svg>
      </div>
      <div class="domain-legend">
        ${rows.map((r, i) => `
          <div class="domain-row">
            <span class="domain-dot" style="background:${COLORS[i % COLORS.length]}"></span>
            <span class="domain-host mono">${escapeHtml(r.host)}</span>
            <span class="domain-count">${r.count}</span>
          </div>`).join('')}
      </div>
    </div>`;
}

// 按规则视图：域名按原样列出（含通配模式），一条不隐藏
function renderRuleHosts(rows) {
  const box = $('#dash-rule-hosts');
  if (!rows.length) return;
  box.innerHTML = `
    <h3 class="domain-subtitle">按规则（含通配模式）</h3>
    <div class="domain-legend">
      ${rows.map((r, i) => `
        <div class="domain-row">
          <span class="domain-dot" style="background:${COLORS[i % COLORS.length]}"></span>
          <span class="domain-host mono">${escapeHtml(r.host)}</span>
          <span class="domain-count">${r.count}</span>
        </div>`).join('')}
    </div>`;
}

document.addEventListener('tab:show', (e) => {
  if (e.detail === 'dashboard') loadDashboard();
});
