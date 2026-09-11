/**
 * A tiny in-process fixed-window counter. Used for the per-email dimension of
 * the magic-link limit (the plugin covers the per-IP dimension). Not shared
 * across processes, which is fine for a single-node deployment.
 */
export class FixedWindowLimiter {
  private hits = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number
  ) {}

  /** Returns true if the request is allowed, false if the key is over the limit. */
  take(key: string, now: number = Date.now()): boolean {
    const entry = this.hits.get(key);
    if (!entry || entry.resetAt <= now) {
      this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
      return true;
    }
    if (entry.count >= this.max) return false;
    entry.count += 1;
    return true;
  }
}
