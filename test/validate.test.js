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
  it('接受子目录路径', () => {
    expect(isValidFilename('h5/MP_verify_abc.txt')).toBe(true);
    expect(isValidFilename('a/b/c/d/x.txt')).toBe(true);
  });
  it('接受带点号的段（.well-known、版本号等）', () => {
    expect(isValidFilename('.well-known/security.txt')).toBe(true);
    expect(isValidFilename('MP_verify.v1.txt')).toBe(true);
  });
  it('路径不限制扩展名与字符', () => {
    expect(isValidFilename('a.php')).toBe(true);
    expect(isValidFilename('apple-app-site-association')).toBe(true);
    expect(isValidFilename('.well-known/assetlinks.json')).toBe(true);
    expect(isValidFilename('a.txt.php')).toBe(true);
    expect(isValidFilename('x y.txt')).toBe(true);
    expect(isValidFilename('校验文件.txt')).toBe(true);
    expect(isValidFilename('x..txt')).toBe(true);
    expect(isValidFilename('a/./x.txt')).toBe(true);
    expect(isValidFilename('a.txt/')).toBe(true);
  });
  it('拒绝空路径', () => {
    expect(isValidFilename('')).toBe(false);
  });
  it('拒绝前导斜杠（存值不带 /，请求路径会去掉一层）', () => {
    expect(isValidFilename('/a.txt')).toBe(false);
  });
  it('总长超过 255 拒绝', () => {
    expect(isValidFilename('a'.repeat(255))).toBe(true);
    expect(isValidFilename('a'.repeat(256))).toBe(false);
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
