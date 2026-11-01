import assert from "node:assert/strict";
import test from "node:test";
import type { WeatherData } from "../src/types.js";

process.env.SITE_LAT = "45.0";
process.env.SITE_LON = "7.0";
process.env.DEEPSEEK_API_KEY = "";

const { evaluateSlotConditions } = await import("../src/services/evaluator.js");

function forecast(overrides: Partial<WeatherData> = {}): WeatherData[] {
  const base: WeatherData = {
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
  return [
    { ...base, ...overrides, model: "ecmwf_ifs025" },
    { ...base, ...overrides, model: "gfs_seamless" },
  ];
}

test("hard site-envelope violations produce NO_GO without calling DeepSeek", async () => {
  const result = await evaluateSlotConditions(new Date("2026-11-01T10:00:00Z"), forecast({ windSpeed10mKmh: 30 }));
  assert.equal(result.verdict, "NO_GO");
  assert.equal(result.action, "CANCEL");
  assert.match(result.limiting_factors.join(" "), /wind exceeds the site maximum/i);
});

test("missing required forecast fields produce STANDBY instead of opening a slot", async () => {
  const result = await evaluateSlotConditions(
    new Date("2026-11-01T10:00:00Z"),
    forecast({ cloudCeilingM: null }),
  );
  assert.equal(result.verdict, "MARGINAL");
  assert.equal(result.action, "STANDBY");
  assert.equal(result.confidence_score, 0);
});

test("forecast precipitation above the site limit produces NO_GO", async () => {
  const result = await evaluateSlotConditions(new Date("2026-11-01T10:00:00Z"), forecast({ precipitationMm: 4 }));
  assert.equal(result.verdict, "NO_GO");
  assert.equal(result.action, "CANCEL");
  assert.match(result.limiting_factors.join(" "), /precipitation exceeds the site limit/i);
});

test("missing precipitation data fails closed without consulting DeepSeek", async () => {
  const result = await evaluateSlotConditions(
    new Date("2026-11-01T10:00:00Z"),
    forecast({ precipitationMm: null }),
  );
  assert.equal(result.verdict, "MARGINAL");
  assert.equal(result.action, "STANDBY");
  assert.match(result.limiting_factors.join(" "), /missing required safety data/i);
});

test("valid forecasts fail closed when DeepSeek is not configured", async () => {
  await assert.rejects(
    evaluateSlotConditions(new Date("2026-11-01T10:00:00Z"), forecast()),
    /DEEPSEEK_API_KEY is not configured/,
  );
});
