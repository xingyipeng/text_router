import { $, $$, api, escapeHtml } from './app.js';

// 帮助面板：左侧列出 docs/ 里的 markdown 文档，右侧用 marked 渲染。
// 内容来自服务器自身的 docs/ 文件（部署者可控），直接 innerHTML 不做 sanitize；
// 若未来允许用户上传文档，这里必须加上 sanitize。

let listLoaded = false;

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
  docs.forEach((d) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'help-item';
    btn.textContent = d.title;
    btn.dataset.id = d.id;
    btn.addEventListener('click', () => showDoc(d.id));
    nav.append(btn);
  });
  showDoc(docs[0].id);
}

async function showDoc(id) {
  $$('.help-item').forEach((b) => b.classList.toggle('active', b.dataset.id === id));
  const box = $('#help-content');
  box.innerHTML = '<p class="help-note">加载中…</p>';
  let doc;
  try {
    doc = await api(`/api/docs/${id}`);
  } catch (err) {
    box.innerHTML = `<p class="help-note error">${escapeHtml(err.message)}</p>`;
    return;
  }
  marked.setOptions({ gfm: true });
  box.innerHTML = marked.parse(doc.content);
}

document.addEventListener('tab:show', (e) => {
  if (e.detail !== 'help') return;
  if (!listLoaded) loadList();
});
