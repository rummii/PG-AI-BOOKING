import { config, site } from "../config/site.js";
import type { SlotEvent, SlotStatus, SiteConfig, Verdict } from "../types.js";
import {
  applyBookingPolicy,
  buildDayRail,
  summarisePolicy,
  type DaySummary,
  type PolicyHideReason,
  type PolicySummary,
} from "./booking-policy.js";
import { createSlot, getUpcomingSlots } from "./calendar.js";
import {
  dateKeyRange,
  localDateKey,
  localTimeLabel,
  weekdayOf,
  zonedDateTimeToUtc,
} from "./site-time.js";

/** Admin-facing slot shape: the calendar event plus everything the dashboard wants to show. */

export interface AdminSlot {
  id: string;
  etag: string | null;
  summary: string;
  description: string;
  start: string;
  end: string;
  date: string;
  time: string;
  status: SlotStatus;
  maxPax: number;
  bookedPax: number;
  seatsLeft: number;
  manualOverride: boolean;
  verdict: Verdict | null;
  confidence: number | null;
  lastEvaluatedAt: string | null;
  limitingFactors: string[];
  reasoningSummary: string | null;
  hiddenReason: PolicyHideReason | null;
  recommended: boolean;
}

export function toAdminSlot(slot: SlotEvent, hiddenReason: PolicyHideReason | null, recommended: boolean): AdminSlot {
  return {
    id: slot.id,
    etag: slot.etag ?? null,
    summary: slot.summary,
    description: slot.description,
    start: slot.start.toISOString(),
    end: slot.end.toISOString(),
    date: localDateKey(slot.start),
    time: localTimeLabel(slot.start),
    status: slot.status,
    maxPax: slot.maxPax,
    bookedPax: slot.bookedPax,
    seatsLeft: Math.max(0, slot.maxPax - slot.bookedPax),
    manualOverride: slot.manualOverride,
    verdict: slot.verdict ?? null,
    confidence: slot.confidence ?? null,
    lastEvaluatedAt: slot.lastEvaluatedAt ?? null,
    limitingFactors: slot.limitingFactors ?? [],
    reasoningSummary: slot.reasoningSummary ?? null,
    hiddenReason,
    recommended,
  };
}

export interface AdminSlotList {
  slots: AdminSlot[];
  from: string;
  to: string;
  counts: Record<SlotStatus, number>;
  total: number;
  days: DaySummary[];
  policy: PolicySummary;
}

export interface MaterialisePlan {
  /** Instants the templates want that the calendar does not have yet. */
  missing: Array<{ templateId: string; label: string; start: Date; end: Date; maxPax: number }>;
  existing: number;
  /** Dates skipped because the policy closes them. */
  skippedDates: string[];
}

/**
 * Works out which template slots are missing, without writing anything. Pure enough to test and
 * reused by the worker so the calendar never gets duplicate slots for the same departure.
 */
export function planTemplateSlots(
  siteConfig: SiteConfig,
  existingSlots: SlotEvent[],
  now: Date,
): MaterialisePlan {
  const today = localDateKey(now);
  const existingStarts = new Set(existingSlots.map((slot) => slot.start.toISOString()));
  const dates = dateKeyRange(today, siteConfig.policy.bookingWindowDays);
  const missing: MaterialisePlan["missing"] = [];
  const skippedDates: string[] = [];
  const leadCutoff = now.getTime() + siteConfig.policy.minLeadHours * 3_600_000;

  for (const template of siteConfig.templates) {
    if (!template.enabled) continue;
    for (const date of dates) {
      const weekday = weekdayOf(date);
      if (!template.weekdays.includes(weekday)) continue;
      if (siteConfig.policy.blackouts.includes(date)) {
        if (!skippedDates.includes(date)) skippedDates.push(date);
        continue;
      }
      if (siteConfig.policy.closedWeekdays.includes(weekday)) {
        if (!skippedDates.includes(date)) skippedDates.push(date);
        continue;
      }
      for (const time of template.times) {
        const start = zonedDateTimeToUtc(date, time, site.timezone);
        if (start.getTime() < leadCutoff) continue;
        const key = start.toISOString();
        if (existingStarts.has(key)) continue;
        missing.push({
          templateId: template.id,
          label: template.label,
          start,
          end: new Date(start.getTime() + template.durationMinutes * 60_000),
          maxPax: template.maxPax,
        });
        existingStarts.add(key);
      }
    }
  }

  missing.sort((left, right) => left.start.getTime() - right.start.getTime());
  return { missing, existing: existingSlots.length, skippedDates };
}

