export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  reset_ms: number;
}

type Bucket = {
  tokens: number;
  updated_at: number;
};

export class TokenBucketRateLimiter {
  private buckets = new Map<string, Bucket>();

  consume(key: string, capacity: number, refillPerMinute: number, cost = 1): RateLimitResult {
    if (capacity <= 0 || refillPerMinute <= 0) {
      return { allowed: true, remaining: Number.POSITIVE_INFINITY, reset_ms: 0 };
    }

    const now = Date.now();
    const refillPerMs = refillPerMinute / 60000;
    const bucket = this.buckets.get(key) ?? { tokens: capacity, updated_at: now };
    const elapsed = Math.max(0, now - bucket.updated_at);
    bucket.tokens = Math.min(capacity, bucket.tokens + elapsed * refillPerMs);
    bucket.updated_at = now;

    if (bucket.tokens < cost) {
      this.buckets.set(key, bucket);
      const missing = cost - bucket.tokens;
      return {
        allowed: false,
        remaining: Math.floor(bucket.tokens),
        reset_ms: Math.ceil(missing / refillPerMs),
      };
    }

    bucket.tokens -= cost;
    this.buckets.set(key, bucket);
    return {
      allowed: true,
      remaining: Math.floor(bucket.tokens),
      reset_ms: 0,
    };
  }
}
