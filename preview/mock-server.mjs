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
 */
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.PREVIEW_PORT ?? 3100);
const PUBLIC_DIR = fileURLToPath(new URL("../public/", import.meta.url));
const CONFLICT_ENABLED = process.env.PREVIEW_CONFLICT === "1";
const MAX_BODY_BYTES = 16 * 1024;

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
  }));
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

function sendJson(response, statusCode, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
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
  const relative = pathname === "/" ? "index.html" : decodeURIComponent(pathname).replace(/^\/+/, "");
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
      const slots = buildSlots()
        .filter((slot) => slot.start.getTime() >= rangeStart && slot.start.getTime() <= rangeEnd)
        .filter((slot) => slot.bookedPax < slot.maxPax)
        .map((slot) => ({
          id: slot.id,
          summary: slot.summary,
          start: slot.start.toISOString(),
          end: slot.end.toISOString(),
          remainingCapacity: slot.maxPax - slot.bookedPax,
        }));
      return sendJson(response, 200, { slots });
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
