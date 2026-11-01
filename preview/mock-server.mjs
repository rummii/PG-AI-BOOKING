/**
 * Local-only demo backend for previewing the booking UI without credentials.
 *
 * Serves the real `public/` assets and answers the same API contract as
 * `src/server.ts` with deterministic in-memory slots. Nothing here touches
 * Google Calendar, the worker, or production data.
 *
 * Usage: npm run preview   (http://localhost:3100)
 * Extras: PREVIEW_PORT=3200 npm run preview
 *         PREVIEW_CONFLICT=1 npm run preview   (one slot always returns 409)
 *         PREVIEW_ADMIN_TOKEN=demo npm run preview  (operator console at /admin)
 */
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.PREVIEW_PORT ?? 3100);
const PUBLIC_DIR = fileURLToPath(new URL("../public/", import.meta.url));
const CONFLICT_ENABLED = process.env.PREVIEW_CONFLICT === "1";
const MAX_BODY_BYTES = 16 * 1024;
const ADMIN_TOKEN = process.env.PREVIEW_ADMIN_TOKEN ?? "demo";

const DAY_STATE_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Demo operator configuration, mirroring the shape the real SiteConfigStore persists. */
const siteConfig = {
  version: 1,
  updatedAt: new Date().toISOString(),
  updatedBy: "preview",
  policy: {
    bookingWindowDays: 14,
    minLeadHours: 2,
    mode: "open",
    focus: null,
    notice: "",
    blackouts: [],
    closedWeekdays: [],
    defaultMaxPax: 4,
  },
  templates: [
    {
      id: "weekday-mornings",
      label: "Morning tandems",
      weekdays: [1, 2, 3, 4, 5],
      times: ["09:00", "11:00"],
      durationMinutes: 120,
      maxPax: 4,
      enabled: false,
    },
  ],
  audit: [],
};


const FLIGHT_TIMES = [
  { hour: 9, minute: 0 },
  { hour: 11, minute: 30 },
  { hour: 14, minute: 0 },
  { hour: 16, minute: 30 },
];
const CAPACITIES = [3, 2, 1, 4];
const DAYS_AHEAD = 4;
const FLIGHT_DURATION_MS = 60 * 60 * 1000;

/** slotId -> booked passengers, mutated by successful demo bookings. */
const bookedPax = new Map();

function buildSlots(now = new Date()) {
  const slots = [];
  for (let dayOffset = 0; dayOffset < DAYS_AHEAD; dayOffset += 1) {
    const dayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + dayOffset);
    FLIGHT_TIMES.forEach((time, index) => {
      const startMs = dayStart + time.hour * 3_600_000 + time.minute * 60_000;
      const endMs = startMs + FLIGHT_DURATION_MS;
      if (endMs <= now.getTime()) return;
      slots.push({
        id: `demo-${new Date(startMs).toISOString()}`,
        summary: "Tandem flight",
        start: new Date(startMs),
        end: new Date(endMs),
        maxPax: CAPACITIES[index % CAPACITIES.length],
      });
    });
  }
  return slots.map((slot, index) => ({
    ...slot,
    // Keep a deliberate 409 path available so the conflict UI can be reviewed.
    id: CONFLICT_ENABLED && index === 1 ? `${slot.id}-taken` : slot.id,
    bookedPax: bookedPax.get(slot.id) ?? 0,
    status: "OPEN",
    // A little variety so the admin verdict column is not uniform.
    verdict: index % 5 === 3 ? "MARGINAL" : "FLYABLE",
  }));
}

function clamp01(value) {
  return Math.min(1, Math.max(0, value));
}

function dateKeyOf(date) {
  return date.toISOString().slice(0, 10);
}

function isClosedDay(dateKey) {
  const weekday = new Date(`${dateKey}T00:00:00Z`).getUTCDay();
  return (
    siteConfig.policy.blackouts.includes(dateKey) ||
    siteConfig.policy.closedWeekdays.includes(weekday)
  );
}

function inWindow(dateKey, today) {
  const end = new Date(`${today}T00:00:00Z`);
  end.setUTCDate(end.getUTCDate() + siteConfig.policy.bookingWindowDays - 1);
  return dateKey <= dateKeyOf(end);
}

function isFocus(dateKey) {
  const focus = siteConfig.policy.focus;
  if (!focus) return false;
  return dateKey >= focus.from && dateKey <= focus.to;
}

