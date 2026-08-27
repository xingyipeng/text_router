import { describe, it, expect } from 'vitest';
import {
  matchHost, patternIntersects, compareRules, isPattern, normalizePattern, isValidPriority,
} from '../src/hostmatch.js';

describe('matchHost', () => {
  it('精确域名只匹配自身', () => {
    expect(matchHost('example.com', 'example.com')).toBe(true);
    expect(matchHost('example.com', 'www.example.com')).toBe(false);
  });

  it('全局 * 命中所有，含空 host', () => {
    expect(matchHost('*', 'anything.com')).toBe(true);
    expect(matchHost('*', '')).toBe(true);
  });

  it('* 单层：恰占一个整段标签', () => {
    expect(matchHost('*.example.com', 'www.example.com')).toBe(true);
    expect(matchHost('*.example.com', 'example.com')).toBe(false);
    expect(matchHost('*.example.com', 'a.b.example.com')).toBe(false);
  });

  it('** 任意层（含 0 层）', () => {
    expect(matchHost('**.example.com', 'example.com')).toBe(true);
    expect(matchHost('**.example.com', 'a.example.com')).toBe(true);
    expect(matchHost('**.example.com', 'a.b.example.com')).toBe(true);
    expect(matchHost('**.example.com', 'other.com')).toBe(false);
  });

  it('单独 ** 等价全局', () => {
    expect(matchHost('**', '')).toBe(true);
    expect(matchHost('**', 'a.b.com')).toBe(true);
  });

  it('中间段通配', () => {
    expect(matchHost('a.*.com', 'a.b.com')).toBe(true);
    expect(matchHost('a.*.com', 'a.com')).toBe(false);
    expect(matchHost('a.*.com', 'a.b.c.com')).toBe(false);
  });

  it('* 与 ** 混用：*.** 表示至少一层子域', () => {
    expect(matchHost('*.**.example.com', 'a.example.com')).toBe(true);
    expect(matchHost('*.**.example.com', 'a.b.example.com')).toBe(true);
    expect(matchHost('*.**.example.com', 'x.y.z.example.com')).toBe(true);
    expect(matchHost('*.**.example.com', 'example.com')).toBe(false);
  });

  it('host 大小写不敏感，空 host 不命中非全局模式', () => {
    expect(matchHost('example.com', 'EXAMPLE.COM')).toBe(true);
    expect(matchHost('*.example.com', '')).toBe(false);
  });

  it('pattern 大小写不敏感', () => {
    expect(matchHost('Example.COM', 'example.com')).toBe(true);
  });
});

describe('isPattern', () => {
  it('含 * 才算模式', () => {
    expect(isPattern('*.example.com')).toBe(true);
    expect(isPattern('*')).toBe(true);
    expect(isPattern('example.com')).toBe(false);
  });
});

describe('normalizePattern', () => {
  it('空串与空白归一化为全局 *', () => {
    expect(normalizePattern('')).toEqual({ ok: true, value: '*' });
    expect(normalizePattern('  ')).toEqual({ ok: true, value: '*' });
  });

  it('非模式走 normalizeHost（小写/去端口/去尾点）', () => {
    expect(normalizePattern('A.COM:8080')).toEqual({ ok: true, value: 'a.com' });
    expect(normalizePattern('Example.COM.')).toEqual({ ok: true, value: 'example.com' });
  });

  it('模式统一小写并去尾点', () => {
    expect(normalizePattern('*.Example.COM.')).toEqual({ ok: true, value: '*.example.com' });
  });

  it('相邻整段通配合法', () => {
    expect(normalizePattern('*.*.com')).toEqual({ ok: true, value: '*.*.com' });
  });

  it('单独 ** 归一化为 *', () => {
    expect(normalizePattern('**')).toEqual({ ok: true, value: '*' });
    expect(normalizePattern('**.')).toEqual({ ok: true, value: '*' });
  });

  it('**.** 归一化为 *', () => {
    expect(normalizePattern('**.**')).toEqual({ ok: true, value: '*' });
  });

  it('非法模式拒绝：半段/叠加通配、端口、方括号', () => {
    for (const bad of ['a*.example.com', '***.example.com', '*.example.com:8080', '*.ex[ample.com']) {
      expect(normalizePattern(bad).ok, bad).toBe(false);
    }
  });

  it('非模式域名中的方括号（字符类/IPv6 写法）拒绝，不静默截断', () => {
    for (const bad of ['[0-9a-z].example.com', '[a-z]*.com', '[::1]']) {
      expect(normalizePattern(bad).ok, bad).toBe(false);
    }
  });

  it('标签长度 1-63 位', () => {
    expect(normalizePattern(`*.${'a'.repeat(63)}.com`).ok).toBe(true);
    expect(normalizePattern(`*.${'a'.repeat(64)}.com`).ok).toBe(false);
  });

  it('模式总长超过 255 拒绝', () => {
    expect(normalizePattern(`*.${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(63)}.com`).ok).toBe(false);
  });

  it('非字符串拒绝', () => {
    expect(normalizePattern(123).ok).toBe(false);
  });
});

