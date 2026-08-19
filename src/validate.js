const FILENAME_RE = /^[A-Za-z0-9_-]{1,80}\.txt$/;

export const MAX_CONTENT_BYTES = 4096;
export const MIN_PASSWORD_LENGTH = 12;

export function isValidFilename(name) {
  if (typeof name !== 'string') return false;
  return FILENAME_RE.test(name);
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
