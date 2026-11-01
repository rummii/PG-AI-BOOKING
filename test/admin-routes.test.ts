import assert from "node:assert/strict";
import test from "node:test";

process.env.ADMIN_API_TOKEN = "test-admin-token-123456";
process.env.ADMIN_SESSION_SECRET = "test-session-secret-abcdef";
process.env.SITE_LAT = "45.0";
process.env.SITE_LON = "7.0";
process.env.SITE_TIMEZONE = "UTC";
process.env.LOG_LEVEL = "silent";
delete process.env.SITE_CONFIG_FILE;

const { app } = await import("../src/server.js");
const { configureSiteConfigStore, createMemoryStore } = await import(
  "../src/services/site-config.js"
);

configureSiteConfigStore(createMemoryStore());

function cookieFrom(response: { headers: Record<string, unknown> }): string {
  const header = response.headers["set-cookie"];
  const raw = Array.isArray(header) ? header[0] : header;
  assert.equal(typeof raw, "string", "expected a Set-Cookie header");
  return String(raw).split(";")[0]!;
}

test("the admin API rejects unauthenticated calls", async () => {
  const response = await app.inject({ method: "GET", url: "/api/admin/config" });
  assert.equal(response.statusCode, 401);
});

test("session status is readable without credentials", async () => {
  const response = await app.inject({ method: "GET", url: "/api/admin/session" });
  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.authenticated, false);
  assert.equal(body.configured, true);
});

test("a wrong token is rejected and a right one issues a cookie", async () => {
  const denied = await app.inject({
    method: "POST",
    url: "/api/admin/session",
    payload: { token: "wrong-token" },
  });
  assert.equal(denied.statusCode, 401);

  const granted = await app.inject({
    method: "POST",
    url: "/api/admin/session",
    payload: { token: "test-admin-token-123456" },
  });
  assert.equal(granted.statusCode, 200);
  const cookie = cookieFrom(granted);
  assert.match(cookie, /^pg_admin=\d+\.[a-f0-9]+$/);
});

test("the bearer token still works for scripts", async () => {
  const response = await app.inject({
    method: "GET",
    url: "/api/admin/config",
    headers: { authorization: "Bearer test-admin-token-123456" },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().config.version, 1);
});

test("cookie writes require the CSRF header", async () => {
  const login = await app.inject({
    method: "POST",
    url: "/api/admin/session",
    payload: { token: "test-admin-token-123456" },
  });
  const cookie = cookieFrom(login);

  const withoutHeader = await app.inject({
    method: "PATCH",
    url: "/api/admin/config",
    headers: { cookie },
    payload: { policy: { minLeadHours: 18 } },
  });
  assert.equal(withoutHeader.statusCode, 403);

  const withHeader = await app.inject({
    method: "PATCH",
    url: "/api/admin/config",
    headers: { cookie, "x-admin-csrf": "1" },
    payload: { policy: { minLeadHours: 18 } },
  });
  assert.equal(withHeader.statusCode, 200);
  assert.equal(withHeader.json().config.policy.minLeadHours, 18);
  assert.ok(withHeader.json().etag);
});

test("a policy patch is validated before it is saved", async () => {
  const response = await app.inject({
    method: "PATCH",
    url: "/api/admin/config",
    headers: { authorization: "Bearer test-admin-token-123456" },
    payload: { policy: { mode: "focus-only" } },
  });
  assert.equal(response.statusCode, 400);
});

test("a stale If-Match is refused instead of clobbering", async () => {
  const auth = { authorization: "Bearer test-admin-token-123456" };
  const current = await app.inject({ method: "GET", url: "/api/admin/config", headers: auth });
  assert.equal(current.statusCode, 200);

  const conflict = await app.inject({
    method: "PATCH",
    url: "/api/admin/config",
    headers: { ...auth, "if-match": "not-the-current-etag" },
    payload: { policy: { minLeadHours: 30 } },
  });
  assert.equal(conflict.statusCode, 409);

  const saved = current.json().etag;
  const ok = await app.inject({
    method: "PATCH",
    url: "/api/admin/config",
    headers: { ...auth, "if-match": String(saved) },
    payload: { policy: { minLeadHours: 30 } },
  });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.json().config.policy.minLeadHours, 30);
});

test("a blank If-Match is rejected instead of skipping the conflict check", async () => {
  const auth = { authorization: "Bearer test-admin-token-123456" };
  const before = await app.inject({ method: "GET", url: "/api/admin/config", headers: auth });
  const savedPolicy = before.json().config.policy;

  const response = await app.inject({
    method: "PATCH",
    url: "/api/admin/config",
    headers: { ...auth, "if-match": "" },
    payload: { policy: { minLeadHours: 31 } },
  });
  assert.equal(response.statusCode, 400);

  const after = await app.inject({ method: "GET", url: "/api/admin/config", headers: auth });
  assert.equal(after.json().config.policy.minLeadHours, savedPolicy.minLeadHours);
});

test("the admin console HTML is served and marked noindex", async () => {
  const response = await app.inject({ method: "GET", url: "/admin" });
  assert.equal(response.statusCode, 200);
  assert.match(response.body, /noindex/);
  assert.match(response.headers["content-type"] as string, /text\/html/);
});

test("the public availability endpoint gains policy data without breaking the old shape", async () => {
  const response = await app.inject({ method: "GET", url: "/api/slots/available" });
  // No Google credentials in tests: the route short-circuits with 503, which is the documented
  // behaviour. The additive fields are covered by the booking-policy suite instead.
  assert.equal(response.statusCode, 503);
});
