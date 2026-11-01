import type { BookingPolicy, DayState, SlotEvent } from "../types.js";
import { addDaysToKey, dateKeyRange, localDateKey, weekdayOf } from "./site-time.js";

/**
 * Booking policy is the operator's steering wheel: how far out the calendar opens, which days
 * are off limits, and which dates are being pushed. It never changes the safety envelope — a
 * policy can only hide a slot, never open one.
 */

export interface PolicyContext {
  policy: BookingPolicy;
  now: Date;
}

export type PolicyHideReason =
  | "past"
  | "lead-time"
  | "blackout"
  | "closed"
  | "window"
  | "focus";

export interface PolicySlot {
  slot: SlotEvent;
  /** Site-local date of the departure. */
  date: string;
  /** True when the policy wants this slot in front of bookers. */
  recommended: boolean;
  hiddenReason: PolicyHideReason | null;
}

export interface DaySummary {
  date: string;
  state: DayState;
  total: number;
  bookable: number;
  seatsLeft: number;
  /** 0..100 weather confidence for the best slot that day, when the worker has evaluated one. */
  bestScore: number | null;
  recommended: boolean;
  focus: boolean;
}

/** Last bookable date key, inclusive. */
export function windowEndDate(context: PolicyContext): string {
  return addDaysToKey(localDateKey(context.now), context.policy.bookingWindowDays - 1);
}

export function isFocusDate(date: string, policy: BookingPolicy): boolean {
  if (!policy.focus) return false;
  return date >= policy.focus.from && date <= policy.focus.to;
}

function hideReason(date: string, slot: SlotEvent, context: PolicyContext): PolicyHideReason | null {
  const today = localDateKey(context.now);
  if (date < today) return "past";
  const leadMs = context.policy.minLeadHours * 3_600_000;
  if (slot.start.getTime() - context.now.getTime() < leadMs) return "lead-time";
  if (context.policy.blackouts.includes(date)) return "blackout";
  if (context.policy.closedWeekdays.includes(weekdayOf(date))) return "closed";
  if (date > windowEndDate(context)) return "window";
  if (context.policy.mode === "focus-only" && !isFocusDate(date, context.policy)) return "focus";
  return null;
}

export function evaluateSlotPolicy(slot: SlotEvent, context: PolicyContext): PolicySlot {
  const date = localDateKey(slot.start);
  const hiddenReason = hideReason(date, slot, context);
  const inFocus = isFocusDate(date, context.policy);
  const policyWantsIt = context.policy.mode === "open" || inFocus;
  const weatherAllowsIt = slot.verdict !== "NO_GO";
  return {
    slot,
    date,
    recommended: hiddenReason === null && policyWantsIt && weatherAllowsIt,
    hiddenReason,
  };
}

export function applyBookingPolicy(slots: SlotEvent[], context: PolicyContext): PolicySlot[] {
  return slots
    .map((slot) => evaluateSlotPolicy(slot, context))
    .sort((left, right) => left.slot.start.getTime() - right.slot.start.getTime());
}

export function visibleSlots(applied: PolicySlot[]): SlotEvent[] {
  return applied.filter((entry) => entry.hiddenReason === null).map((entry) => entry.slot);
}

export function bestScore(entries: PolicySlot[]): number | null {
  const scored = entries
    .map((entry) => entry.slot.confidence)
    .filter((value): value is number => typeof value === "number");
  if (scored.length === 0) return null;
  return Math.round(Math.max(...scored) * 100);
}

function dayState(
  entries: PolicySlot[],
  date: string,
  context: PolicyContext,
  today: string,
): DayState {
  if (date < today) return "past";
  if (context.policy.blackouts.includes(date)) return "blackout";
  if (context.policy.closedWeekdays.includes(weekdayOf(date))) return "closed";
  const live = entries.filter((entry) => entry.hiddenReason === null);
  const sellable = live.filter((entry) => entry.slot.status === "OPEN");
  if (sellable.length === 0) return "locked";
  if (!sellable.some((entry) => entry.slot.maxPax > entry.slot.bookedPax)) return "full";
  const best = bestScore(live);
  if (best !== null && best < 40) return "marginal";
  return "open";
}

/**
 * Builds the date rail the booking page shows. Days run continuously from today so a quiet day
 * still appears — an empty rail reads as "closed", not broken.
 */
export function buildDayRail(
  applied: PolicySlot[],
  context: PolicyContext,
  days = 14,
): DaySummary[] {
  const today = localDateKey(context.now);
  const horizon = Math.max(1, Math.min(days, context.policy.bookingWindowDays, 30));
  return dateKeyRange(today, horizon).map((date) => {
    const entries = applied.filter((entry) => entry.date === date);
    const live = entries.filter((entry) => entry.hiddenReason === null);
    return {
      date,
      state: dayState(entries, date, context, today),
      total: entries.length,
      bookable: live.filter((entry) => entry.slot.status === "OPEN").length,
      seatsLeft: live.reduce(
        (total, entry) => total + Math.max(0, entry.slot.maxPax - entry.slot.bookedPax),
        0,
      ),
      bestScore: bestScore(live),
      recommended: live.some((entry) => entry.recommended),
      focus: isFocusDate(date, context.policy),
    };
  });
}

export interface PolicyNotice {
  tone: "focus" | "info" | "closed";
  headline: string;
  detail: string;
}

/** Banner copy for the public page. Returns `null` when there is nothing worth saying. */
export function policyNotice(context: PolicyContext): PolicyNotice | null {
  const { policy } = context;
  const today = localDateKey(context.now);
  if (policy.blackouts.includes(today)) {
    return {
      tone: "closed",
      headline: "No flights today",
      detail: policy.notice || "The site is closed today. Have a look at the next open date.",
    };
  }
  if (policy.mode !== "open" && policy.focus && policy.focus.to >= today) {
    return {
      tone: "focus",
      headline: policy.focus.label,
      detail:
        policy.notice ||
        `We are prioritising ${policy.focus.from} to ${policy.focus.to}. Book those dates first.`,
    };
  }
  if (policy.notice.trim()) {
    return { tone: "info", headline: "Notice", detail: policy.notice.trim() };
  }
  return null;
}

export interface PolicySummary {
  windowDays: number;
  windowEndsOn: string;
  minLeadHours: number;
  mode: BookingPolicy["mode"];
  focus: BookingPolicy["focus"];
  blackouts: string[];
  closedWeekdays: number[];
  notice: string;
}

export function summarisePolicy(context: PolicyContext): PolicySummary {
  const { policy } = context;
  return {
    windowDays: policy.bookingWindowDays,
    windowEndsOn: windowEndDate(context),
    minLeadHours: policy.minLeadHours,
    mode: policy.mode,
    focus: policy.focus,
    blackouts: [...policy.blackouts],
    closedWeekdays: [...policy.closedWeekdays],
    notice: policy.notice,
  };
}

