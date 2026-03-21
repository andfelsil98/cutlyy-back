import type { NextFunction, Request, Response } from "express";

const RATE_LIMIT_WINDOW_MS = 1000;
const RATE_LIMIT_MAX_REQUESTS = 10;
const CLEANUP_INTERVAL = 500;

const requestBuckets = new Map<string, number[]>();
let requestsSinceCleanup = 0;

export function rateLimitMiddleware(req: Request, res: Response, next: NextFunction) {
  if (req.method === "OPTIONS") {
    next();
    return;
  }

  const now = Date.now();
  cleanupExpiredBuckets(now);

  const source = getRequestSource(req);
  const endpoint = `${req.method}:${req.path}`;
  const bucketKey = `${source}:${endpoint}`;
  const recentRequests = (requestBuckets.get(bucketKey) ?? []).filter(
    timestamp => now - timestamp < RATE_LIMIT_WINDOW_MS
  );

  if (recentRequests.length >= RATE_LIMIT_MAX_REQUESTS) {
    const oldestRequest = recentRequests[0] ?? now;
    const retryAfterMs = RATE_LIMIT_WINDOW_MS - (now - oldestRequest);
    const retryAfterSeconds = Math.max(1, Math.ceil(retryAfterMs / 1000));

    requestBuckets.set(bucketKey, recentRequests);
    res.setHeader("Retry-After", retryAfterSeconds.toString());
    res.status(429).json({
      error: "No puedes consultar este endpoint mas de 10 veces por segundo.",
      code: "RATE_LIMIT_EXCEEDED",
      timestamp: new Date(now).toISOString(),
    });
    return;
  }

  recentRequests.push(now);
  requestBuckets.set(bucketKey, recentRequests);
  next();
}

function cleanupExpiredBuckets(now: number) {
  requestsSinceCleanup += 1;

  if (requestsSinceCleanup < CLEANUP_INTERVAL) {
    return;
  }

  requestsSinceCleanup = 0;

  for (const [bucketKey, timestamps] of requestBuckets.entries()) {
    const recentRequests = timestamps.filter(timestamp => now - timestamp < RATE_LIMIT_WINDOW_MS);

    if (recentRequests.length === 0) {
      requestBuckets.delete(bucketKey);
      continue;
    }

    requestBuckets.set(bucketKey, recentRequests);
  }
}

function getRequestSource(req: Request): string {
  const forwardedFor = req.headers["x-forwarded-for"];
  const forwardedIp = Array.isArray(forwardedFor)
    ? forwardedFor[0]
    : forwardedFor?.split(",")[0]?.trim();

  const source = forwardedIp || req.ip || req.socket.remoteAddress || "unknown";

  return source.startsWith("::ffff:") ? source.slice(7) : source;
}
