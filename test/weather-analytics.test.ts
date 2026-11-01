import assert from "node:assert/strict";
import test from "node:test";
import type { SlotEvent, WeatherData } from "../src/types.js";

process.env.SITE_LAT = "45.0";
process.env.SITE_LON = "7.0";
process.env.SITE_TIMEZONE = "UTC";

const { buildForecastSeries, findWindows, verdictFor } = await import(
  "../src/services/weather-series.js"
);
const { buildWeatherAnalytics, summariseRules, summariseSlots } = await import(
  "../src/services/weather-analytics.js"
);

const now = new Date("2026-11-01T00:00:00Z");

function vector(overrides: Partial<WeatherData> = {}, model = "ecmwf_ifs025"): WeatherData {
  return {
    model,
    time: "2026-11-01T09:00",
    windSpeed10mKmh: 20,
    windSpeed80mKmh: 22,
    windDirection10mDeg: 340,
    windGusts10mKmh: 23,
    rainProbability: 5,
    precipitationMm: 0,
    capeJkg: 100,
    cloudCoverPercent: 30,
    cloudCeilingM: 900,
    ...overrides,
  };
}

function hourAt(hourOffset: number, overrides: Partial<WeatherData> = {}) {
  return {
    time: new Date(now.getTime() + hourOffset * 3_600_000),
    vectors: [vector(overrides, "ecmwf_ifs025"), vector(overrides, "gfs_seamless")],
  };
}

test("verdict thresholds follow score and agreement", () => {
  assert.equal(verdictFor(80, 1, false), "FLYABLE");
  assert.equal(verdictFor(80, 1, true), "NO_GO");
  assert.equal(verdictFor(80, 0.5, false), "MARGINAL");
  assert.equal(verdictFor(20, 1, false), "MARGINAL");
});

test("a series of good hours produces flyable verdicts and a window", () => {
  const series = buildForecastSeries({ hours: [hourAt(9), hourAt(10), hourAt(11)], failures: [] }, now);
  assert.equal(series.hours.length, 3);
  assert.ok(series.hours.every((hour) => hour.verdict === "FLYABLE"));
  assert.equal(series.windows.length, 1);
  assert.equal(series.windows[0]!.hours, 3);
  assert.equal(series.hours[0]!.date, "2026-11-01");
  assert.equal(series.hours[0]!.label, "09:00");
});

test("a hard breach marks the hour NO_GO and names the failing rule", () => {
  const series = buildForecastSeries(
    { hours: [hourAt(9, { windSpeed10mKmh: 40, windSpeed80mKmh: 42 })], failures: [] },
    now,
  );
  const hour = series.hours[0]!;
  assert.equal(hour.verdict, "NO_GO");
  assert.equal(hour.score, 0);
  assert.equal(hour.ruleFailures[0]?.rule, "wind_max");
  assert.match(hour.messages.join(" "), /wind exceeds the site maximum/);
  assert.equal(series.windows.length, 0);
});

test("a short flyable stretch is not promoted as a window", () => {
  const hours = [
    { ...hourAt(9), },
    { ...hourAt(10, { windSpeed10mKmh: 40, windSpeed80mKmh: 42 }) },
  ];
  const series = buildForecastSeries({ hours, failures: [] }, now);
  assert.equal(series.hours.length, 2);
  assert.equal(series.windows.length, 0);
});

test("findWindows splits on non-flyable hours", () => {
  const series = buildForecastSeries(
    {
      hours: [
        hourAt(9),
        hourAt(10),
        hourAt(11, { windSpeed10mKmh: 40, windSpeed80mKmh: 42 }),
        hourAt(12),
        hourAt(13),
        hourAt(14),
      ],
      failures: [],
    },
    now,
  );
  const windows = findWindows(series.hours);
  assert.equal(windows.length, 2);
  assert.deepEqual(windows.map((window) => window.hours), [2, 3]);
});

test("rule statistics count hours, not models", () => {
  const series = buildForecastSeries(
    {
      hours: [hourAt(9, { rainProbability: 80 }), hourAt(10), hourAt(11, { rainProbability: 90 })],
      failures: [],
    },
    now,
  );
  const rules = summariseRules(series.hours);
  const rain = rules.find((rule) => rule.rule === "rain_probability");
  assert.equal(rain?.hours, 2);
  assert.equal(Math.round((rain?.share ?? 0) * 100), 67);
});

test("slot statistics ignore cancelled departures for seat counts", () => {
  const base: Omit<SlotEvent, "id" | "status"> = {
    summary: "slot",
    description: "",
    start: new Date("2026-11-02T09:00:00Z"),
    end: new Date("2026-11-02T11:00:00Z"),
    maxPax: 4,
    bookedPax: 2,
    manualOverride: false,
  };
  const slots: SlotEvent[] = [
    { ...base, id: "a", status: "OPEN" },
    { ...base, id: "b", status: "CANCELLED", bookedPax: 3 },
    { ...base, id: "c", status: "LOCKED", manualOverride: true },
  ];
  const stats = summariseSlots(slots);
  assert.equal(stats.total, 3);
  assert.equal(stats.open, 1);
  assert.equal(stats.locked, 1);
  assert.equal(stats.cancelled, 1);
  assert.equal(stats.manualOverrides, 1);
  assert.equal(stats.seatsSold, 4);
  assert.equal(stats.seatsOffered, 8);
  assert.equal(stats.utilization, 0.5);
});

test("analytics aggregates the series and the calendar together", () => {
  const series = buildForecastSeries(
    {
      hours: [hourAt(9), hourAt(10), hourAt(30, { windSpeed10mKmh: 40, windSpeed80mKmh: 42 })],
      failures: ["icon_seamless: timeout"],
    },
    now,
  );
  const analytics = buildWeatherAnalytics(series, []);
  assert.equal(analytics.hours, 3);
  assert.equal(analytics.verdicts.FLYABLE, 2);
  assert.equal(analytics.verdicts.NO_GO, 1);
  assert.equal(analytics.daily.length, 2);
  assert.equal(analytics.daily[0]!.flyable, 2);
  assert.ok(analytics.daily[0]!.bestScore >= 60);
  assert.equal(series.failures.length, 1);
});

test("partially missing data yields marginal, never flyable", () => {
  const series = buildForecastSeries(
    { hours: [hourAt(9, { cloudCeilingM: null })], failures: [] },
    now,
  );
  assert.equal(series.hours[0]!.verdict, "MARGINAL");
  assert.equal(series.hours[0]!.models[0]!.pass, false);
});
