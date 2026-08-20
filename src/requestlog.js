export const DEFAULT_CAPACITY = 200;

export function createRequestLog(capacity = DEFAULT_CAPACITY) {
  const items = [];
  return {
    record(entry) {
      items.push({ ...entry, at: Date.now() });
      if (items.length > capacity) items.shift();
    },
    list() {
      return items.slice().reverse();
    },
    clear() {
      items.length = 0;
    },
  };
}
