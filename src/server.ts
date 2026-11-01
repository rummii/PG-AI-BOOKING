import "dotenv/config";
import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import Fastify, { type FastifyRequest } from "fastify";
import { z } from "zod";
import { config, site } from "./config/site.js";
import {
  CalendarConflictError,
  bookSlot,
  getSlotById,
  getUpcomingSlots,
  isCalendarConfigured,
} from "./services/calendar.js";
import { evaluateAndSyncSlot } from "./services/slot-evaluation.js";

const app = Fastify({ logger: { level: config.LOG_LEVEL } });

app.get("/", async (_request, reply) => {
  return reply.type("text/html; charset=utf-8").send(
    await readFile(new URL("../public/index.html", import.meta.url)),
  );
});

app.get("/styles.css", async (_request, reply) => {
  return reply.type("text/css; charset=utf-8").send(
    await readFile(new URL("../public/styles.css", import.meta.url)),
  );
});

app.get("/app.js", async (_request, reply) => {
  return reply.type("text/javascript; charset=utf-8").send(
    await readFile(new URL("../public/app.js", import.meta.url)),
  );
});

const passengerSchema = z.object({
  name: z.string().trim().min(1).max(120),
  weight_kg: z.number().finite().min(20).max(250),
  contact: z.string().trim().min(3).max(200),
  emergency_contact: z.string().trim().min(3).max(200),
});

const bookSchema = z.object({
  slotId: z.string().trim().min(1).max(200),
  passenger: passengerSchema,
});

const evaluateSchema = z
  .object({
    slotId: z.string().trim().min(1).max(200).optional(),
    date: z.string().trim().min(1).optional(),
  })
  .refine((body) => Boolean(body.slotId) !== Boolean(body.date), {
    message: "Provide exactly one of slotId or date",
  });

function isAdminAuthorized(request: FastifyRequest): boolean {
  const expected = config.ADMIN_API_TOKEN;
  if (!expected) return false;
  const authorization = request.headers.authorization;
  if (!authorization?.startsWith("Bearer ")) return false;
  const supplied = authorization.slice("Bearer ".length);
  const expectedBytes = Buffer.from(expected);
  const suppliedBytes = Buffer.from(supplied);
  return (
    expectedBytes.length === suppliedBytes.length &&
    timingSafeEqual(expectedBytes, suppliedBytes)
  );
}

function isoDateOrUndefined(value: unknown, field: string): Date | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`${field} must be an ISO date string`);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error(`${field} must be a valid ISO date string`);
  return parsed;
}

function clientErrorStatusCode(error: unknown): number {
  if (typeof error === "object" && error !== null) {
    const candidate = (error as { statusCode?: unknown }).statusCode;
    if (typeof candidate === "number" && candidate >= 400 && candidate < 600) return candidate;
  }
  return 500;
}

app.setErrorHandler((error, request, reply) => {
  const statusCode = clientErrorStatusCode(error);
  if (statusCode >= 500) {
    request.log.error({ err: error }, "Request failed");
  } else {
    request.log.warn({ err: error }, "Request rejected");
  }
  if (reply.sent) return;
  if (statusCode >= 500) return reply.status(500).send({ error: "Internal server error" });
  return reply
    .status(statusCode)
    .send({ error: error instanceof Error ? error.message : "Bad request" });
});

app.get("/api/health", async () => ({ status: "ok", timestamp: new Date().toISOString() }));

app.get("/api/site", async () => ({
  name: site.name,
  timezone: site.timezone,
}));

app.get("/api/slots/available", async (request, reply) => {
  if (!isCalendarConfigured()) {
    return reply.status(503).send({ error: "Flight availability is temporarily unavailable. Please check back soon." });
  }
  const query = request.query as Record<string, unknown>;
  let from: Date;
  let to: Date;
  try {
    from = isoDateOrUndefined(query.from, "from") ?? new Date();
    to = isoDateOrUndefined(query.to, "to") ?? new Date(from.getTime() + 72 * 3_600_000);
  } catch (error) {
    return reply.status(400).send({ error: error instanceof Error ? error.message : "Invalid date range" });
  }
  if (to <= from || to.getTime() - from.getTime() > 72 * 3_600_000) {
    return reply.status(400).send({ error: "Date range must be increasing and no longer than 72 hours" });
  }

  const slots = await getUpcomingSlots(from, to);
  return {
    slots: slots
      .filter((slot) => slot.status === "OPEN" && slot.bookedPax < slot.maxPax)
      .map((slot) => ({
        id: slot.id,
        summary: slot.summary.replace(/^\[(?:OPEN|STANDBY|LOCKED|CONFIRMED|WX CANCEL)\]\s*/i, ""),
        start: slot.start.toISOString(),
        end: slot.end.toISOString(),
        remainingCapacity: slot.maxPax - slot.bookedPax,
      })),
  };
});

app.post("/api/slots/book", async (request, reply) => {
  if (!isCalendarConfigured()) {
    return reply.status(503).send({ error: "Bookings are temporarily unavailable. Please try again later." });
  }
  const parsed = bookSchema.safeParse(request.body);
  if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
  try {
    const result = await bookSlot(parsed.data.slotId, parsed.data.passenger);
    return reply.status(201).send({ slotId: parsed.data.slotId, ...result });
  } catch (error) {
    if (error instanceof CalendarConflictError) return reply.status(409).send({ error: error.message });
    if (error instanceof Error && error.message === "Calendar event is not a valid booking slot") {
      return reply.status(404).send({ error: error.message });
    }
    throw error;
  }
});

app.post("/api/admin/evaluate-now", async (request, reply) => {
  if (!config.ADMIN_API_TOKEN) {
    return reply.status(503).send({ error: "Admin evaluation is disabled: ADMIN_API_TOKEN is not configured" });
  }
  if (!isAdminAuthorized(request)) return reply.status(401).send({ error: "Unauthorized" });
  const parsed = evaluateSchema.safeParse(request.body);
  if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });

  let slots;
  if (parsed.data.slotId) {
    const slot = await getSlotById(parsed.data.slotId);
    if (!slot) return reply.status(404).send({ error: "Slot not found" });
    slots = [slot];
  } else {
    const requestedDate = new Date(parsed.data.date!);
    if (!Number.isFinite(requestedDate.getTime())) {
      return reply.status(400).send({ error: "date must be a valid ISO date string" });
    }
    const timeMax = new Date(requestedDate.getTime() + 24 * 3_600_000);
    slots = await getUpcomingSlots(requestedDate, timeMax);
  }

  const results: Array<{ slotId: string; skipped: boolean; status?: string; error?: string }> = [];
  for (const slot of slots) {
    try {
      const result = await evaluateAndSyncSlot(slot);
      results.push({ slotId: slot.id, ...result });
    } catch (error) {
      request.log.error({ err: error, slotId: slot.id }, "Manual slot evaluation failed");
      results.push({
        slotId: slot.id,
        skipped: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { evaluated: results.length, results };
});

app.setNotFoundHandler(async (_request, reply) => {
  return reply.status(404).send({ error: "Not found" });
});

async function start(): Promise<void> {
  try {
    await app.listen({ port: config.PORT, host: "0.0.0.0" });
  } catch (error) {
    app.log.error(error, "Failed to start API server");
    process.exitCode = 1;
  }
}

const entryPoint = process.argv[1];
const isDirectRun =
  entryPoint !== undefined && import.meta.url === pathToFileURL(resolve(entryPoint)).href;
if (isDirectRun) void start();

export { app, start };
