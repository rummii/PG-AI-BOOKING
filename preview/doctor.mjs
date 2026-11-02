/**
 * Credential doctor: proves a DeepSeek key and a Google service-account calendar actually work
 * *before* the server is started, so "is it my credentials or my deploy?" never has to be guessed
 * from a 503.
 *
 * Usage: npm run doctor                 read-only checks (no writes, no token spend)
 *        npm run doctor -- --write      also create and immediately delete a private event, which
 *                                       is the only way to prove the share role is "Make changes
 *                                       to events" rather than read-only
 *
 * Everything here mirrors the app rather than reimplementing it loosely: the private key is
 * normalised exactly as `src/services/calendar.ts` does (escaped `\n` -> real newline), the same
 * scopes are requested, and the same reserved config event is read. Nothing sensitive is printed —
 * keys are reported by length and shape, never by value.
 */
import { createPrivateKey } from "node:crypto";
import { existsSync } from "node:fs";
import "dotenv/config";
import { google } from "googleapis";

const args = process.argv.slice(2);
const writeProbe = args.includes("--write");
const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar";
const keys = (name) => Boolean(process.env[name]?.trim());

const results = [];
const record = (level, label, detail = "") => {
  results.push({ level, label, detail });
  console.log(`${level.padEnd(5)} ${label.padEnd(52)} ${detail}`);
};
const pass = (label, detail) => record("PASS", label, detail);
const warn = (label, detail) => record("WARN", label, detail);
const fail = (label, detail) => record("FAIL", label, detail);

/** Turns a googleapis/native failure into something an operator can act on. */
function describe(error) {
  const status = error?.response?.status ?? error?.code;
  const message = String(error?.message ?? error);
  if (/invalid_grant|Invalid JWT Signature/i.test(message)) {
    return `${message} — the private key does not belong to that service-account email, or the copy lost characters`;
  }
  if (/DECODER routines|1E08010C|PEM routines|no start line/i.test(message)) {
    return `${message} — GOOGLE_PRIVATE_KEY is not a whole PEM: keep the BEGIN/END lines and the \\n escapes, drop the surrounding quotes`;
  }
  if (status === 403) {
    return `${message} — 403: either the Google Calendar API is not enabled for the project, or the calendar is not shared with the service account`;
  }
  if (status === 404) {
    return `${message} — 404: PARAGLIDING_CALENDAR_ID is wrong, or set to "primary" (service accounts have no primary calendar)`;
  }
  if (status === 401) return `${message} — 401: the key was rejected`;
  if (status === 402) return `${message} — 402: the DeepSeek account has no balance`;
  return message;
}

console.log(`\nCredential doctor${writeProbe ? " (with write probe)" : " (read-only)"}\n`);

// --- environment sanity ---------------------------------------------------------------------
const nodeMajor = Number(process.versions.node.split(".")[0]);
if (nodeMajor >= 22) pass("node version", `v${process.versions.node}`);
else fail("node version", `v${process.versions.node} — 22 or newer is required`);

if (existsSync(".env")) pass(".env found", "loaded by dotenv");
else warn(".env missing", "falling back to the ambient environment");

if (keys("ADMIN_API_TOKEN") && process.env.ADMIN_API_TOKEN.length >= 16) {
  pass("ADMIN_API_TOKEN", `set, ${process.env.ADMIN_API_TOKEN.length} chars`);
} else {
  fail("ADMIN_API_TOKEN", "missing or shorter than 16 chars — the control plane stays disabled");
}

if (process.env.SITE_CONFIG_FILE?.trim()) {
  warn(
    "SITE_CONFIG_FILE is set",
    `${process.env.SITE_CONFIG_FILE} — config lives in a file, the calendar is used for slots only`,
  );
} else {
  pass("config store", "calendar (SITE_CONFIG_FILE empty)");
}

const lat = Number(process.env.SITE_LAT ?? 0);
const lon = Number(process.env.SITE_LON ?? 0);
if (lat === 0 && lon === 0) {
  warn("site coordinates", "0,0 — placeholder; forecasts and the envelope will be meaningless");
} else {
  pass("site coordinates", `${lat}, ${lon} (${process.env.SITE_TIMEZONE || "UTC"})`);
}

try {
  new Intl.DateTimeFormat("en-US", { timeZone: process.env.SITE_TIMEZONE || "UTC" });
  pass("SITE_TIMEZONE", process.env.SITE_TIMEZONE || "UTC");
} catch {
  fail("SITE_TIMEZONE", `${process.env.SITE_TIMEZONE} is not an IANA timezone`);
}

// --- Google Calendar ------------------------------------------------------------------------
const missingGoogle = [
  "GOOGLE_SERVICE_ACCOUNT_EMAIL",
  "GOOGLE_PRIVATE_KEY",
  "PARAGLIDING_CALENDAR_ID",
].filter((name) => !keys(name));

