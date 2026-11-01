import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { config } from "../config/site.js";
import {
  ADMIN_CSRF_HEADER,
  adminAuthEnabled,
  authorizeAdmin,
  clearedSessionCookie,
  createLoginThrottle,
  csrfSatisfied,
  issueSession,
  sessionCookie,
  sessionSecret,
} from "../services/admin-auth.js";
import { policyNotice } from "../services/booking-policy.js";
import {
  CalendarConflictError,
  applySlotOverride,
  cancelSlot,
  deleteSlot,
  getSlotById,
} from "../services/calendar.js";
import {
  SiteConfigConflictError,
  applyConfigPatch,
  getSiteConfigSnapshot,
  saveSiteConfig,
  siteConfigPatchSchema,
} from "../services/site-config.js";
import { evaluateAndSyncSlot } from "../services/slot-evaluation.js";
import {
  createManualSlot,
  listAdminSlots,
  materialiseTemplateSlots,
  toAdminSlot,
  type AdminSlot,
} from "../services/slot-admin.js";
import { localDateKey } from "../services/site-time.js";
import { buildWeatherAnalytics } from "../services/weather-analytics.js";
import { getForecastSeries } from "../services/weather-series.js";
import type { SlotEvent } from "../types.js";

/**
 * Admin control-plane routes. Everything here is behind a session cookie or the Bearer token,
 * and every write is either conflict-checked (ETag) or explicitly idempotent.
 */

const loginSchema = z.object({ token: z.string().min(1).max(400) });

/**
 * `If-Match` is optional, but a present-and-blank header must not be read as "no precondition":
 * falsy values skip the store's compare-and-swap guard, so a browser that sent `If-Match: ""`
 * would silently overwrite a config someone else just saved. Reject it instead.
 * Returns the revision, `null` when the header is absent, or `undefined` when it replied with 400.
 */
function readIfMatch(request: FastifyRequest, reply: FastifyReply): string | null | undefined {
  const header = request.headers["if-match"];
  if (header === undefined) return null;
  const value = typeof header === "string" ? header.trim() : "";
  if (value === "") {
    reply.status(400).send({ error: "If-Match must be a config revision, or omitted" });
    return undefined;
  }
  return value;
}

const createSlotSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  durationMinutes: z.number().int().min(30).max(480),
  maxPax: z.number().int().min(1).max(16),
  label: z.string().trim().min(1).max(120),
  note: z.string().trim().max(500).optional(),
});

const overrideSchema = z
  .object({
    status: z.enum(["OPEN", "LOCKED", "STANDBY", "CONFIRMED", "CANCELLED"]).optional(),
    maxPax: z.number().int().min(1).max(16).optional(),
    manualOverride: z.boolean().optional(),
    reason: z.string().trim().max(500).optional(),
  })
  .refine((body) => Object.keys(body).length > 0, { message: "Nothing to update" });

const cancelSchema = z.object({ reason: z.string().trim().min(3).max(500) });

export function adminControlPlaneEnabled(): boolean {
  return config.ADMIN_WEB_ENABLED && adminAuthEnabled();
}

function toSlotEvent(slot: AdminSlot): SlotEvent {
  return {
    id: slot.id,
    ...(slot.etag ? { etag: slot.etag } : {}),
    summary: slot.summary,
    description: slot.description,
    start: new Date(slot.start),
    end: new Date(slot.end),
    status: slot.status,
    maxPax: slot.maxPax,
    bookedPax: slot.bookedPax,
    manualOverride: slot.manualOverride,
    ...(slot.verdict ? { verdict: slot.verdict } : {}),
    ...(slot.confidence !== null ? { confidence: slot.confidence } : {}),
    ...(slot.lastEvaluatedAt ? { lastEvaluatedAt: slot.lastEvaluatedAt } : {}),
  };
}

