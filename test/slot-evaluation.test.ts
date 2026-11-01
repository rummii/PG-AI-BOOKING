import assert from "node:assert/strict";
import test from "node:test";
import type { EvaluationResult, SlotEvent, SlotStatus, WeatherData } from "../src/types.js";
import type { SlotEvaluationDependencies, SlotStateEvaluation } from "../src/services/slot-evaluation.js";

process.env.DEEPSEEK_API_KEY = "";
process.env.ALERT_WEBHOOK_URL = "";

const { chooseStatus, evaluateAndSyncSlot } = await import("../src/services/slot-evaluation.js");
const { CalendarConflictError } = await import("../src/services/calendar.js");

const NOW = new Date("2026-11-01T10:00:00Z");

function slot(overrides: Partial<SlotEvent> = {}): SlotEvent {
  const start = new Date(NOW.getTime() + 50 * 3_600_000);
  return {
    id: "slot-1",
    etag: "etag-1",
    summary: "[LOCKED] Tandem flight",
    description: "",
    start,
    end: new Date(start.getTime() + 3_600_000),
    status: "LOCKED",
    maxPax: 2,
    bookedPax: 0,
    manualOverride: false,
    ...overrides,
  };
}

function evaluation(overrides: Partial<EvaluationResult> = {}): EvaluationResult {
  return {
    verdict: "FLYABLE",
    action: "OPEN",
    confidence_score: 0.8,
    limiting_factors: [],
    reasoning_summary: "Laminar flow with light model disagreement.",
    ...overrides,
  };
}

function vector(): WeatherData {
  return {
    model: "ecmwf_ifs025",
    time: "2026-11-01T10:00",
    windSpeed10mKmh: 18,
    windSpeed80mKmh: 21,
    windDirection10mDeg: 340,
    windGusts10mKmh: 24,
    rainProbability: 5,
    precipitationMm: 0,
    capeJkg: 100,
    cloudCoverPercent: 30,
    cloudCeilingM: 800,
  };
}

interface RecordedUpdate {
  status: SlotStatus;
  expectedEtag: string | undefined;
}

test("chooseStatus cancels a NO_GO verdict and stands down a MARGINAL verdict", () => {
  assert.equal(chooseStatus(slot(), evaluation({ verdict: "NO_GO", action: "CANCEL" }), NOW), "CANCELLED");
  assert.equal(chooseStatus(slot(), evaluation({ verdict: "MARGINAL", action: "STANDBY" }), NOW), "STANDBY");
});

test("chooseStatus confirms a flyable slot inside the two-hour horizon", () => {
  const soon = slot({ start: new Date(NOW.getTime() + 1 * 3_600_000) });
  assert.equal(chooseStatus(soon, evaluation(), NOW), "CONFIRMED");
});

test("chooseStatus opens locked slots only inside the 72 to 48 hour window", () => {
  assert.equal(chooseStatus(slot(), evaluation(), NOW), "OPEN");
  const tooLate = slot({ start: new Date(NOW.getTime() + 47 * 3_600_000) });
  const tooEarly = slot({ start: new Date(NOW.getTime() + 73 * 3_600_000) });
  assert.equal(chooseStatus(tooLate, evaluation(), NOW), "LOCKED");
  assert.equal(chooseStatus(tooEarly, evaluation(), NOW), "LOCKED");
});

test("chooseStatus keeps existing open, confirmed, and standby states outside the near-term horizon", () => {
  assert.equal(chooseStatus(slot({ status: "OPEN" }), evaluation(), NOW), "OPEN");
  assert.equal(chooseStatus(slot({ status: "CONFIRMED" }), evaluation(), NOW), "CONFIRMED");
  // A standby slot is only released by human review, not by a single flyable re-evaluation.
  assert.equal(chooseStatus(slot({ status: "STANDBY" }), evaluation(), NOW), "STANDBY");
});


test("a failed evaluation records STANDBY and retries once with a fresh ETag on conflict", async () => {
  const calls: RecordedUpdate[] = [];
  const dependencies: SlotEvaluationDependencies = {
    fetchWeatherVectors: async () => {
      throw new Error("weather service unavailable");
    },
    evaluateSlotConditions: async () => {
      throw new Error("the evaluator must not run without weather data");
    },
    updateSlotState: async (_slotId, status, _evaluation, expectedEtag) => {
      calls.push({ status, expectedEtag });
      if (calls.length === 1) throw new CalendarConflictError("Calendar slot changed; refresh and retry");
    },
  };

  const result = await evaluateAndSyncSlot(slot(), { now: NOW }, dependencies);

  assert.equal(result.skipped, false);
  assert.equal(result.status, "STANDBY");
  assert.match(result.error ?? "", /weather service unavailable/);
  assert.deepEqual(calls, [
    { status: "STANDBY", expectedEtag: "etag-1" },
    { status: "STANDBY", expectedEtag: undefined },
  ]);
});