/** Mirrors the real policy pass closely enough for the demo banner and rail. */
function applyPolicy(slots) {
  const now = Date.now();
  const today = dateKeyOf(new Date());
  const leadMs = siteConfig.policy.minLeadHours * 3_600_000;
  return slots.map((slot) => {
    const date = dateKeyOf(slot.start);
    let hiddenReason = null;
    if (date < today) hiddenReason = "past";
    else if (slot.start.getTime() - now < leadMs) hiddenReason = "lead-time";
    else if (siteConfig.policy.blackouts.includes(date)) hiddenReason = "blackout";
    else if (isClosedDay(date)) hiddenReason = "closed";
    else if (!inWindow(date, today)) hiddenReason = "window";
    else if (siteConfig.policy.mode === "focus-only" && !isFocus(date)) hiddenReason = "focus";
    const inFocus = isFocus(date);
    const policyWantsIt = siteConfig.policy.mode === "open" || inFocus;
    return {
      ...slot,
      date,
      hiddenReason,
      recommended: hiddenReason === null && policyWantsIt && slot.verdict !== "NO_GO",
    };
  });
}

function buildDayRail(slots, days = 14) {
  const today = dateKeyOf(new Date());
  const rail = [];
  const horizon = Math.min(days, siteConfig.policy.bookingWindowDays);
  for (let offset = 0; offset < horizon; offset += 1) {
    const day = new Date(`${today}T00:00:00Z`);
    day.setUTCDate(day.getUTCDate() + offset);
    const dateKey = dateKeyOf(day);
    const entries = slots.filter((slot) => slot.date === dateKey);
    const live = entries.filter((slot) => slot.hiddenReason === null);
    const sellable = live.filter((slot) => slot.status === "OPEN" && slot.bookedPax < slot.maxPax);
    let state = "locked";
    if (isClosedDay(dateKey)) state = "closed";
    else if (siteConfig.policy.blackouts.includes(dateKey)) state = "blackout";
    else if (sellable.length === 0) state = "locked";
    else if (live.every((slot) => slot.bookedPax >= slot.maxPax)) state = "full";
    else state = "open";
    rail.push({
      date: dateKey,
      state,
      total: entries.length,
      bookable: sellable.length,
      seatsLeft: sellable.reduce((total, slot) => total + (slot.maxPax - slot.bookedPax), 0),
      bestScore: null,
      recommended: live.some((slot) => slot.recommended),
      focus: isFocus(dateKey),
    });
  }
  return rail;
}

/** Preview config ETag: version-based, so stale writes get a real 409 like the calendar store. */
function configEtag() {
  return `v${siteConfig.version}`;
}

/** Mirrors `summarisePolicy` in src/services/booking-policy.ts: the shape the UI reads. */
function buildPolicySummary() {
  return {
    windowDays: siteConfig.policy.bookingWindowDays,
    windowEndsOn: dateKeyOf(new Date(Date.now() + (siteConfig.policy.bookingWindowDays - 1) * 86_400_000)),
    minLeadHours: siteConfig.policy.minLeadHours,
    mode: siteConfig.policy.mode,
    focus: siteConfig.policy.focus,
    blackouts: [...siteConfig.policy.blackouts],
    closedWeekdays: [...siteConfig.policy.closedWeekdays],
    notice: siteConfig.policy.notice,
  };
}

function buildNotice() {
  const today = dateKeyOf(new Date());
  if (siteConfig.policy.blackouts.includes(today)) {
    return { tone: "closed", headline: "No flights today", detail: siteConfig.policy.notice || "The site is closed today." };
  }
  const focus = siteConfig.policy.focus;
  if (siteConfig.policy.mode !== "open" && focus && focus.to >= today) {
    return {
      tone: "focus",
      headline: focus.label,
      detail: siteConfig.policy.notice || `We are prioritising ${focus.from} to ${focus.to}.`,
    };
  }
  if (siteConfig.policy.notice.trim()) {
    return { tone: "info", headline: "Notice", detail: siteConfig.policy.notice.trim() };
  }
  return null;
}

