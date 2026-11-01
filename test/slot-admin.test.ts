import assert from "node:assert/strict";
import test from "node:test";
import type { ScheduleTemplate, SiteConfig, SlotEvent } from "../src/types.js";

process.env.SITE_TIMEZONE = "UTC";

const { planTemplateSlots } = await import("../src/services/slot-admin.js");
const { defaultSiteConfig } = await import("../src/services/site-config.js");
const { zonedDateTimeToUtc } = await import("../src/services/site-time.js");

const now = new Date("2026-11-01T00:00:00Z"); // Sunday

function config(overrides: Partial<SiteConfig> = {}): SiteConfig {
  const base = defaultSiteConfig(now);
  return {
    ...base,
    policy: { ...base.policy, bookingWindowDays: 7, minLeadHours: 2, ...(overrides.policy ?? {}) },
    templates: overrides.templates ?? [],
  };
}

function template(overrides: Partial<ScheduleTemplate> = {}): ScheduleTemplate {
  return {
    id: "weekday-mornings",
    label: "Morning tandems",
    weekdays: [1, 2, 3, 4, 5],
    times: ["09:00"],
    durationMinutes: 120,
    maxPax: 4,
    enabled: true,
    ...overrides,
  };
}

function slot(start: Date): SlotEvent {
  return {
    id: `slot-${start.toISOString()}`,
    summary: "existing",
    description: "",
    start,
    end: new Date(start.getTime() + 7_200_000),
    status: "LOCKED",
    maxPax: 4,
    bookedPax: 0,
    manualOverride: false,
  };
}

test("templates plan one slot per matching weekday inside the window", () => {
  const plan = planTemplateSlots(config({ templates: [template()] }), [], now);
  assert.equal(plan.missing.length, 5);
  assert.deepEqual(
    plan.missing.map((entry) => entry.start.toISOString()),
    [
      "2026-11-02T09:00:00.000Z",
      "2026-11-03T09:00:00.000Z",
      "2026-11-04T09:00:00.000Z",
      "2026-11-05T09:00:00.000Z",
      "2026-11-06T09:00:00.000Z",
    ],
  );
  assert.equal(plan.missing[0]!.end.toISOString(), "2026-11-02T11:00:00.000Z");
  assert.equal(plan.missing[0]!.maxPax, 4);
});

test("existing departures are never planned twice", () => {
  const existing = [slot(zonedDateTimeToUtc("2026-11-02", "09:00", "UTC"))];
  const plan = planTemplateSlots(config({ templates: [template()] }), existing, now);
  assert.equal(plan.missing.length, 4);
  assert.equal(plan.existing, 1);
  assert.ok(!plan.missing.some((entry) => entry.start.toISOString().startsWith("2026-11-02")));
});

test("blackout and closed days are skipped, not planned", () => {
  const plan = planTemplateSlots(
    config({
      policy: { ...defaultSiteConfig(now).policy, bookingWindowDays: 7, blackouts: ["2026-11-03"], closedWeekdays: [5] },
      templates: [template()],
    }),
    [],
    now,
  );
  assert.ok(!plan.missing.some((entry) => entry.start.toISOString().startsWith("2026-11-03")));
  assert.ok(!plan.missing.some((entry) => entry.start.toISOString().startsWith("2026-11-06")));
  assert.ok(plan.skippedDates.includes("2026-11-03"));
});

test("the lead time suppresses departures that are too soon", () => {
  const lateNow = new Date("2026-11-02T08:00:00Z");
  const plan = planTemplateSlots(config({ templates: [template()] }), [], lateNow);
  assert.ok(!plan.missing.some((entry) => entry.start.toISOString().startsWith("2026-11-02")));
  assert.equal(plan.missing.length, 4);
});

test("disabled templates plan nothing", () => {
  const plan = planTemplateSlots(config({ templates: [template({ enabled: false })] }), [], now);
  assert.equal(plan.missing.length, 0);
});

test("site timezone wall-clock times are converted to the right instant", () => {
  const instant = zonedDateTimeToUtc("2026-11-02", "09:00", "Europe/Rome");
  // Central European Time is UTC+1 in November.
  assert.equal(instant.toISOString(), "2026-11-02T08:00:00.000Z");
  const summer = zonedDateTimeToUtc("2026-07-02", "09:00", "Europe/Rome");
  assert.equal(summer.toISOString(), "2026-07-02T07:00:00.000Z");
});