describe('isValidPriority', () => {
  it('0-1000 整数合法，其余非法', () => {
    expect(isValidPriority(0)).toBe(true);
    expect(isValidPriority(1000)).toBe(true);
    expect(isValidPriority(-1)).toBe(false);
    expect(isValidPriority(1001)).toBe(false);
    expect(isValidPriority(1.5)).toBe(false);
    expect(isValidPriority('5')).toBe(false);
    expect(isValidPriority(undefined)).toBe(false);
  });
});

describe('compareRules', () => {
  it('priority 大者胜，与具体度无关', () => {
    const a = { id: 1, host: 'a.com', priority: 5 };
    const b = { id: 2, host: '*', priority: 9 };
    expect(compareRules(a, b)).toBeGreaterThan(0); // b 排前
    expect(compareRules(b, a)).toBeLessThan(0);
  });

  it('同 priority 时具体度：精确 > * 模式 > ** 模式 > 全局', () => {
    const exact = { id: 4, host: 'a.com', priority: 0 };
    const star = { id: 3, host: '*.a.com', priority: 0 };
    const dstar = { id: 2, host: '**.a.com', priority: 0 };
    const global = { id: 1, host: '*', priority: 0 };
    const sorted = [global, star, dstar, exact].sort(compareRules).map((r) => r.host);
    expect(sorted).toEqual(['a.com', '*.a.com', '**.a.com', '*']);
  });

  it('同 priority 同具体度时先建者（id 小）胜', () => {
    const old = { id: 1, host: '*.a.com', priority: 0 };
    const young = { id: 2, host: '*.a.com', priority: 0 };
    expect([young, old].sort(compareRules)[0].id).toBe(1);
  });

  it('同时含 * 与 ** 的模式按 ** 层计具体度', () => {
    const mixed = { id: 2, host: '*.**.a.com', priority: 0 };
    const star = { id: 1, host: '*.a.com', priority: 0 };
    expect(compareRules(mixed, star)).toBeGreaterThan(0); // star 排前
  });
});

describe('patternIntersects', () => {
  it('存在共同可命中域名时相交', () => {
    expect(patternIntersects('*.example.com', '**.example.com')).toBe(true);
    expect(patternIntersects('**.example.com', 'example.com')).toBe(true);
    expect(patternIntersects('a.*.com', 'a.b.com')).toBe(true);
  });

  it('** 占 0 层时相交', () => {
    expect(patternIntersects('a.**.b', 'a.b')).toBe(true);
  });

  it('无共同域名时不相交', () => {
    expect(patternIntersects('*.a.com', '*.b.com')).toBe(false);
    expect(patternIntersects('*.example.com', 'example.com')).toBe(false);
    expect(patternIntersects('a.com', 'b.com')).toBe(false);
  });

  it('全局 * 与任何模式相交', () => {
    expect(patternIntersects('*', 'a.com')).toBe(true);
    expect(patternIntersects('*', '*.a.com')).toBe(true);
    expect(patternIntersects('a.com', '*')).toBe(true);
  });
});
