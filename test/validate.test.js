import { describe, it, expect } from 'vitest';
import { isValidFilename, normalizeHost, inspectContent, cleanContent, MAX_CONTENT_BYTES }
  from '../src/validate.js';

describe('isValidFilename', () => {
  it('接受微信公众号格式', () => {
    expect(isValidFilename('MP_verify_kL9xQ2mNpR7vT4wZ.txt')).toBe(true);
  });
  it('接受小程序的无前缀随机串', () => {
    expect(isValidFilename('a1b2c3d4e5f6.txt')).toBe(true);
  });
  it('拒绝路径分隔符', () => {
    expect(isValidFilename('a/b.txt')).toBe(false);
    expect(isValidFilename('..\\b.txt')).toBe(false);
  });
  it('拒绝路径穿越', () => {
    expect(isValidFilename('../etc/passwd.txt')).toBe(false);
    expect(isValidFilename('..%2Fpasswd.txt')).toBe(false);
  });
  it('拒绝空字节', () => {
    expect(isValidFilename('a\x00.txt')).toBe(false);
  });
  it('拒绝非 .txt 后缀', () => {
    expect(isValidFilename('a.php')).toBe(false);
    expect(isValidFilename('a.txt.php')).toBe(false);
  });
  it('拒绝超长文件名', () => {
    expect(isValidFilename('a'.repeat(81) + '.txt')).toBe(false);
  });
  it('拒绝非字符串', () => {
    expect(isValidFilename(null)).toBe(false);
    expect(isValidFilename(undefined)).toBe(false);
  });
});

describe('normalizeHost', () => {
  it('转小写', () => {
    expect(normalizeHost('Example.COM')).toBe('example.com');
  });
  it('去端口', () => {
    expect(normalizeHost('example.com:8080')).toBe('example.com');
  });
  it('去尾部点', () => {
    expect(normalizeHost('example.com.')).toBe('example.com');
  });
  it('取逗号列表的第一个', () => {
    expect(normalizeHost('a.com, b.com')).toBe('a.com');
  });
  it('保留 IPv6 字面量并去端口', () => {
    expect(normalizeHost('[::1]:3000')).toBe('[::1]');
  });
  it('空输入返回空串', () => {
    expect(normalizeHost('')).toBe('');
    expect(normalizeHost(null)).toBe('');
  });
});

describe('inspectContent', () => {
  it('检出 BOM', () => {
    expect(inspectContent('\uFEFFabc').hasBom).toBe(true);
    expect(inspectContent('abc').hasBom).toBe(false);
  });
  it('检出 CRLF', () => {
    expect(inspectContent('a\r\nb').hasCrlf).toBe(true);
  });
  it('检出首尾空白', () => {
    expect(inspectContent(' abc').hasLeadingWhitespace).toBe(true);
    expect(inspectContent('abc\n').hasTrailingWhitespace).toBe(true);
    expect(inspectContent('abc').hasTrailingWhitespace).toBe(false);
  });
  it('按 UTF-8 算字节数', () => {
    expect(inspectContent('中').byteLength).toBe(3);
  });
});

describe('cleanContent', () => {
  it('去 BOM、转 LF、去首尾空白', () => {
    expect(cleanContent('\uFEFF  a\r\nb  ')).toBe('a\nb');
  });
  it('不改动本已干净的内容', () => {
    expect(cleanContent('abc123')).toBe('abc123');
  });
});

describe('MAX_CONTENT_BYTES', () => {
  it('是 4KB', () => {
    expect(MAX_CONTENT_BYTES).toBe(4096);
  });
});
