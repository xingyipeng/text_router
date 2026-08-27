import { $, $$, api, escapeHtml } from './app.js';

// 帮助面板：左侧列出 docs/ 里的 markdown 文档（按子目录分组），右侧用 marked 渲染。
// 内容来自服务器自身的 docs/ 文件（部署者可控），直接 innerHTML 不做 sanitize；
// 若未来允许用户上传文档，这里必须加上 sanitize。

let listLoaded = false;
let loadPromise = null;

async function loadList() {
  const nav = $('#help-list');
  nav.innerHTML = '<p class="help-note">加载中…</p>';
  let docs;
  try {
    docs = await api('/api/docs');
  } catch (err) {
    nav.innerHTML = `<p class="help-note error">${escapeHtml(err.message)}</p>`;
    return;
  }
  listLoaded = true;
  nav.innerHTML = '';
  if (docs.length === 0) {
    nav.innerHTML = '<p class="help-note">暂无文档，在 docs/ 目录放置 .md 文件即可</p>';
    $('#help-content').innerHTML = '';
    return;
  }
  let lastGroup;
  docs.forEach((d) => {
    if (d.group !== lastGroup) {
      lastGroup = d.group;
      if (d.group) {
        const head = document.createElement('div');
        head.className = 'help-group';
        head.textContent = d.group;
        nav.append(head);
      }
    }
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'help-item';
    btn.textContent = d.title;
    btn.dataset.id = d.id;
    btn.dataset.group = d.group;
    btn.addEventListener('click', () => showDoc(d.id, d.group));
    nav.append(btn);
  });
  const empty = document.createElement('p');
  empty.id = 'help-empty';
  empty.className = 'help-note';
  empty.hidden = true;
  empty.textContent = '无匹配文档';
  nav.append(empty);
  applyFilter($('#help-search').value);
  showDoc(docs[0].id, docs[0].group);
}

// 等待文档列表就绪（幂等：多次调用共享同一 Promise）
function ensureList() {
  if (listLoaded) return Promise.resolve();
  if (!loadPromise) loadPromise = loadList();
  return loadPromise;
}

// 按标题过滤条目；某组全部隐藏时隐藏该组头
function applyFilter(q) {
  q = q.trim().toLowerCase();
  const nav = $('#help-list');
  let visible = 0;
  let pendingGroup = null;
  let pendingGroupVisible = false;
  nav.querySelectorAll(':scope > *').forEach((el) => {
    if (el.classList.contains('help-group')) {
      if (pendingGroup) pendingGroup.hidden = !pendingGroupVisible;
      pendingGroup = el;
      pendingGroupVisible = false;
    } else if (el.classList.contains('help-item')) {
      const match = !q || el.textContent.toLowerCase().includes(q);
      el.hidden = !match;
      if (match) {
        visible++;
        if (pendingGroup) pendingGroupVisible = true;
      }
    }
  });
  if (pendingGroup) pendingGroup.hidden = !pendingGroupVisible;
  const emptyEl = $('#help-empty');
  if (emptyEl) emptyEl.hidden = visible > 0;
}

async function showDoc(id, group) {
  $$('.help-item').forEach((b) =>
    b.classList.toggle('active', b.dataset.id === id && b.dataset.group === group),
  );
  const box = $('#help-content');
  box.innerHTML = '<p class="help-note">加载中…</p>';
  const url = `/api/docs/${group ? `${encodeURIComponent(group)}/` : ''}${id}`;
  let doc;
  try {
    doc = await api(url);
  } catch (err) {
    box.innerHTML = `<p class="help-note error">${escapeHtml(err.message)}</p>`;
    return;
  }
  marked.setOptions({ gfm: true });
  box.innerHTML = marked.parse(doc.content);
}

// 切换到帮助面板并打开指定文档（规则对话框「?」入口）。
// 通过 location.hash 触发 switchTab（已在帮助页则直接继续），等待列表就绪后定位文档。
export async function openHelpDoc(id) {
  location.hash = '#/help';
  await ensureList();
  $('#help-search').value = '';
  applyFilter('');
  const btn = $$('.help-item').find((b) => b.dataset.id === id && !b.dataset.group);
  if (btn) {
    btn.click();
    return;
  }
  showDoc(id, ''); // 列表里没有时直接按根组打开
}

$('#help-search').addEventListener('input', (e) => applyFilter(e.target.value));

document.addEventListener('tab:show', (e) => {
  if (e.detail !== 'help') return;
  ensureList();
});
