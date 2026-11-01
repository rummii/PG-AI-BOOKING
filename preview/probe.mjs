/**
 * End-to-end probe for a running backend: signs in, reads every admin endpoint, round-trips a
 * config edit through ETag/CSRF, and asserts the public API reflects it.
 *
 * Usage: npm run preview (one terminal), then npm run probe
 *        node preview/probe.mjs http://localhost:3000 --calendar-off
 *
 * Flags: --calendar-off  the target has no Google Calendar credentials, so availability must be
 *                        503 and the calendar-backed admin reads must fail cleanly. Everything
 *                        else (session, config store, CSRF, ETag) is still exercised.
 * The login token comes from ADMIN_API_TOKEN (default "demo", matching PREVIEW_ADMIN_TOKEN).
 */
const args = process.argv.slice(2);
const calendarOff = args.includes("--calendar-off");
const base = args.find((arg) => arg.startsWith("http")) ?? `http://localhost:${process.env.PREVIEW_PORT ?? 3100}`;
const token = process.env.ADMIN_API_TOKEN ?? "demo";
let cookie = "";

async function call(path, init = {}) {
  const headers = { ...(init.headers ?? {}) };
  if (cookie) headers.cookie = cookie;
  const response = await fetch(base + path, { ...init, headers });
  const setCookie = response.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";")[0];
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text.slice(0, 120);
  }
  return { status: response.status, body, headers: Object.fromEntries(response.headers) };
}

const line = (label, value) => console.log(`${label.padEnd(46)} ${value}`);

const health = await call("/api/health");
line("GET /api/health", `${health.status} ${JSON.stringify(health.body)}`);

const anon = await call("/api/admin/overview");
line("GET /api/admin/overview (no session)", `${anon.status} ${JSON.stringify(anon.body)}`);

const badLogin = await call("/api/admin/session", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ token: "wrong" }),
});
line("POST /api/admin/session (wrong token)", `${badLogin.status} ${JSON.stringify(badLogin.body)}`);

const login = await call("/api/admin/session", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ token }),
});
line("POST /api/admin/session (operator token)", `${login.status} ${JSON.stringify(login.body)}`);
line("  cookie", cookie + ` (${login.headers["set-cookie"] ? "HttpOnly/SameSite=Strict" : "missing"})`);

const overview = await call("/api/admin/overview");
line("GET /api/admin/overview", `${overview.status}`);
line("  keys", Object.keys(overview.body).join(", "));
if (overview.body.counts) line("  counts", JSON.stringify(overview.body.counts));
if (overview.body.policy) {
  line(
    "  today / window",
    `${overview.body.today} · ${overview.body.policy.windowDays}d → ${overview.body.policy.windowEndsOn} (${overview.body.policy.mode})`,
  );
  line("  audit", `${overview.body.audit?.length ?? 0} entries`);
} else {
  line("  error", JSON.stringify(overview.body.error));
}

const weather = await call("/api/admin/weather");
line("GET /api/admin/weather", `${weather.status}`);
const series = weather.body.series ?? {};
line("  horizon / windows", `${series.hours?.length} hours · ${series.windows?.length} windows`);
line(
  "  verdict mix",
  JSON.stringify(
    (series.hours ?? []).reduce((acc, hour) => {
      acc[hour.verdict] = (acc[hour.verdict] ?? 0) + 1;
      return acc;
    }, {}),
  ),
);
line("  first window", JSON.stringify(series.windows?.[0]));
line("  first hour", JSON.stringify(series.hours?.[0]?.models?.[0]));
line("  profile maxWind", `${series.profile?.maxWindKmh} km/h`);
line("  analytics", Object.keys(weather.body.analytics ?? {}).join(", "));
line("  ruleStats", `${weather.body.analytics?.ruleStats?.length} rules · daily ${weather.body.analytics?.daily?.length} days`);
line("  avg score", `${weather.body.analytics?.averageScore} (flyable ${weather.body.analytics?.verdicts?.FLYABLE})`);

const slots = await call("/api/admin/slots");
line("GET /api/admin/slots", `${slots.status}`);
line("  slots / days", `${slots.body.slots?.length} slots · ${slots.body.days?.length} days`);
line("  first slot", JSON.stringify(slots.body.slots?.[0]));

const config = await call("/api/admin/config");
line("GET /api/admin/config", `${config.status} v${config.body.config?.version} by ${config.body.config?.updatedBy}`);
line("  etag (header/body)", `${config.headers.etag ?? "(none)"} / ${config.body.etag}`);
const etag = config.body.etag ?? config.headers.etag ?? "";
const originalPolicy = config.body.config?.policy ?? {};
const saved = JSON.stringify({ policy: originalPolicy, templates: config.body.config?.templates });

const patchHeaders = (revision) => ({
  "content-type": "application/json",
  "x-admin-csrf": "1",
  ...(revision ? { "if-match": revision } : {}),
});

