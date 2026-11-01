import assert from "node:assert/strict";
import test from "node:test";

/**
 * Railway (and any edge that terminates TLS) reaches the app over plain HTTP and describes the
 * original request in `x-forwarded-proto` / `x-forwarded-for`. Both admin behaviours that read the
 * request depend on `trustProxy`, so this file runs a second copy of the app with it enabled —
 * `config` is read once per process, hence a dedicated test file rather than another case in
 * `admin-routes.test.ts`.
 */

process.env.ADMIN_API_TOKEN = "test-admin-token-123456";
process.env.ADMIN_SESSION_SECRET = "test-session-secret-abcdef";
process.env.SITE_LAT = "45.0";
process.env.SITE_LON = "7.0";
process.env.SITE_TIMEZONE = "UTC";
process.env.LOG_LEVEL = "silent";
process.env.TRUST_PROXY = "true";
delete process.env.SITE_CONFIG_FILE;

const { app } = await import("../src/server.js");
const { configureSiteConfigStore, createMemoryStore } = await import(
  "../src/services/site-config.js"
);

configureSiteConfigStore(createMemoryStore());

function rawSetCookie(response: { headers: Record<string, unknown> }): string {
  const header = response.headers["set-cookie"];
  const raw = Array.isArray(header) ? header[0] : header;
  assert.equal(typeof raw, "string", "expected a Set-Cookie header");
  return String(raw);
}

test("a proxied HTTPS request gets a Secure session cookie", async () => {
  const response = await app.inject({
    method: "POST",
    url: "/api/admin/session",
    headers: { "x-forwarded-proto": "https" },
    payload: { token: "test-admin-token-123456" },
  });
  assert.equal(response.statusCode, 200);

  const cookie = rawSetCookie(response);
  assert.match(cookie, /; Secure/, "the browser must not send the session cookie over HTTP");
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
});

test("signing out behind the proxy clears the cookie with the same flags", async () => {
  const response = await app.inject({
    method: "DELETE",
    url: "/api/admin/session",
    headers: { "x-forwarded-proto": "https" },
  });
  assert.equal(response.statusCode, 200);
  const cookie = rawSetCookie(response);
  assert.match(cookie, /; Secure/);
  assert.match(cookie, /Max-Age=0/);
});

test("the login throttle follows the forwarded client, not the proxy address", async () => {
  const attempt = (ip: string) =>
    app.inject({
      method: "POST",
      url: "/api/admin/session",
      headers: { "x-forwarded-for": ip },
      payload: { token: "wrong-token" },
    });

  const noisy = "203.0.113.10";
  for (let i = 0; i < 5; i += 1) {
    assert.equal((await attempt(noisy)).statusCode, 401, "attempts under the limit are just rejected");
  }
  assert.equal((await attempt(noisy)).statusCode, 429, "the sixth attempt from that client is throttled");

  // A different visitor behind the same proxy must not inherit the lock-out.
  assert.equal((await attempt("198.51.100.7")).statusCode, 401);
});