/** Deterministic fake forecast: shaped like the real payload so the charts can be exercised. */
function buildWeatherPreview(hours = 24) {
  const firstHour = Math.floor(Date.now() / 3_600_000) * 3_600_000;
  const series = {
    generatedAt: new Date().toISOString(),
    horizonHours: hours,
    hours: [],
    windows: [],
    failures: [],
    profile: {
      maxWindKmh: 26,
      minWindKmh: 12,
      maxGustSpreadKmh: 8,
      idealHeading: 340,
      headingTolerance: 35,
      maxRainProbability: 20,
      maxPrecipitationMm: 1,
      minCloudCeilingM: 300,
      maxCapeJkg: 1000,
    },
  };

  for (let index = 0; index < hours; index += 1) {
    const time = new Date(firstHour + index * 3_600_000);
    const swell = Math.sin((index + 6) / 4);
    const wind = Number((18 + swell * 9).toFixed(1));
    const gust = Number((wind + 2 + Math.max(0, swell) * 4).toFixed(1));
    const rain = Math.round(Math.max(0, 30 + swell * 40));
    const spread = Number((gust - wind).toFixed(1));
    const score = Math.round(
      Math.min(
        clamp01((26 - wind) / (26 * 0.25)),
        clamp01((8 - spread) / (8 * 0.25)),
        clamp01((20 - rain) / (20 * 0.25)),
      ) * 100,
    );
    const ruleFailures = [];
    if (wind > 26) ruleFailures.push({ rule: "wind_max", label: "Maximum wind", models: ["ecmwf_ifs025", "gfs_seamless"] });
    if (rain > 20) ruleFailures.push({ rule: "rain_probability", label: "Rain probability", models: ["gfs_seamless"] });
    const verdict = ruleFailures.length > 0 ? "NO_GO" : score >= 60 ? "FLYABLE" : "MARGINAL";

    series.hours.push({
      time: time.toISOString(),
      date: dateKeyOf(time),
      label: time.toISOString().slice(11, 16),
      score,
      agreement: ruleFailures.length > 0 ? 0.5 : 1,
      verdict,
      models: [
        {
          model: "ecmwf_ifs025",
          wind10Kmh: wind,
          wind80Kmh: Number((wind + 2).toFixed(1)),
          gustSpreadKmh: spread,
          directionDeg: 340,
          rainProbability: rain,
          precipitationMm: 0,
          cloudCeilingM: 900,
          capeJkg: 120,
          score,
          pass: ruleFailures.length === 0,
        },
      ],
      ruleFailures,
      messages: ruleFailures.map((failure) =>
        failure.rule === "wind_max"
          ? "ecmwf_ifs025 wind exceeds the site maximum"
          : "gfs_seamless rain probability exceeds the site limit",
      ),
    });
  }

  series.windows = findWindowsPreview(series.hours);
  return series;
}

function findWindowsPreview(hours, minimumHours = 2) {
  const windows = [];
  let current = [];
  const flush = () => {
    if (current.length >= minimumHours) {
      const first = current[0];
      const last = current[current.length - 1];
      const average = Math.round(
        current.reduce((total, hour) => total + hour.score, 0) / current.length,
      );
      windows.push({ from: first.time, to: last.time, date: first.date, hours: current.length, averageScore: average });
    }
    current = [];
  };
  for (const hour of hours) {
    if (hour.verdict === "FLYABLE") current.push(hour);
    else flush();
  }
  flush();
  return windows;
}