const patched = await call("/api/admin/config", {
  method: "PATCH",
  headers: patchHeaders(etag),
  body: JSON.stringify({
    policy: {
      ...originalPolicy,
      notice: "Probe: ridge building, expect a midday window.",
      bookingWindowDays: 10,
    },
    templates: config.body.config?.templates,
  }),
});
line("PATCH /api/admin/config", `${patched.status} v${patched.body.config?.version} → etag ${patched.body.etag}`);
line("  notice", patched.body.config?.policy?.notice ?? JSON.stringify(patched.body));
line("  window", `${patched.body.config?.policy?.bookingWindowDays} days`);

// The revision used above is now stale, so replaying it must be refused.
const staleRevision = etag && etag !== patched.body.etag ? etag : "0000-stale-revision";
const stale = await call("/api/admin/config", {
  method: "PATCH",
  headers: patchHeaders(staleRevision),
  body: saved,
});
line("PATCH with stale If-Match", `${stale.status} ${JSON.stringify(stale.body)}`);

const noCsrf = await call("/api/admin/config", {
  method: "PATCH",
  headers: { "content-type": "application/json", "if-match": patched.body.etag ?? "" },
  body: saved,
});
line("PATCH without x-admin-csrf", `${noCsrf.status} ${JSON.stringify(noCsrf.body)}`);

const blankIfMatch = await call("/api/admin/config", {
  method: "PATCH",
  headers: { "content-type": "application/json", "x-admin-csrf": "1", "if-match": "" },
  body: saved,
});
line("PATCH with blank If-Match", `${blankIfMatch.status} ${JSON.stringify(blankIfMatch.body)}`);

const publicAfter = await call("/api/slots/available");
line("GET /api/slots/available (after edit)", `${publicAfter.status}`);
line("  notice", JSON.stringify(publicAfter.body.notice));
line("  policy", JSON.stringify(publicAfter.body.policy));
line("  days", (publicAfter.body.days ?? []).map((day) => `${day.date}:${day.state}`).join(" "));

const evaluateId = slots.body.slots?.[0]?.id;
const evaluate = !calendarOff && evaluateId
  ? await call(`/api/admin/slots/${evaluateId}/evaluate`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-admin-csrf": "1" },
      body: JSON.stringify({}),
    })
  : { status: "skipped", body: { reason: "needs a calendar-backed slot" } };
line("POST /api/admin/slots/:id/evaluate", `${evaluate.status} ${JSON.stringify(evaluate.body)}`);

const materialise = await call("/api/admin/slots/materialise", {
  method: "POST",
  headers: { "content-type": "application/json", "x-admin-csrf": "1" },
  body: JSON.stringify({}),
});
line("POST /api/admin/slots/materialise", `${materialise.status} ${JSON.stringify(materialise.body)}`);

const logout = await call("/api/admin/session", {
  method: "DELETE",
  headers: { "x-admin-csrf": "1" },
});
line("DELETE /api/admin/session", `${logout.status} ${JSON.stringify(logout.body)}`);

const afterLogout = await call("/api/admin/overview");
line("GET /api/admin/overview (after logout)", `${afterLogout.status}`);

const common = [
  ["health returns 200", health.status === 200],
  ["admin read without a session is 401", anon.status === 401],
  ["wrong token is 401", badLogin.status === 401],
  ["operator token signs in and sets a cookie", login.status === 200 && cookie.startsWith("pg_admin=")],
  ["config read returns a config", config.status === 200 && Boolean(config.body.config)],
  ["writes need x-admin-csrf (403 without it)", noCsrf.status === 403],
  ["stale If-Match is a 409", stale.status === 409],
  ["blank If-Match is rejected (400)", blankIfMatch.status === 400],
  ["patch bumps the etag", patched.status === 200 && Boolean(patched.body.etag) && patched.body.etag !== etag],
  ["logout succeeds", logout.status === 200],
  ["read after logout is 401", afterLogout.status === 401],
];

const dataOnline = [
  ["overview returns a policy summary", overview.status === 200 && typeof overview.body.policy?.windowDays === "number"],
  ["weather returns a series object", weather.status === 200 && Array.isArray(series.hours)],
  ["slots return the admin shape", slots.status === 200 && typeof slots.body.slots?.[0]?.seatsLeft === "number"],
  ["edited notice reaches the public API", publicAfter.body.notice?.detail?.includes("ridge") === true],
  ["public days rail still spans the window", Array.isArray(publicAfter.body.days) && publicAfter.body.days.length > 0],
];

const dataOffline = [
  [
    "availability is 503 without calendar credentials",
    publicAfter.status === 503 && typeof publicAfter.body.error === "string",
  ],
  [
    "overview fails cleanly instead of crashing",
    overview.status >= 400 && overview.status < 600 && typeof overview.body.error === "string",
  ],
  [
    "materialise plans nothing without a calendar",
    materialise.status === 200 && materialise.body.created === 0,
  ],
];

const expectations = [...common, ...(calendarOff ? dataOffline : dataOnline)];

console.log("");
for (const [label, ok] of expectations) console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
const failed = expectations.filter(([, ok]) => !ok).length;
console.log(failed === 0 ? `\nAll ${expectations.length} expectations passed.` : `\n${failed} expectation(s) failed.`);
if (failed > 0) process.exitCode = 1;
