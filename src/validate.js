// 路径：以 .txt 结尾，按 / 分段；每段 1-80 位字母/数字/下划线/连字符/点，
// 段不得为 . 或 ..；总长不超过 MAX_FILENAME_LENGTH。
// filename 只作为数据库键值参与匹配，不接触文件系统，校验用于保持 URL 空间整洁。
const SEGMENT_RE = /^[A-Za-z0-9._-]{1,80}$/;

export const MAX_CONTENT_BYTES = 4096;
export const MIN_PASSWORD_LENGTH = 8;
export const MAX_FILENAME_LENGTH = 255;

export function isValidFilename(name) {
  if (typeof name !== 'string') return false;
  if (name.length > MAX_FILENAME_LENGTH || !name.endsWith('.txt')) return false;
  const segments = name.slice(0, -4).split('/');
  return segments.every((s) => SEGMENT_RE.test(s) && s !== '.' && s !== '..');
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
