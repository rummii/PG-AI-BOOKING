import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import { config } from "../config/site.js";
import type { AuditEntry, BookingPolicy, ScheduleTemplate, SiteConfig } from "../types.js";
import { readConfigEvent, writeConfigEvent } from "./calendar.js";

/**
 * Site configuration lives in Google Calendar alongside the slots it describes, inside one
 * reserved event parked in 1990. The store interface keeps that choice swappable, so moving to
 * SQLite later is a different adapter rather than a rewrite of the admin API.
 */

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Guard so a runaway audit log cannot exceed Calendar's event-description budget. */
export const MAX_CONFIG_BYTES = 8_000;
export const MAX_AUDIT_ENTRIES = 40;
export const MAX_TEMPLATES = 12;
export const MAX_BLACKOUTS = 60;

const dateString = z.string().regex(DATE_PATTERN, "must be a YYYY-MM-DD date");
const timeString = z.string().regex(TIME_PATTERN, "must be an HH:MM time");
const weekday = z.number().int().min(0).max(6);

export const focusPeriodSchema = z
  .object({
    label: z.string().trim().min(1).max(60),
    from: dateString,
    to: dateString,
  })
  .refine((value) => value.from <= value.to, {
    message: "focus window must end on or after it starts",
    path: ["to"],
  });

export const bookingPolicyObject = z.object({
  bookingWindowDays: z.number().int().min(1).max(90),
  minLeadHours: z.number().int().min(0).max(168),
  mode: z.enum(["open", "focus-first", "focus-only"]),
  focus: focusPeriodSchema.nullable(),
  notice: z.string().trim().max(240),
  blackouts: z.array(dateString).max(MAX_BLACKOUTS),
  closedWeekdays: z.array(weekday).max(7),
  defaultMaxPax: z.number().int().min(1).max(16),
});

export const bookingPolicySchema = bookingPolicyObject.superRefine((policy, ctx) => {
  if (policy.mode !== "open" && policy.focus === null) {
    ctx.addIssue({
      code: "custom",
      message: "focus modes need a focus window",
      path: ["focus"],
    });
  }
});

export const scheduleTemplateSchema = z.object({
  id: z
    .string()
    .trim()
    .min(1)
    .max(40)
    .regex(/^[a-z0-9-]+$/, "use lowercase letters, digits and dashes"),
  label: z.string().trim().min(1).max(60),
  weekdays: z.array(weekday).min(1).max(7),
  times: z.array(timeString).min(1).max(8),
  durationMinutes: z.number().int().min(30).max(480),
  maxPax: z.number().int().min(1).max(16),
  enabled: z.boolean(),
});

export const auditEntrySchema = z.object({
  at: z.string().min(10).max(40),
  actor: z.string().trim().min(1).max(80),
  action: z.string().trim().min(1).max(40),
  target: z.string().trim().max(120),
  detail: z.string().trim().max(300),
});

export const siteConfigSchema = z.object({
  version: z.literal(1),
  updatedAt: z.string().min(10).max(40),
  updatedBy: z.string().trim().min(1).max(80),
  policy: bookingPolicySchema,
  templates: z.array(scheduleTemplateSchema).max(MAX_TEMPLATES),
  audit: z.array(auditEntrySchema).max(MAX_AUDIT_ENTRIES),
});

export const bookingPolicyPatchSchema = bookingPolicyObject.partial();
export const siteConfigPatchSchema = z.object({
  policy: bookingPolicyPatchSchema.optional(),
  templates: z.array(scheduleTemplateSchema).max(MAX_TEMPLATES).optional(),
  updatedBy: z.string().trim().min(1).max(80).optional(),
});

export function defaultPolicy(): BookingPolicy {
  return {
    bookingWindowDays: config.ADMIN_BOOKING_WINDOW_DAYS,
    minLeadHours: 12,
    mode: "open",
    focus: null,
    notice: "",
    blackouts: [],
    closedWeekdays: [],
    defaultMaxPax: config.DEFAULT_MAX_PAX,
  };
}

export function defaultSiteConfig(now: Date = new Date()): SiteConfig {
  return {
    version: 1,
    updatedAt: now.toISOString(),
    updatedBy: "system",
    policy: defaultPolicy(),
    templates: [],
    audit: [],
  };
}

/**
 * Reads a stored config, tolerating the surrounding prose an operator might paste into the
 * event description. Returns `null` when the payload is missing or no longer valid, which the
 * stores treat as "fall back to defaults" rather than as a fatal error.
 */
