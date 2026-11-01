import assert from "node:assert/strict";
import test from "node:test";
import type { BookingPolicy, SlotEvent } from "../src/types.js";

process.env.SITE_TIMEZONE = "UTC";

const {
  applyBookingPolicy,
  buildDayRail,
  policyNotice,
  summarisePolicy,
  visibleSlots,
  windowEndDate,
} = await import("../src/services/booking-policy.js");

const now = new Date("2026-11-01T00:00:00Z"); // Sunday

const basePolicy: BookingPolicy = {
  bookingWindowDays: 14,
  minLeadHours: 12,
  mode: "open",
  focus: null,
  notice: "",
  blackouts: [],
  closedWeekdays: [],
  defaultMaxPax: 4,
};

function slot(startIso: string, overrides: Partial<SlotEvent> = {}): SlotEvent {
  const start = new Date(startIso);
  return {
    id: `slot-${startIso}`,
    summary: "[OPEN] Paragliding booking slot",
    description: "",
    start,
    end: new Date(start.getTime() + 2 * 3_600_000),
    status: "OPEN",
    maxPax: 4,
    bookedPax: 0,
    manualOverride: false,
    ...overrides,
  };
}

function context(policy: Partial<BookingPolicy> = {}) {
  return { policy: { ...basePolicy, ...policy }, now };
}

test("an open policy leaves every future slot visible and recommended", () => {
  const applied = applyBookingPolicy([slot("2026-11-02T09:00:00Z")], context());
  assert.equal(applied.length, 1);
  assert.equal(applied[0]!.hiddenReason, null);
  assert.equal(applied[0]!.recommended, true);
  assert.equal(applied[0]!.date, "2026-11-02");
});

test("blackout dates hide the slot without touching the weather status", () => {
  const applied = applyBookingPolicy(
    [slot("2026-11-03T09:00:00Z")],
    context({ blackouts: ["2026-11-03"] }),
  );
  assert.equal(applied[0]!.hiddenReason, "blackout");
  assert.equal(applied[0]!.slot.status, "OPEN");
  assert.deepEqual(visibleSlots(applied), []);
});

test("closed weekdays hide slots on those days only", () => {
  const applied = applyBookingPolicy(
    [slot("2026-11-08T09:00:00Z"), slot("2026-11-02T09:00:00Z")],
    context({ closedWeekdays: [0] }),
  );
  const byDate = new Map(applied.map((entry) => [entry.date, entry.hiddenReason]));
  assert.equal(byDate.get("2026-11-08"), "closed");
  assert.equal(byDate.get("2026-11-02"), null);
});

test("the minimum lead time hides slots that are too soon", () => {
  const applied = applyBookingPolicy([slot("2026-11-01T06:00:00Z")], context());
  assert.equal(applied[0]!.hiddenReason, "lead-time");
});

test("slots beyond the booking window are hidden", () => {
  const applied = applyBookingPolicy(
    [slot("2026-11-04T09:00:00Z")],
    context({ bookingWindowDays: 2 }),
  );
  assert.equal(windowEndDate(context({ bookingWindowDays: 2 })), "2026-11-02");
  assert.equal(applied[0]!.hiddenReason, "window");
});

test("past slots are marked as past", () => {
  const applied = applyBookingPolicy([slot("2026-10-30T09:00:00Z")], context());
  assert.equal(applied[0]!.hiddenReason, "past");
});

test("focus-only mode hides everything outside the focus window", () => {
  const focus = { label: "Thermals week", from: "2026-11-05", to: "2026-11-06" };
  const applied = applyBookingPolicy(
    [slot("2026-11-05T09:00:00Z"), slot("2026-11-07T09:00:00Z")],
    context({ mode: "focus-only", focus }),
  );
  assert.equal(applied[0]!.hiddenReason, null);
  assert.equal(applied[0]!.recommended, true);
  assert.equal(applied[1]!.hiddenReason, "focus");
});

test("focus-first mode keeps other days visible but stops promoting them", () => {
  const focus = { label: "Thermals week", from: "2026-11-05", to: "2026-11-06" };
  const applied = applyBookingPolicy(
    [slot("2026-11-05T09:00:00Z"), slot("2026-11-07T09:00:00Z")],
    context({ mode: "focus-first", focus }),
  );
  assert.equal(applied[0]!.recommended, true);
  assert.equal(applied[1]!.hiddenReason, null);
  assert.equal(applied[1]!.recommended, false);
});

test("a NO_GO verdict is never recommended, even inside the focus window", () => {
  const focus = { label: "Thermals week", from: "2026-11-05", to: "2026-11-06" };
  const applied = applyBookingPolicy(
    [slot("2026-11-05T09:00:00Z", { verdict: "NO_GO" })],
    context({ mode: "focus-only", focus }),
  );
  assert.equal(applied[0]!.recommended, false);
});

test("the date rail is continuous and reports per-day state", () => {
  const slots = [
    slot("2026-11-02T09:00:00Z"),
    slot("2026-11-02T13:00:00Z", { status: "LOCKED" }),
    slot("2026-11-03T09:00:00Z", { bookedPax: 4 }),
  ];
  const applied = applyBookingPolicy(slots, context());
  const rail = buildDayRail(applied, context(), 5);
  assert.equal(rail.length, 5);
  assert.deepEqual(
    rail.map((day) => day.date),
    ["2026-11-01", "2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05"],
  );
  assert.equal(rail[0]!.state, "locked");
  assert.equal(rail[1]!.state, "open");
  assert.equal(rail[1]!.bookable, 1);
  assert.equal(rail[2]!.state, "full");
});

test("closed days are reported as closed even when slots exist", () => {
  const slots = [slot("2026-11-01T09:00:00Z")];
  const policy = context({ closedWeekdays: [0] });
  const rail = buildDayRail(applyBookingPolicy(slots, policy), policy, 2);
  assert.equal(rail[0]!.state, "closed");
});

test("the notice banner prefers today's blackout over the focus message", () => {
  const notice = policyNotice(
    context({
      blackouts: ["2026-11-01"],
      mode: "focus-first",
      focus: { label: "Thermals week", from: "2026-11-05", to: "2026-11-06" },
    }),
  );
  assert.equal(notice?.tone, "closed");
});

test("the focus banner only appears while the window is still ahead", () => {
  const live = policyNotice(
    context({ mode: "focus-first", focus: { label: "Thermals", from: "2026-11-05", to: "2026-11-06" } }),
  );
  assert.equal(live?.tone, "focus");
  const stale = policyNotice(
    context({ mode: "focus-first", focus: { label: "Thermals", from: "2026-10-01", to: "2026-10-02" } }),
  );
  assert.equal(stale, null);
});

test("the policy summary exposes the derived window end", () => {
  const summary = summarisePolicy(context({ bookingWindowDays: 7 }));
  assert.equal(summary.windowDays, 7);
  assert.equal(summary.windowEndsOn, "2026-11-07");
});

