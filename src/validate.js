// 路径不限制格式：任意非空字符串均可（扩展名、字符、子目录都不限），
// 只要求非空、不以 / 开头（存值不带前导 /，请求路径会去掉一层）、总长不超过 MAX_FILENAME_LENGTH。
// filename 只作为数据库键值参与匹配，不接触文件系统。
export const MAX_CONTENT_BYTES = 4096;
export const MIN_PASSWORD_LENGTH = 8;
export const MAX_FILENAME_LENGTH = 255;

export function isValidFilename(name) {
  if (typeof name !== 'string') return false;
  if (!name || name.length > MAX_FILENAME_LENGTH) return false;
  if (name.startsWith('/')) return false;
  return true;
}

export function normalizeHost(raw) {
  if (typeof raw !== 'string') return '';
  let h = raw.split(',')[0].trim().toLowerCase();
  if (!h) return '';
  if (h.startsWith('[')) {
    const end = h.indexOf(']');
    if (end !== -1) h = h.slice(0, end + 1);
  } else {
    const colon = h.indexOf(':');
    if (colon !== -1) h = h.slice(0, colon);
  }
  return h.replace(/\.+$/, '');
}

export function inspectContent(content) {
  const s = typeof content === 'string' ? content : '';
  return {
    hasBom: s.charCodeAt(0) === 0xfeff,
    hasCrlf: s.includes('\r\n'),
    hasLeadingWhitespace: /^\s/.test(s),
    hasTrailingWhitespace: /\s$/.test(s),
    byteLength: Buffer.byteLength(s, 'utf8'),
  };
}

export function cleanContent(content) {
  let s = typeof content === 'string' ? content : '';
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  return s.replace(/\r\n/g, '\n').trim();
}