export function registerAdminRoutes(app: FastifyInstance): void {
  const throttle = createLoginThrottle();

  const guard = (request: FastifyRequest, reply: FastifyReply): boolean => {
    if (!adminControlPlaneEnabled()) {
      reply.status(404).send({ error: "Not found" });
      return false;
    }
    const result = authorizeAdmin(request);
    if (!result.authorized) {
      reply.status(401).send({ error: "Unauthorized" });
      return false;
    }
    if (request.method !== "GET" && !csrfSatisfied(request, result.method)) {
      reply.status(403).send({ error: `Missing ${ADMIN_CSRF_HEADER} header` });
      return false;
    }
    return true;
  };

  const fail = (reply: FastifyReply, error: unknown, context: string): void => {
    if (error instanceof CalendarConflictError || error instanceof SiteConfigConflictError) {
      reply.status(409).send({ error: error.message });
      return;
    }
    if (error instanceof z.ZodError) {
      reply.status(400).send({ error: error.flatten() });
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    const clientFacing = /^(Slot |Capacity |Cannot delete|Configuration |Site configuration is)/.test(
      message,
    );
    if (!clientFacing) {
      app.log.error({ err: error, context }, "Admin request failed");
      reply.status(502).send({ error: "Calendar or upstream service failed" });
      return;
    }
    reply.status(400).send({ error: message });
  };

  /**
   * Config reads touch the calendar (or the config file). When that store is unreachable the
   * console should say so plainly instead of surfacing a 500 from the global handler.
   */
  const snapshotOrFail = async (reply: FastifyReply) => {
    try {
      return await getSiteConfigSnapshot();
    } catch (error) {
      app.log.error({ err: error, context: "config.read" }, "Admin request failed");
      reply
        .status(503)
        .send({ error: "Site configuration is unavailable. Check the calendar credentials." });
      return null;
    }
  };

  app.get("/api/admin/session", async (request) => {
    const result = authorizeAdmin(request);
    return {
      configured: adminControlPlaneEnabled(),
      authenticated: result.authorized,
      method: result.method,
      csrfHeader: ADMIN_CSRF_HEADER,
    };
  });

  app.post("/api/admin/session", async (request, reply) => {
    if (!adminControlPlaneEnabled()) return reply.status(404).send({ error: "Not found" });
    const key = request.ip;
    if (throttle.isBlocked(key)) {
      return reply.status(429).send({ error: "Too many attempts. Try again in a few minutes." });
    }
    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
    const expected = config.ADMIN_API_TOKEN;
    const secret = sessionSecret();
    if (!expected || !secret) {
      return reply.status(503).send({ error: "Admin sign-in is not configured on this server" });
    }
    if (parsed.data.token !== expected) {
      throttle.recordFailure(key);
      return reply.status(401).send({ error: "Invalid token" });
    }
    throttle.reset(key);
    const ttlSeconds = config.ADMIN_SESSION_TTL_HOURS * 3600;
    const session = issueSession(secret);
    reply.header("Set-Cookie", sessionCookie(session.token, ttlSeconds, request.protocol === "https"));
    return { authenticated: true, expiresAt: session.expiresAt.toISOString() };
  });

  app.delete("/api/admin/session", async (request, reply) => {
    reply.header("Set-Cookie", clearedSessionCookie(request.protocol === "https"));
    return { authenticated: false };
  });

  app.get("/api/admin/config", async (request, reply) => {
    if (!guard(request, reply)) return;
    const snapshot = await snapshotOrFail(reply);
    if (!snapshot) return;
    return {
      config: snapshot.config,
      etag: snapshot.etag,
      stored: !snapshot.fellBackToDefaults,
      notice: policyNotice({ policy: snapshot.config.policy, now: new Date() }),
    };
  });

  app.patch("/api/admin/config", async (request, reply) => {
    if (!guard(request, reply)) return;
    const parsed = siteConfigPatchSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
    const snapshot = await snapshotOrFail(reply);
    if (!snapshot) return;
    const actor = authorizeAdmin(request).method === "token" ? "api-token" : "operator";
    const touched = Object.keys(parsed.data.policy ?? {});
    const detail = touched.length > 0 ? touched.join(", ") : "templates";
    const ifMatch = readIfMatch(request, reply);
    if (ifMatch === undefined) return;
    const expectedEtag = ifMatch ?? snapshot.etag;
    try {
      const next = applyConfigPatch(snapshot.config, parsed.data, actor, detail);
      const saved = await saveSiteConfig(next, expectedEtag);
      return { config: saved.config, etag: saved.etag };
    } catch (error) {
      fail(reply, error, "config.patch");
      return;
    }
  });

  app.get("/api/admin/overview", async (request, reply) => {
    if (!guard(request, reply)) return;
    const now = new Date();
    const snapshot = await snapshotOrFail(reply);
    if (!snapshot) return;
    try {
      const slots = await listAdminSlots(snapshot.config, now, 30);
      return {
        generatedAt: now.toISOString(),
        today: localDateKey(now),
        etag: snapshot.etag,
        stored: !snapshot.fellBackToDefaults,
        policy: slots.policy,
        counts: slots.counts,
        total: slots.total,
        days: slots.days,
        templates: snapshot.config.templates,
        audit: snapshot.config.audit.slice(-10).reverse(),
      };
    } catch (error) {
      fail(reply, error, "overview");
    }
  });

  app.get("/api/admin/weather", async (request, reply) => {
    if (!guard(request, reply)) return;
    const query = request.query as Record<string, unknown>;
    const rawHours = Number(query.hours ?? 48);
    const hours = Number.isFinite(rawHours) ? Math.max(6, Math.min(rawHours, 72)) : 48;
    const now = new Date();
    const snapshot = await snapshotOrFail(reply);
    if (!snapshot) return;
    try {
      const series = await getForecastSeries({ hours, now });
      const slots = await listAdminSlots(snapshot.config, now, 30);
      return {
        series,
        analytics: buildWeatherAnalytics(series, slots.slots.map(toSlotEvent)),
      };
    } catch (error) {
      fail(reply, error, "weather");
    }
  });

  app.get("/api/admin/slots", async (request, reply) => {
    if (!guard(request, reply)) return;
    const query = request.query as Record<string, unknown>;
    const rawDays = Number(query.days ?? 30);
    const days = Number.isFinite(rawDays) ? Math.max(1, Math.min(rawDays, 90)) : 30;
    const snapshot = await snapshotOrFail(reply);
    if (!snapshot) return;
    try {
      return await listAdminSlots(snapshot.config, new Date(), days);
    } catch (error) {
      fail(reply, error, "slots.list");
    }
  });

  app.post("/api/admin/slots", async (request, reply) => {
    if (!guard(request, reply)) return;
    const parsed = createSlotSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
    try {
      const slot = await createManualSlot({
        date: parsed.data.date,
        time: parsed.data.time,
        durationMinutes: parsed.data.durationMinutes,
        maxPax: parsed.data.maxPax,
        label: parsed.data.label,
        ...(parsed.data.note ? { note: parsed.data.note } : {}),
      });
      return reply.status(201).send({ slot });
    } catch (error) {
      fail(reply, error, "slots.create");
      return;
    }
  });

  app.post("/api/admin/slots/materialise", async (request, reply) => {
    if (!guard(request, reply)) return;
    const snapshot = await snapshotOrFail(reply);
    if (!snapshot) return;
    try {
      const result = await materialiseTemplateSlots(snapshot.config, new Date());
      return {
        created: result.created.length,
        planned: result.planned,
        skippedDates: result.skippedDates,
        errors: result.errors,
        slots: result.created,
      };
    } catch (error) {
      fail(reply, error, "slots.materialise");
      return;
    }
  });

  app.patch("/api/admin/slots/:id", async (request, reply) => {
    if (!guard(request, reply)) return;
    const params = request.params as { id?: string };
    if (!params.id) return reply.status(400).send({ error: "Missing slot id" });
    const parsed = overrideSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
    const ifMatch = readIfMatch(request, reply);
    if (ifMatch === undefined) return;
    try {
      const slot = await applySlotOverride(params.id, {
        ...(parsed.data.status ? { status: parsed.data.status } : {}),
        ...(parsed.data.maxPax !== undefined ? { maxPax: parsed.data.maxPax } : {}),
        ...(parsed.data.manualOverride !== undefined
          ? { manualOverride: parsed.data.manualOverride }
          : {}),
        ...(parsed.data.reason ? { reason: parsed.data.reason } : {}),
        ...(ifMatch ? { expectedEtag: ifMatch } : {}),
      });
      return { slot: toAdminSlot(slot, null, false) };
    } catch (error) {
      fail(reply, error, "slots.patch");
      return;
    }
  });

  app.post("/api/admin/slots/:id/cancel", async (request, reply) => {
    if (!guard(request, reply)) return;
    const params = request.params as { id?: string };
    if (!params.id) return reply.status(400).send({ error: "Missing slot id" });
    const parsed = cancelSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
    try {
      const slot = await cancelSlot(params.id, parsed.data.reason);
      return { slot: toAdminSlot(slot, null, false) };
    } catch (error) {
      fail(reply, error, "slots.cancel");
      return;
    }
  });

  app.post("/api/admin/slots/:id/evaluate", async (request, reply) => {
    if (!guard(request, reply)) return;
    const params = request.params as { id?: string };
    if (!params.id) return reply.status(400).send({ error: "Missing slot id" });
    const slot = await getSlotById(params.id);
    if (!slot) return reply.status(404).send({ error: "Slot not found" });
    try {
      const result = await evaluateAndSyncSlot(slot);
      return { slotId: params.id, ...result };
    } catch (error) {
      fail(reply, error, "slots.evaluate");
      return;
    }
  });

  app.delete("/api/admin/slots/:id", async (request, reply) => {
    if (!guard(request, reply)) return;
    const params = request.params as { id?: string };
    if (!params.id) return reply.status(400).send({ error: "Missing slot id" });
    try {
      await deleteSlot(params.id);
      return reply.status(204).send();
    } catch (error) {
      fail(reply, error, "slots.delete");
      return;
    }
  });
}
