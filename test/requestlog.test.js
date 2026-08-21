import { describe, it, expect } from 'vitest';
import { createRequestLog } from '../src/requestlog.js';

describe('createRequestLog', () => {
  it('记录后可列出', () => {
    const d = createRequestLog();
    d.record({ host: 'a.com', path: '/x.txt', hit: true });
    expect(d.list()).toHaveLength(1);
    expect(d.list()[0].host).toBe('a.com');
  });

  it('自动打时间戳', () => {
    const d = createRequestLog();
    d.record({ host: 'a.com' });
    expect(d.list()[0].at).toBeGreaterThan(0);
  });

  it('最新的排在最前', () => {
    const d = createRequestLog();
    d.record({ path: '/first.txt' });
    d.record({ path: '/second.txt' });
    expect(d.list()[0].path).toBe('/second.txt');
  });

  it('超出容量时丢弃最旧的', () => {
    const d = createRequestLog(3);
    for (let i = 1; i <= 5; i++) d.record({ path: `/${i}.txt` });
    const paths = d.list().map(e => e.path);
    expect(paths).toEqual(['/5.txt', '/4.txt', '/3.txt']);
  });

  it('默认容量 2000', () => {
    const d = createRequestLog();
    for (let i = 0; i < 2050; i++) d.record({ path: `/${i}.txt` });
    expect(d.list()).toHaveLength(2000);
  });

  it('list 返回副本，外部改动不影响内部', () => {
    const d = createRequestLog();
    d.record({ path: '/x.txt' });
    d.list().push({ path: '/injected.txt' });
    expect(d.list()).toHaveLength(1);
  });

  it('clear 清空', () => {
    const d = createRequestLog();
    d.record({ path: '/x.txt' });
    d.clear();
    expect(d.list()).toHaveLength(0);
  });
});