test("a STANDBY write that cannot be recorded is reported instead of thrown", async () => {
  const dependencies: SlotEvaluationDependencies = {
    fetchWeatherVectors: async () => {
      throw new Error("weather service unavailable");
    },
    evaluateSlotConditions: async () => {
      throw new Error("the evaluator must not run without weather data");
    },
    updateSlotState: async () => {
      throw new CalendarConflictError("Calendar slot changed; refresh and retry");
    },
  };

  const result = await evaluateAndSyncSlot(slot(), { now: NOW }, dependencies);

  assert.equal(result.status, undefined);
  assert.match(result.error ?? "", /STANDBY could not be recorded/);
});

test("a flyable evaluation opens a locked slot with the event ETag", async () => {
  const calls: RecordedUpdate[] = [];
  const dependencies: SlotEvaluationDependencies = {
    fetchWeatherVectors: async () => [vector()],
    evaluateSlotConditions: async () => evaluation(),
    updateSlotState: async (_slotId, status, _evaluation, expectedEtag) => {
      calls.push({ status, expectedEtag });
    },
  };

  const result = await evaluateAndSyncSlot(slot(), { now: NOW }, dependencies);

  assert.equal(result.status, "OPEN");
  assert.deepEqual(calls, [{ status: "OPEN", expectedEtag: "etag-1" }]);
});

test("the evaluation timestamp comes from the injected clock, not the wall clock", async () => {
  let recorded: SlotStateEvaluation | undefined;
  const dependencies: SlotEvaluationDependencies = {
    fetchWeatherVectors: async () => [vector()],
    evaluateSlotConditions: async () => evaluation(),
    updateSlotState: async (_slotId, _status, slotEvaluation) => {
      recorded = slotEvaluation;
    },
  };

  // A slot 50 hours out only opens while "now" sits inside the 72-to-48 hour window.
  // Passing the clock in keeps that decision reproducible on any day the suite runs.
  await evaluateAndSyncSlot(slot(), { now: NOW }, dependencies);

  assert.equal(recorded?.evaluatedAt.toISOString(), NOW.toISOString());
});

test("a NO_GO verdict cancels the slot and reports a missing abort webhook", async () => {
  const calls: SlotStatus[] = [];
  const dependencies: SlotEvaluationDependencies = {
    fetchWeatherVectors: async () => [vector()],
    evaluateSlotConditions: async () =>
      evaluation({ verdict: "NO_GO", action: "CANCEL", limiting_factors: ["wind exceeds the site maximum"] }),
    updateSlotState: async (_slotId, status) => {
      calls.push(status);
    },
  };

  const result = await evaluateAndSyncSlot(slot(), { now: NOW }, dependencies);

  assert.deepEqual(calls, ["CANCELLED"]);
  assert.equal(result.status, "CANCELLED");
  assert.match(result.alertError ?? "", /ALERT_WEBHOOK_URL is not configured/);
});

test("manual overrides and cancelled slots are skipped without contacting the forecast", async () => {
  let updates = 0;
  const skippedDependencies: SlotEvaluationDependencies = {
    fetchWeatherVectors: async () => {
      throw new Error("the forecast must not be requested for a skipped slot");
    },
    evaluateSlotConditions: async () => evaluation(),
    updateSlotState: async () => {
      updates += 1;
    },
  };

  const overridden = await evaluateAndSyncSlot(slot({ manualOverride: true }), { now: NOW }, skippedDependencies);
  const cancelled = await evaluateAndSyncSlot(slot({ status: "CANCELLED" }), { now: NOW }, skippedDependencies);

  assert.equal(overridden.skipped, true);
  assert.equal(cancelled.skipped, true);
  assert.equal(updates, 0);

  const forced = await evaluateAndSyncSlot(
    slot({ manualOverride: true }),
    { ignoreManualOverride: true, now: NOW },
    { ...skippedDependencies, updateSlotState: async () => { updates += 1; } },
  );

  assert.equal(forced.skipped, false);
  assert.equal(forced.status, "STANDBY");
  assert.equal(updates, 1);
});

