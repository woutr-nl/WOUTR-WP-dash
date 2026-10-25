// Login failure limiter: per IP, plus a global cap so rotating IPs (or spoofed
// X-Forwarded-For values) can't bypass it.
// ponytail: in-memory, single instance — move to the DB if the app ever runs replicated.
// The global lock also locks out the real admin until the window ends: accepted for a single-admin tool.

export const WINDOW = 15 * 60 * 1000;
export const MAX_FAILURES = 5; // per IP
export const MAX_GLOBAL = 30; // all IPs together
export const MAX_ENTRIES = 10_000; // per-IP map size

export function createLimiter() {
  const failures = new Map(); // ip -> { count, first, blockedUntil }
  const global = { count: 0, first: 0, blockedUntil: 0 };

  return {
    failures,
    blocked(ip, now = Date.now()) {
      return global.blockedUntil > now || failures.get(ip)?.blockedUntil > now;
    },
    success(ip) {
      failures.delete(ip);
    },
    fail(ip, now = Date.now()) {
      for (const [k, v] of failures) if (now - v.first > WINDOW && !(v.blockedUntil > now)) failures.delete(k);
      if (now - global.first > WINDOW) Object.assign(global, { count: 0, first: now });
      if (++global.count >= MAX_GLOBAL) global.blockedUntil = now + WINDOW;

      let f = failures.get(ip);
      if (!f) {
        if (failures.size >= MAX_ENTRIES) return; // full: the global cap still counts this one
        f = { count: 0, first: now, blockedUntil: 0 };
        failures.set(ip, f);
      }
      if (++f.count >= MAX_FAILURES) f.blockedUntil = now + WINDOW;
    },
  };
}
