// 不信任可伪造的 XFF；账号限流配合进程总预算和并发限制，Map 每分钟清空。
export function createLoginLimiter({ now = Date.now, perAccount = 10, total = 120, concurrent = 8 } = {}) {
  let expires = 0;
  let count = 0;
  let active = 0;
  const accounts = new Map();
  return {
    acquire(username) {
      const time = now();
      if (time >= expires) {
        expires = time + 60000;
        accounts.clear();
        count = 0;
      }
      const attempts = accounts.get(username) || 0;
      if (attempts >= perAccount || count >= total || active >= concurrent) return null;
      accounts.set(username, attempts + 1);
      count++;
      active++;
      let released = false;
      return () => {
        if (!released) { active--; released = true; }
      };
    },
  };
}