export interface MaterialiseResult {
  created: AdminSlot[];
  planned: number;
  skippedDates: string[];
  errors: Array<{ templateId: string; start: string; message: string }>;
}

/** Safety valve: a bad template should never flood the calendar in one worker run. */
const MAX_CREATIONS_PER_RUN = 40;

export async function materialiseTemplateSlots(
  siteConfig: SiteConfig,
  now: Date = new Date(),
): Promise<MaterialiseResult> {
  if (siteConfig.templates.length === 0) {
    return { created: [], planned: 0, skippedDates: [], errors: [] };
  }
  const horizonEnd = new Date(
    now.getTime() + (siteConfig.policy.bookingWindowDays + 1) * 86_400_000,
  );
  const existing = await getUpcomingSlots(now, horizonEnd);
  const plan = planTemplateSlots(siteConfig, existing, now);
  const created: AdminSlot[] = [];
  const errors: MaterialiseResult["errors"] = [];

  for (const candidate of plan.missing.slice(0, MAX_CREATIONS_PER_RUN)) {
    try {
      const slot = await createSlot({
        start: candidate.start,
        end: candidate.end,
        maxPax: candidate.maxPax,
        label: candidate.label,
        status: "LOCKED",
      });
      created.push(toAdminSlot(slot, null, false));
    } catch (error) {
      errors.push({
        templateId: candidate.templateId,
        start: candidate.start.toISOString(),
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    created,
    planned: plan.missing.length,
    skippedDates: plan.skippedDates,
    errors,
  };
}

export interface ManualSlotInput {
  date: string;
  time: string;
  durationMinutes: number;
  maxPax: number;
  label: string;
  note?: string;
}

/** Creates a single ad-hoc slot from the admin form. Always starts LOCKED. */
export async function createManualSlot(input: ManualSlotInput, now: Date = new Date()): Promise<AdminSlot> {
  const start = zonedDateTimeToUtc(input.date, input.time, site.timezone);
  if (start.getTime() <= now.getTime()) {
    throw new Error("Slot must start in the future");
  }
  const horizonDays = config.ADMIN_BOOKING_WINDOW_DAYS + 30;
  if (start.getTime() > now.getTime() + horizonDays * 86_400_000) {
    throw new Error(`Slot must be within ${horizonDays} days`);
  }
  const slot = await createSlot({
    start,
    end: new Date(start.getTime() + input.durationMinutes * 60_000),
    maxPax: input.maxPax,
    label: input.label,
    ...(input.note ? { description: input.note } : {}),
    status: "LOCKED",
  });
  return toAdminSlot(slot, null, false);
}

/** Human summary of the next few days, used by the dashboard header. */
export function upcomingDates(count: number, now: Date = new Date()): string[] {
  return dateKeyRange(localDateKey(now), count);
}

export async function listAdminSlots(
  siteConfig: SiteConfig,
  now: Date = new Date(),
  days?: number,
): Promise<AdminSlotList> {
  const from = now;
  const to = new Date(now.getTime() + (days ?? 30) * 86_400_000);
  const slots = await getUpcomingSlots(from, to);
  const applied = applyBookingPolicy(slots, { policy: siteConfig.policy, now });
  const counts: Record<SlotStatus, number> = {
    OPEN: 0,
    LOCKED: 0,
    STANDBY: 0,
    CONFIRMED: 0,
    CANCELLED: 0,
  };
  for (const entry of applied) counts[entry.slot.status] += 1;
  const context = { policy: siteConfig.policy, now };
  return {
    slots: applied.map((entry) => toAdminSlot(entry.slot, entry.hiddenReason, entry.recommended)),
    from: from.toISOString(),
    to: to.toISOString(),
    counts,
    total: applied.length,
    days: buildDayRail(applied, context, Math.min(14, siteConfig.policy.bookingWindowDays)),
    policy: summarisePolicy(context),
  };
}
