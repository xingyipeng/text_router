// 单一入口：先让 files/admin 模块把监听器注册上，再启动。
// 用三个独立的 <script type="module"> 是不行的 —— app.js 的模块体会先于
// files.js 执行完，启动时 listeners.onEnterMain 还是空的，列表永远不加载。
import { boot } from './app.js';
import './files.js';
import './admin.js';

boot();