export function parseStoredConfig(raw: string | undefined): SiteConfig | null {
  if (!raw) return null;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    const parsed = siteConfigSchema.safeParse(JSON.parse(raw.slice(start, end + 1)));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function serializeConfig(siteConfig: SiteConfig): string {
  return JSON.stringify(siteConfig);
}

export function configHash(payload: string): string {
  return createHash("sha256").update(payload).digest("hex").slice(0, 16);
}

export function appendAudit(siteConfig: SiteConfig, entry: AuditEntry): SiteConfig {
  return {
    ...siteConfig,
    audit: [...siteConfig.audit, entry].slice(-MAX_AUDIT_ENTRIES),
  };
}

export interface SiteConfigSnapshot {
  config: SiteConfig;
  /** `null` when the config has never been persisted (first read of a fresh calendar). */
  etag: string | null;
  /** True when the stored payload was absent or invalid and defaults were substituted. */
  fellBackToDefaults: boolean;
}

export interface SiteConfigStore {
  readonly kind: "calendar" | "file" | "memory";
  read(): Promise<SiteConfigSnapshot>;
  write(next: SiteConfig, expectedEtag: string | null): Promise<SiteConfigSnapshot>;
}

export class SiteConfigConflictError extends Error {}

export function createMemoryStore(initial?: SiteConfig): SiteConfigStore {
  let payload = initial ? serializeConfig(initial) : "";
  return {
    kind: "memory",
    async read() {
      const parsed = parseStoredConfig(payload);
      return {
        config: parsed ?? defaultSiteConfig(),
        etag: payload ? configHash(payload) : null,
        fellBackToDefaults: parsed === null,
      };
    },
    async write(next, expectedEtag) {
      const currentEtag = payload ? configHash(payload) : null;
      if (expectedEtag && expectedEtag !== currentEtag) {
        throw new SiteConfigConflictError("Configuration changed since you loaded it");
      }
      payload = serializeConfig(next);
      return { config: next, etag: configHash(payload), fellBackToDefaults: false };
    },
  };
}

export function createCalendarStore(eventId: string = config.ADMIN_CONFIG_EVENT_ID): SiteConfigStore {
  return {
    kind: "calendar",
    async read() {
      const snapshot = await readConfigEvent(eventId);
      const parsed = parseStoredConfig(snapshot.description);
      return {
        config: parsed ?? defaultSiteConfig(),
        etag: snapshot.etag ?? null,
        fellBackToDefaults: parsed === null,
      };
    },
    async write(next, expectedEtag) {
      const payload = serializeConfig(next);
      if (payload.length > MAX_CONFIG_BYTES) {
        throw new Error(
          `Site configuration is ${payload.length} bytes; the limit is ${MAX_CONFIG_BYTES}. Trim the audit log or templates.`,
        );
      }
      const result = await writeConfigEvent(eventId, payload, expectedEtag ?? undefined);
      return { config: next, etag: result.etag ?? null, fellBackToDefaults: false };
    },
  };
}

/**
 * Availability and policy reads happen on every page load, so a short TTL cache keeps the
 * calendar API quiet without letting an admin edit go stale for long.
 */
export function createCachedStore(
  store: SiteConfigStore,
  ttlMs = 60_000,
  clock: () => number = () => Date.now(),
): SiteConfigStore {
  let cached: { snapshot: SiteConfigSnapshot; expiresAt: number } | null = null;
  return {
    kind: store.kind,
    async read() {
      const now = clock();
      if (cached && cached.expiresAt > now) return cached.snapshot;
      const snapshot = await store.read();
      cached = { snapshot, expiresAt: now + ttlMs };
      return snapshot;
    },
    async write(next, expectedEtag) {
      const snapshot = await store.write(next, expectedEtag);
      cached = { snapshot, expiresAt: clock() + ttlMs };
      return snapshot;
    },
  };
}

/** `SITE_CONFIG_FILE` switches the adapter to disk; otherwise the calendar event is authoritative. */
export function createDefaultStore(): SiteConfigStore {
  const filePath = config.SITE_CONFIG_FILE?.trim();
  return createCachedStore(filePath ? createFileStore(filePath) : createCalendarStore());
}

let activeStore: SiteConfigStore = createDefaultStore();

export function configureSiteConfigStore(store: SiteConfigStore): void {
  activeStore = store;
}

export function getSiteConfigStore(): SiteConfigStore {
  return activeStore;
}

export async function getSiteConfigSnapshot(): Promise<SiteConfigSnapshot> {
  return activeStore.read();
}

export async function getSiteConfig(): Promise<SiteConfig> {
  return (await activeStore.read()).config;
}

export async function saveSiteConfig(
  next: SiteConfig,
  expectedEtag: string | null,
): Promise<SiteConfigSnapshot> {
  return activeStore.write(next, expectedEtag);
}

/** Merges a validated patch onto the current config and stamps the audit log. */
export function applyConfigPatch(
  current: SiteConfig,
  patch: z.infer<typeof siteConfigPatchSchema>,
  actor: string,
  detail = "",
  now: Date = new Date(),
): SiteConfig {
  const policy = bookingPolicySchema.parse({ ...current.policy, ...(patch.policy ?? {}) });
  const updatedAt = now.toISOString();
  return {
    version: 1,
    updatedAt,
    updatedBy: patch.updatedBy ?? actor,
    policy,
    templates: patch.templates ?? current.templates,
    audit: [
      ...current.audit,
      {
        at: updatedAt,
        actor: sanitizeAudit(actor),
        action: "config.update",
        target: "policy",
        detail: sanitizeAudit(detail),
      },
    ].slice(-MAX_AUDIT_ENTRIES),
  };
}

function sanitizeAudit(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim().slice(0, 300);
}

export function createFileStore(filePath: string): SiteConfigStore {
  const absolute = resolve(filePath);
  return {
    kind: "file",
    async read() {
      try {
        const raw = await readFile(absolute, "utf8");
        const parsed = parseStoredConfig(raw);
        return {
          config: parsed ?? defaultSiteConfig(),
          etag: configHash(raw),
          fellBackToDefaults: parsed === null,
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return { config: defaultSiteConfig(), etag: null, fellBackToDefaults: true };
        }
        throw error;
      }
    },
    async write(next, expectedEtag) {
      let currentEtag: string | null = null;
      try {
        currentEtag = configHash(await readFile(absolute, "utf8"));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (expectedEtag && expectedEtag !== currentEtag) {
        throw new SiteConfigConflictError("Configuration changed since you loaded it");
      }
      const payload = serializeConfig(next);
      await mkdir(dirname(absolute), { recursive: true });
      const temporary = `${absolute}.${process.pid}.tmp`;
      await writeFile(temporary, payload, "utf8");
      await rename(temporary, absolute);
      return { config: next, etag: configHash(payload), fellBackToDefaults: false };
    },
  };
}