function buildWeatherAnalyticsPreview(series) {
  const verdicts = { FLYABLE: 0, MARGINAL: 0, NO_GO: 0 };
  for (const hour of series.hours) verdicts[hour.verdict] += 1;
  const total = series.hours.length || 1;
  const ruleCounts = new Map();
  for (const hour of series.hours) {
    for (const failure of hour.ruleFailures) {
      const entry = ruleCounts.get(failure.rule) ?? { rule: failure.rule, label: failure.label, hours: 0 };
      entry.hours += 1;
      ruleCounts.set(failure.rule, entry);
    }
  }
  const byDate = new Map();
  for (const hour of series.hours) {
    const bucket = byDate.get(hour.date) ?? [];
    bucket.push(hour);
    byDate.set(hour.date, bucket);
  }
  const slots = applyPolicy(buildSlots());
  return {
    generatedAt: series.generatedAt,
    verdicts,
    hours: series.hours.length,
    averageScore: Math.round(series.hours.reduce((total2, hour) => total2 + hour.score, 0) / total),
    averageAgreement: Number(
      (series.hours.reduce((total2, hour) => total2 + hour.agreement, 0) / total).toFixed(2),
    ),
    disagreementHours: series.hours.filter((hour) => hour.agreement > 0 && hour.agreement < 1).length,
    ruleStats: [...ruleCounts.values()]
      .map((entry) => ({ ...entry, share: entry.hours / total }))
      .sort((left, right) => right.hours - left.hours),
    daily: [...byDate.entries()]
      .sort((left, right) => left[0].localeCompare(right[0]))
      .map(([date, dayHours]) => {
        const scores = dayHours.map((hour) => hour.score);
        return {
          date,
          hours: dayHours.length,
          flyable: dayHours.filter((hour) => hour.verdict === "FLYABLE").length,
          marginal: dayHours.filter((hour) => hour.verdict === "MARGINAL").length,
          noGo: dayHours.filter((hour) => hour.verdict === "NO_GO").length,
          bestScore: Math.max(...scores),
          worstScore: Math.min(...scores),
          averageScore: Math.round(scores.reduce((a, b) => a + b, 0) / scores.length),
        };
      }),
    slots: {
      total: slots.length,
      open: slots.filter((slot) => slot.status === "OPEN").length,
      locked: slots.filter((slot) => slot.status === "LOCKED").length,
      standby: slots.filter((slot) => slot.status === "STANDBY").length,
      cancelled: slots.filter((slot) => slot.status === "CANCELLED").length,
      confirmed: slots.filter((slot) => slot.status === "CONFIRMED").length,
      seatsSold: slots.reduce((total2, slot) => total2 + slot.bookedPax, 0),
      seatsOffered: slots.reduce((total2, slot) => total2 + slot.maxPax, 0),
      utilization: 0,
      manualOverrides: 0,
    },
    windows: series.windows,
  };
}

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
};

function sendJson(response, statusCode, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    ...extraHeaders,
  });
  response.end(body);
}

async function readJsonBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error("Request body is too large");
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (raw.trim() === "") return {};
  try {
    return JSON.parse(raw);
  } catch {
    const error = new Error("Body is not valid JSON but content-type is set to 'application/json'");
    error.statusCode = 400;
    throw error;
  }
}

function validateBooking(body) {
  const passenger = body?.passenger ?? {};
  const problems = [];
  if (typeof body?.slotId !== "string" || body.slotId.trim() === "") problems.push("slotId");
  if (typeof passenger.name !== "string" || passenger.name.trim() === "") problems.push("name");
  const weight = passenger.weight_kg;
  if (typeof weight !== "number" || !Number.isFinite(weight) || weight < 20 || weight > 250) {
    problems.push("weight_kg");
  }
  if (typeof passenger.contact !== "string" || passenger.contact.trim().length < 3) {
    problems.push("contact");
  }
  if (
    typeof passenger.emergency_contact !== "string" ||
    passenger.emergency_contact.trim().length < 3
  ) {
    problems.push("emergency_contact");
  }
  return problems;
}