let calendar;
if (missingGoogle.length > 0) {
  fail("google credentials", `missing ${missingGoogle.join(", ")}`);
} else {
  pass("google credentials", `all three set, calendar ${process.env.PARAGLIDING_CALENDAR_ID}`);
  if (process.env.PARAGLIDING_CALENDAR_ID.trim() === "primary") {
    // A service account has no primary calendar; Google answers 404 for it.
    warn("PARAGLIDING_CALENDAR_ID", `"primary" is never valid for a service account — use the …@group.calendar.google.com id`);
  }

  // Same normalisation as src/services/calendar.ts.
  const privateKey = process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n");
  const looksPem = privateKey.includes("-----BEGIN PRIVATE KEY-----");
  let keyParsed = false;
  try {
    const key = createPrivateKey({ key: privateKey, format: "pem" });
    keyParsed = true;
    pass("private key parses", `${key.asymmetricKeyType}, ${privateKey.length} chars${looksPem ? "" : " (unusual header)"}`);
  } catch (error) {
    fail("private key parses", describe(error));
  }

  if (keyParsed) try {
    const auth = new google.auth.JWT({
      email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      key: privateKey,
      scopes: [CALENDAR_SCOPE],
    });
    await auth.authorize();
    pass("service account signs in", `access token ${auth.credentials.access_token?.length ?? 0} chars`);

    calendar = google.calendar({ version: "v3", auth });
    const now = new Date();
    const list = await calendar.events.list({
      calendarId: process.env.PARAGLIDING_CALENDAR_ID,
      timeMin: now.toISOString(),
      timeMax: new Date(now.getTime() + 60 * 60 * 1000).toISOString(),
      maxResults: 1,
      singleEvents: true,
    });
    pass("calendar is readable", `${list.data.items?.length ?? 0} event(s) in the next hour`);

    const configEventId = process.env.ADMIN_CONFIG_EVENT_ID?.trim() || "bookingconfig01";
    if (!/^[a-v0-9]{5,1024}$/.test(configEventId)) {
      warn("ADMIN_CONFIG_EVENT_ID", `${configEventId} is not base32hex (a-v, 0-9) — Google rejects it on the first save`);
    }
    try {
      const stored = await calendar.events.get({
        calendarId: process.env.PARAGLIDING_CALENDAR_ID,
        eventId: configEventId,
      });
      pass("reserved config event", `${configEventId} exists (${(stored.data.description ?? "").length} chars of config)`);
    } catch (error) {
      if ((error?.response?.status ?? error?.code) === 404) {
        pass("reserved config event", `${configEventId} absent — created on the first save`);
      } else {
        fail("reserved config event", describe(error));
      }
    }

    if (writeProbe) {
      const start = new Date(now.getTime() + 5 * 60 * 1000);
      const end = new Date(start.getTime() + 5 * 60 * 1000);
      let created;
      try {
        const response = await calendar.events.insert({
          calendarId: process.env.PARAGLIDING_CALENDAR_ID,
          requestBody: {
            summary: "[DOCTOR] credential check (safe to delete)",
            description: "Written by npm run doctor --write to prove editor access; removed immediately.",
            transparency: "transparent",
            visibility: "private",
            start: { dateTime: start.toISOString(), timeZone: "UTC" },
            end: { dateTime: end.toISOString(), timeZone: "UTC" },
          },
        });
        created = response.data.id;
        pass("calendar is writable", `created and removing ${created}`);
      } catch (error) {
        fail("calendar is writable", describe(error));
      }
      if (created) {
        try {
          await calendar.events.delete({
            calendarId: process.env.PARAGLIDING_CALENDAR_ID,
            eventId: created,
          });
          pass("write probe cleaned up", "event deleted");
        } catch (error) {
          fail("write probe cleaned up", `${describe(error)} — delete ${created} by hand`);
        }
      }
    }
  } catch (error) {
    fail("service account signs in", describe(error));
  }
}

// --- DeepSeek -------------------------------------------------------------------------------
if (!keys("DEEPSEEK_API_KEY")) {
  fail("DEEPSEEK_API_KEY", "missing — evaluations fall back to the deterministic envelope only");
} else {
  try {
    // GET /models is free: it proves the key without spending a completion.
    const response = await fetch("https://api.deepseek.com/v1/models", {
      headers: { authorization: `Bearer ${process.env.DEEPSEEK_API_KEY.trim()}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (response.ok) {
      const body = await response.json().catch(() => ({}));
      const models = (body.data ?? []).map((model) => model.id).join(", ");
      pass("deepseek key accepted", models || `${response.status} ${response.statusText}`);
    } else {
      const text = (await response.text().catch(() => "")).slice(0, 200);
      const hint =
        response.status === 402
          ? "the account has no balance"
          : response.status === 401
            ? "the key was rejected: check it was copied whole and comes from platform.deepseek.com"
            : response.statusText;
      fail("deepseek key accepted", `${response.status} ${hint} ${text}`.trim());
    }
  } catch (error) {
    fail("deepseek key accepted", `${String(error?.message ?? error)} — is outbound HTTPS allowed?`);
  }
}

// --- summary --------------------------------------------------------------------------------
const failures = results.filter((result) => result.level === "FAIL").length;
const warnings = results.filter((result) => result.level === "WARN").length;
console.log(
  `\n${failures === 0 ? "Credentials look usable" : `${failures} check(s) failed`}` +
    (warnings > 0 ? `, ${warnings} warning(s)` : "") +
    ".",
);
if (failures === 0 && !writeProbe) {
  console.log("Next: npm start, then confirm /api/slots/available answers 200 instead of 503.");
  console.log("Re-run with --write once to prove the calendar share is editor, not reader.");
}
// `process.exitCode` rather than `process.exit()`: exiting while googleapis still has sockets
// closing trips a libuv assertion on Windows (UV_HANDLE_CLOSING) that masks the real exit code.
process.exitCode = failures === 0 ? 0 : 1;
