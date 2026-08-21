export const DEFAULT_CAPACITY = 2000;

export function createRequestLog(capacity = DEFAULT_CAPACITY) {
  let current = capacity;
  const items = [];
  return {
    record(entry) {
      items.push({ ...entry, at: Date.now() });
      if (items.length > current) items.shift();
    },
    list() {
      return items.slice().reverse();
    },
    clear() {
      items.length = 0;
    },
    // 运行时调整容量（设置页修改后立即生效），超出的旧记录直接裁剪
    setCapacity(n) {
      current = n;
      while (items.length > current) items.shift();
    },
  };
}