async function serveStatic(pathname, response) {
  // `/admin` mirrors the production route, which serves admin.html.
  const relative =
    pathname === "/"
      ? "index.html"
      : pathname === "/admin"
        ? "admin.html"
        : decodeURIComponent(pathname).replace(/^\/+/, "");
  const target = normalize(join(PUBLIC_DIR, relative));
  const publicPrefix = PUBLIC_DIR.endsWith(sep) ? PUBLIC_DIR : `${PUBLIC_DIR}${sep}`;
  if (!target.startsWith(publicPrefix)) return sendJson(response, 404, { error: "Not found" });
  try {
    const info = await stat(target);
    if (!info.isFile()) return sendJson(response, 404, { error: "Not found" });
    const body = await readFile(target);
    response.writeHead(200, {
      "content-type": MIME_TYPES[extname(target).toLowerCase()] ?? "application/octet-stream",
      "content-length": body.length,
      "cache-control": "no-store",
    });
    response.end(body);
  } catch {
    sendJson(response, 404, { error: "Not found" });
  }
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  const { pathname } = url;
  const method = request.method ?? "GET";

  try {
    if (pathname === "/api/health") return sendJson(response, 200, { status: "ok", mode: "demo" });

    if (pathname === "/api/site") {
      return sendJson(response, 200, { name: "Updraft demo site", timezone: "UTC" });
    }

    if (pathname === "/api/slots/available" && method === "GET") {
      const from = url.searchParams.get("from");
      const to = url.searchParams.get("to");
      const rangeStart = from ? new Date(from).getTime() : Date.now();
      const rangeEnd = to ? new Date(to).getTime() : rangeStart + 72 * 3_600_000;
      if (!Number.isFinite(rangeStart) || !Number.isFinite(rangeEnd)) {
        return sendJson(response, 400, { error: "from and to must be ISO date strings" });
      }
      const priced = applyPolicy(buildSlots());
      const slots = priced
        .filter((slot) => slot.hiddenReason === null)
        .filter((slot) => slot.bookedPax < slot.maxPax)
        .filter((slot) => slot.start.getTime() >= rangeStart && slot.start.getTime() <= rangeEnd)
        .map((slot) => ({
          id: slot.id,
          summary: slot.summary,
          start: slot.start.toISOString(),
          end: slot.end.toISOString(),
          remainingCapacity: slot.maxPax - slot.bookedPax,
          recommended: slot.recommended,
        }));
      return sendJson(response, 200, {
        slots,
        policy: buildPolicySummary(),
        notice: buildNotice(),
        days: buildDayRail(priced),
      });
    }

    if (pathname === "/api/slots/book" && method === "POST") {
      const body = await readJsonBody(request);
      const problems = validateBooking(body);
      if (problems.length > 0) {
        return sendJson(response, 400, { error: `Invalid booking details: ${problems.join(", ")}` });
      }
      const slot = buildSlots().find((candidate) => candidate.id === body.slotId);
      if (!slot) {
        return sendJson(response, 404, { error: "Calendar event is not a valid booking slot" });
      }
      if (slot.id.endsWith("-taken")) {
        return sendJson(response, 409, {
          error: "That time was just booked by someone else. Pick another flight.",
        });
      }
      if (slot.bookedPax >= slot.maxPax) {
        return sendJson(response, 409, { error: "This flight is fully booked." });
      }
      const nextBooked = slot.bookedPax + 1;
      bookedPax.set(slot.id, nextBooked);
      console.log(`[demo] booked ${body.passenger.name} on ${slot.start.toISOString()}`);
      return sendJson(response, 201, {
        slotId: slot.id,
        bookedPax: nextBooked,
        remainingCapacity: slot.maxPax - nextBooked,
      });
    }

    if (pathname === "/api/admin/evaluate-now") {
      return sendJson(response, 503, {
        error: "Admin evaluation is disabled in preview mode: no worker is running",
      });
    }

    if (pathname === "/api/admin/session") {
      if (method === "DELETE") {
        response.setHeader("Set-Cookie", "pg_admin=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0");
        return sendJson(response, 200, { authenticated: false });
      }
      if (method === "POST") {
        const body = await readJsonBody(request);
        if (body?.token !== ADMIN_TOKEN) return sendJson(response, 401, { error: "Invalid token" });
        response.setHeader(
          "Set-Cookie",
          "pg_admin=demo-session; Path=/; HttpOnly; SameSite=Strict; Max-Age=28800",
        );
        return sendJson(response, 200, {
          authenticated: true,
          expiresAt: new Date(Date.now() + 8 * 3_600_000).toISOString(),
        });
      }
      const cookie = request.headers.cookie ?? "";
      return sendJson(response, 200, {
        configured: true,
        authenticated: cookie.includes("pg_admin=demo-session"),
        method: cookie.includes("pg_admin=demo-session") ? "session" : null,
        csrfHeader: "x-admin-csrf",
      });
    }

    const usingCookie = (request.headers.cookie ?? "").includes("pg_admin=demo-session");
    if (pathname.startsWith("/api/admin/") && !usingCookie) {
      return sendJson(response, 401, { error: "Unauthorized" });
    }
    // Mirrors the real guard: cookie sessions must echo the CSRF header on writes.
    if (usingCookie && method !== "GET" && request.headers["x-admin-csrf"] !== "1") {
      return sendJson(response, 403, { error: "Missing x-admin-csrf header" });
    }

    if (pathname === "/api/admin/config") {
      if (method === "PATCH") {
        const body = await readJsonBody(request);
        const ifMatch = request.headers["if-match"];
        // A blank If-Match is a client bug, not "no precondition": reject it like the server does.
        if (typeof ifMatch === "string" && ifMatch.trim() === "") {
          return sendJson(response, 400, { error: "If-Match must be a config revision, or omitted" });
        }
        if (typeof ifMatch === "string" && ifMatch !== configEtag()) {
          return sendJson(response, 409, {
            error: "Configuration changed since you loaded it. Reload the console and try again.",
          });
        }
        if (body?.policy && typeof body.policy === "object") {
          Object.assign(siteConfig.policy, body.policy);
          siteConfig.audit.push({
            at: new Date().toISOString(),
            actor: "preview",
            action: "config.update",
            target: "policy",
            detail: Object.keys(body.policy).join(", "),
          });
        }
        if (Array.isArray(body?.templates)) {
          siteConfig.templates = body.templates;
          siteConfig.audit.push({
            at: new Date().toISOString(),
            actor: "preview",
            action: "config.update",
            target: "templates",
            detail: `${body.templates.length} templates`,
          });
        }
        siteConfig.updatedAt = new Date().toISOString();
        siteConfig.version += 1;
        return sendJson(response, 200, { config: siteConfig, etag: configEtag() });
      }
      return sendJson(
        response,
        200,
        {
          config: siteConfig,
          etag: configEtag(),
          stored: true,
          notice: buildNotice(),
        },
        { etag: configEtag() },
      );
    }

    if (pathname === "/api/admin/overview") {
      const priced = applyPolicy(buildSlots());
      const counts = { OPEN: 0, LOCKED: 0, STANDBY: 0, CONFIRMED: 0, CANCELLED: 0 };
      for (const slot of priced) counts[slot.status] += 1;
      return sendJson(response, 200, {
        generatedAt: new Date().toISOString(),
        today: dateKeyOf(new Date()),
        etag: configEtag(),
        stored: true,
        policy: buildPolicySummary(),
        counts,
        total: priced.length,
        days: buildDayRail(priced),
        templates: siteConfig.templates,
        audit: siteConfig.audit.slice(-10).reverse(),
      });
    }

    if (pathname === "/api/admin/weather") {
      const series = buildWeatherPreview(24);
      return sendJson(response, 200, { series, analytics: buildWeatherAnalyticsPreview(series) });
    }

    if (pathname === "/api/admin/slots") {
      const priced = applyPolicy(buildSlots());
      return sendJson(response, 200, {
        slots: priced.map((slot) => ({
          id: slot.id,
          etag: "preview",
          summary: slot.summary,
          description: "",
          start: slot.start.toISOString(),
          end: slot.end.toISOString(),
          date: slot.date,
          time: slot.start.toISOString().slice(11, 16),
          status: slot.status,
          maxPax: slot.maxPax,
          bookedPax: slot.bookedPax,
          seatsLeft: slot.maxPax - slot.bookedPax,
          manualOverride: false,
          verdict: slot.verdict ?? null,
          confidence: null,
          lastEvaluatedAt: null,
          limitingFactors: [],
          reasoningSummary: null,
          hiddenReason: slot.hiddenReason,
          recommended: slot.recommended,
        })),
        from: new Date().toISOString(),
        to: new Date(Date.now() + 30 * 86_400_000).toISOString(),
        counts: priced.reduce(
          (counts, slot) => ({ ...counts, [slot.status]: (counts[slot.status] ?? 0) + 1 }),
          { OPEN: 0, LOCKED: 0, STANDBY: 0, CONFIRMED: 0, CANCELLED: 0 },
        ),
        total: priced.length,
        days: buildDayRail(priced),
        policy: buildPolicySummary(),
      });
    }

    if (pathname.startsWith("/api/admin/slots/")) {
      return sendJson(response, 503, {
        error: "Slot mutations are read-only in preview mode.",
      });
    }

    if (pathname.startsWith("/api/")) return sendJson(response, 404, { error: "Not found" });

    return await serveStatic(pathname, response);
  } catch (error) {
    const statusCode = typeof error?.statusCode === "number" ? error.statusCode : 500;
    if (statusCode >= 500) console.error("[demo] request failed", error);
    return sendJson(response, statusCode, {
      error: statusCode >= 500 ? "Internal server error" : error.message,
    });
  }
});

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(`Port ${PORT} is already in use. Set PREVIEW_PORT to a free port.`);
    process.exitCode = 1;
    return;
  }
  throw error;
});

server.listen(PORT, () => {
  console.log(`Demo booking preview: http://localhost:${PORT}`);
  console.log("Serving real public/ assets with in-memory sample slots. No credentials required.");
  if (CONFLICT_ENABLED) console.log("PREVIEW_CONFLICT=1: the second slot always returns 409.");
});
