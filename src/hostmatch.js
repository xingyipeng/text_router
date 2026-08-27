// 域名模式匹配：标签比较实现 glob（无正则、无 ReDoS）。
// 模式语法（gitignore 惯例）：
//   *   恰占一个整段标签（单层子域）
//   **  任意层标签（含 0 层，即域名本身）
//   单独 * 表示全局（匹配所有域名，含空 host）
// 例：*.example.com 匹配 a.example.com，不匹配 example.com、a.b.example.com
//     **.example.com 匹配 example.com、a.example.com、a.b.example.com

import { normalizeHost } from './validate.js';

const LABEL_RE = /^[a-z0-9_-]{1,63}$/;

export function isPattern(host) {
  return typeof host === 'string' && host.includes('*');
}

// 回溯标签比较；k 个 ** 对上 n 个标签最坏 C(n+k,k) 条路径，
// 但模式与 host 标签数都很小（规则行数量级），无需记忆化
function matchFrom(pi, hi, p, h) {
  if (pi === p.length) return hi === h.length;
  const pl = p[pi];
  if (pl === '**') {
    for (let k = hi; k <= h.length; k++) {
      if (matchFrom(pi + 1, k, p, h)) return true;
    }
    return false;
  }
  if (hi === h.length) return false;
  if (pl === '*' || pl === h[hi]) return matchFrom(pi + 1, hi + 1, p, h);
  return false;
}

export function matchHost(pattern, host) {
  const p = typeof pattern === 'string' ? pattern : '';
  const h = typeof host === 'string' ? host : '';
  if (p === '*') return true; // 全局：命中所有（含空 host）
  return matchFrom(0, 0, p.toLowerCase().split('.'), h === '' ? [] : h.toLowerCase().split('.'));
}

// 保存/导入时的校验 + 归一化。返回 { ok, value } 或 { ok, error }。
export function normalizePattern(raw) {
  if (typeof raw !== 'string') return { ok: false, error: '域名必须是字符串' };
  // 与 normalizeHost 习惯一致：取逗号首段、trim、小写、去尾点
  let h = raw.split(',')[0].trim().toLowerCase().replace(/\.+$/, '');
  if (!h) return { ok: true, value: '*' };
  if (h.includes('*')) {
    if (h.length > 255) return { ok: false, error: '域名模式总长不能超过 255' };
    if (/[:\[\]]/.test(h)) return { ok: false, error: '模式中不允许端口或方括号' };
    for (const l of h.split('.')) {
      if (l !== '*' && l !== '**' && !LABEL_RE.test(l)) {
        return {
          ok: false,
          error: `非法域名模式「${raw}」：每段只能是 *、** 或 1-63 位小写字母/数字/下划线/连字符（不支持 a*、*** 等写法）`,
        };
      }
    }
    if (h.split('.').every((l) => l === '**')) return { ok: true, value: '*' }; // 单独 ** 归一化为 *
    return { ok: true, value: h };
  }
  return { ok: true, value: normalizeHost(h) };
}

export function isValidPriority(v) {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 1000;
}

// 具体度分层：精确 > * 模式 > ** 模式 > 全局（数值越大越具体）
function specificity(host) {
  if (host === '*') return 0;
  if (host.includes('**')) return 1;
  if (host.includes('*')) return 2;
  return 3;
}

// 排序比较器：胜者排前（返回负数表示 a 赢）。
// priority 大者 > 具体度高者 > 先建者（id 小）
export function compareRules(a, b) {
  if (b.priority !== a.priority) return b.priority - a.priority;
  const d = specificity(b.host) - specificity(a.host);
  if (d !== 0) return d;
  return a.id - b.id;
}

// 两个模式是否有共同可命中的域名（仅自检用）。
// BFS：状态 (i,j) 为双方标签游标；「**」可零成本前移；
// 每次消费一个候选标签 c ∈ 双方字面量 ∪ {占位标签}（* 必消费、字面量须相等）。
export function patternIntersects(a, b) {
  if (a === '*' || b === '*') return true;
  const pa = a.split('.');
  const pb = b.split('.');
  const literals = new Set([...pa, ...pb].filter((l) => l !== '*' && l !== '**'));
  let placeholder = 'x';
  while (literals.has(placeholder)) placeholder += 'x';
  const candidates = [...literals, placeholder];
  const seen = new Set();
  const queue = [[0, 0]];
  const stepSide = (i, p, c) => {
    if (i === p.length) return null; // 该侧已走完，无法再消费标签
    const l = p[i];
    if (l === '**') return [i, i + 1];
    if (l === '*') return [i + 1];
    return l === c ? [i + 1] : null;
  };
  while (queue.length) {
    const [i, j] = queue.shift();
    if (i === pa.length && j === pb.length) return true;
    const key = `${i},${j}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (pa[i] === '**') queue.push([i + 1, j]); // ** 消费 0 层
    if (pb[j] === '**') queue.push([i, j + 1]);
    for (const c of candidates) {
      const ai = stepSide(i, pa, c);
      const bj = stepSide(j, pb, c);
      if (ai === null || bj === null) continue;
      for (const ni of ai) {
        for (const nj of bj) queue.push([ni, nj]);
      }
    }
  }
  return false;
}
