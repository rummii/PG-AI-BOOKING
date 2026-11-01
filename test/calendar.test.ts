import assert from "node:assert/strict";
import test from "node:test";
import type { calendar_v3 } from "googleapis";

process.env.DEFAULT_MAX_PAX = "3";

const { parseSlot } = await import("../src/services/calendar.js");

function event(overrides: calendar_v3.Schema$Event = {}): calendar_v3.Schema$Event {
  return {
    id: "event-1",
    etag: '"etag-1"',
    summary: "[OPEN] Tandem flight",
    description: "Meet at the launch",
    start: { dateTime: "2026-11-01T10:00:00Z" },
    end: { dateTime: "2026-11-01T11:00:00Z" },
    extendedProperties: { private: { status: "OPEN", maxPax: "2", bookedPax: "1" } },
    ...overrides,
  };
}

test("a well-formed event is read as a slot with its status, capacity, and ETag", () => {
  const slot = parseSlot(event());
  assert.ok(slot);
  assert.equal(slot.id, "event-1");
  assert.equal(slot.etag, '"etag-1"');
  assert.equal(slot.summary, "[OPEN] Tandem flight");
  assert.equal(slot.description, "Meet at the launch");
  assert.equal(slot.start.toISOString(), "2026-11-01T10:00:00.000Z");
  assert.equal(slot.end.toISOString(), "2026-11-01T11:00:00.000Z");
  assert.equal(slot.status, "OPEN");
  assert.equal(slot.maxPax, 2);
  assert.equal(slot.bookedPax, 1);
  assert.equal(slot.manualOverride, false);
});

test("every known private status is preserved", () => {
  for (const status of ["OPEN", "STANDBY", "LOCKED", "CONFIRMED", "CANCELLED"] as const) {
    const slot = parseSlot(event({ extendedProperties: { private: { status } } }));
    assert.ok(slot);
    assert.equal(slot.status, status);
  }
});

test("events without an explicit status stay locked", () => {
  const missing = parseSlot(event({ extendedProperties: undefined }));
  const unknown = parseSlot(event({ extendedProperties: { private: { status: "PUBLISHED" } } }));
  assert.ok(missing);
  assert.ok(unknown);
  assert.equal(missing.status, "LOCKED");
  assert.equal(unknown.status, "LOCKED");
});

test("all-day and malformed events are rejected", () => {
  assert.equal(parseSlot(event({ start: { date: "2026-11-01" } })), null);
  assert.equal(parseSlot(event({ end: undefined })), null);
  assert.equal(parseSlot(event({ id: undefined })), null);
  assert.equal(
    parseSlot(event({ start: { dateTime: "2026-11-01T11:00:00Z" }, end: { dateTime: "2026-11-01T10:00:00Z" } })),
    null,
  );
  assert.equal(
    parseSlot(event({ start: { dateTime: "not-a-date" }, end: { dateTime: "2026-11-01T10:00:00Z" } })),
    null,
  );
});

test("invalid capacity metadata falls back to the configured defaults", () => {
  const slot = parseSlot(
    event({ extendedProperties: { private: { status: "OPEN", maxPax: "0", bookedPax: "-2" } } }),
  );
  const noisy = parseSlot(
    event({ extendedProperties: { private: { status: "OPEN", maxPax: "two", bookedPax: "one" } } }),
  );
  assert.ok(slot);
  assert.ok(noisy);
  assert.equal(slot.maxPax, 3);
  assert.equal(slot.bookedPax, 0);
  assert.equal(noisy.maxPax, 3);
  assert.equal(noisy.bookedPax, 0);
});

test("manualOverride is only honored for an explicit true value", () => {
  const overridden = parseSlot(event({ extendedProperties: { private: { manualOverride: "TRUE" } } }));
  const notOverridden = parseSlot(event({ extendedProperties: { private: { manualOverride: "no" } } }));
  assert.ok(overridden);
  assert.ok(notOverridden);
  assert.equal(overridden.manualOverride, true);
  assert.equal(notOverridden.manualOverride, false);
});

test("missing summary and description fall back to safe defaults", () => {
  const slot = parseSlot(event({ summary: undefined, description: undefined }));
  assert.ok(slot);
  assert.equal(slot.summary, "Paragliding booking slot");
  assert.equal(slot.description, "");
});
