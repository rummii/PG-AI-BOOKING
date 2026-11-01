import assert from "node:assert/strict";
import test from "node:test";

// Force the deployment's unconfigured state so the fail-closed contract is deterministic.
process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = "";
process.env.GOOGLE_PRIVATE_KEY = "";
process.env.PARAGLIDING_CALENDAR_ID = "";
process.env.ADMIN_API_TOKEN = "";
process.env.DEEPSEEK_API_KEY = "";
process.env.ALERT_WEBHOOK_URL = "";
process.env.LOG_LEVEL = "silent";

const { app } = await import("../src/server.js");
await app.ready();

const bookingBody = {
  slotId: "slot-1",
  passenger: {
    name: "Test Flyer",
    weight_kg: 75,
    contact: "test@example.com",
    emergency_contact: "Jane 555-0100",
  },
};

test("the health endpoint reports process health", async () => {
  const response = await app.inject({ method: "GET", url: "/api/health" });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().status, "ok");
});

test("the booking page and its assets are served", async () => {
  const page = await app.inject({ method: "GET", url: "/" });
  assert.equal(page.statusCode, 200);
  assert.match(page.headers["content-type"], /text\/html/);
  assert.match(page.body, /booking-dialog/);

  const script = await app.inject({ method: "GET", url: "/app.js" });
  assert.equal(script.statusCode, 200);
  assert.match(script.headers["content-type"], /text\/javascript/);

  const styles = await app.inject({ method: "GET", url: "/styles.css" });
  assert.equal(styles.statusCode, 200);
  assert.match(styles.headers["content-type"], /text\/css/);
});

test("availability fails closed when the calendar is not configured", async () => {
  const response = await app.inject({ method: "GET", url: "/api/slots/available" });
  assert.equal(response.statusCode, 503);
  assert.match(response.json().error, /temporarily unavailable/i);
});

test("booking fails closed when the calendar is not configured", async () => {
  const response = await app.inject({ method: "POST", url: "/api/slots/book", payload: bookingBody });
  assert.equal(response.statusCode, 503);
  assert.match(response.json().error, /temporarily unavailable/i);
});

test("malformed JSON is rejected as a client error rather than an internal error", async () => {
  const response = await app.inject({
    method: "POST",
    url: "/api/slots/book",
    headers: { "content-type": "application/json" },
    payload: '{"slotId": ',
  });
  assert.equal(response.statusCode, 400);
  assert.match(response.json().error, /JSON/i);
});

test("admin evaluation is disabled without a configured token", async () => {
  const response = await app.inject({
    method: "POST",
    url: "/api/admin/evaluate-now",
    payload: { date: new Date().toISOString() },
  });
  assert.equal(response.statusCode, 503);
  assert.match(response.json().error, /ADMIN_API_TOKEN/);
});

test("unknown routes return a JSON 404", async () => {
  const response = await app.inject({ method: "GET", url: "/api/does-not-exist" });
  assert.equal(response.statusCode, 404);
  assert.equal(response.json().error, "Not found");
});
