import { createHmac, timingSafeEqual } from "node:crypto";
import type { FastifyRequest } from "fastify";
import { config } from "../config/site.js";

/**
 * Admin authentication without a session store: the cookie carries the expiry plus an HMAC of
 * that expiry, so a stolen cookie cannot be extended and no database is needed. The existing
 * Bearer token keeps working for scripts and CI.
 */

export const ADMIN_COOKIE_NAME = "pg_admin";
export const ADMIN_CSRF_HEADER = "x-admin-csrf";

export type AdminAuthMethod = "token" | "session";

export interface AdminAuthResult {
  authorized: boolean;
  method: AdminAuthMethod | null;
}

function safeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

/** The session signing key falls back to the admin token so one secret is enough to deploy. */
export function sessionSecret(): string | null {
  return config.ADMIN_SESSION_SECRET ?? config.ADMIN_API_TOKEN ?? null;
}

export function adminAuthEnabled(): boolean {
  return Boolean(sessionSecret());
}

function sign(secret: string, expiryMs: number): string {
  return createHmac("sha256", secret).update(String(expiryMs)).digest("hex");
}

export function issueSession(
  secret: string,
  now: Date = new Date(),
  ttlMs: number = config.ADMIN_SESSION_TTL_HOURS * 3_600_000,
): { token: string; expiresAt: Date } {
  const expiryMs = now.getTime() + ttlMs;
  return { token: `${expiryMs}.${sign(secret, expiryMs)}`, expiresAt: new Date(expiryMs) };
}

export function verifySession(secret: string, token: string, now: Date = new Date()): boolean {
  const separator = token.indexOf(".");
  if (separator <= 0) return false;
  const expiryRaw = token.slice(0, separator);
  const signature = token.slice(separator + 1);
  const expiryMs = Number(expiryRaw);
  if (!Number.isInteger(expiryMs) || expiryMs <= now.getTime()) return false;
  return safeEqual(sign(secret, expiryMs), signature);
}

export function parseCookies(header: string | undefined): Record<string, string> {
  if (!header) return {};
  const cookies: Record<string, string> = {};
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (name) cookies[name] = decodeURIComponent(value);
  }
  return cookies;
}

export function sessionCookie(token: string, maxAgeSeconds: number, secure: boolean): string {
  const attributes = [
    `${ADMIN_COOKIE_NAME}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (secure) attributes.push("Secure");
  return attributes.join("; ");
}

export function clearedSessionCookie(secure: boolean): string {
  const attributes = [
    `${ADMIN_COOKIE_NAME}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    "Max-Age=0",
  ];
  if (secure) attributes.push("Secure");
  return attributes.join("; ");
}

function bearerToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (!header?.startsWith("Bearer ")) return null;
  return header.slice("Bearer ".length);
}

export function authorizeAdmin(request: FastifyRequest, now: Date = new Date()): AdminAuthResult {
  const token = bearerToken(request);
  if (token && config.ADMIN_API_TOKEN && safeEqual(config.ADMIN_API_TOKEN, token)) {
    return { authorized: true, method: "token" };
  }
  const secret = sessionSecret();
  if (!secret) return { authorized: false, method: null };
  const cookie = parseCookies(request.headers.cookie)[ADMIN_COOKIE_NAME];
  if (cookie && verifySession(secret, cookie, now)) {
    return { authorized: true, method: "session" };
  }
  return { authorized: false, method: null };
}

/**
 * A cookie-authenticated write must carry the CSRF header, because SameSite=Strict alone would
 * not stop a same-site form post from an injected asset.
 */
export function csrfSatisfied(request: FastifyRequest, method: AdminAuthMethod | null): boolean {
  if (method !== "session") return true;
  const value = request.headers[ADMIN_CSRF_HEADER];
  return value === "1" || value === "true";
}

export interface ThrottleOptions {
  limit?: number;
  windowMs?: number;
  clock?: () => number;
}

/** In-memory login throttle: enough for a single-instance deployment, no dependency needed. */
export function createLoginThrottle(options: ThrottleOptions = {}) {
  const limit = options.limit ?? 5;
  const windowMs = options.windowMs ?? 5 * 60_000;
  const clock = options.clock ?? (() => Date.now());
  const attempts = new Map<string, { count: number; resetAt: number }>();

  return {
    isBlocked(key: string): boolean {
      const entry = attempts.get(key);
      if (!entry) return false;
      if (entry.resetAt <= clock()) {
        attempts.delete(key);
        return false;
      }
      return entry.count >= limit;
    },
    recordFailure(key: string): void {
      const now = clock();
      const entry = attempts.get(key);
      if (!entry || entry.resetAt <= now) {
        attempts.set(key, { count: 1, resetAt: now + windowMs });
        return;
      }
      entry.count += 1;
    },
    reset(key: string): void {
      attempts.delete(key);
    },
    get size(): number {
      return attempts.size;
    },
  };
}

export type LoginThrottle = ReturnType<typeof createLoginThrottle>;
