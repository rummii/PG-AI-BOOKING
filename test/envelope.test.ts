import assert from "node:assert/strict";
import test from "node:test";
import type { WeatherData } from "../src/types.js";

process.env.SITE_LAT = "45.0";
process.env.SITE_LON = "7.0";

const { directionDifference, evaluateEnvelope } = await import("../src/services/envelope.js");

const profile = {
  coordinatesConfigured: true,
  idealHeading: 340,
  headingTolerance: 35,
  minWindKmh: 12,
  maxWindKmh: 26,
  maxGustSpreadKmh: 8,
  maxRainProbability: 20,
  maxPrecipitationMm: 1,
  minCloudCeilingM: 300,
  maxCapeJkg: 1000,
};

function vector(overrides: Partial<WeatherData> = {}, model = "ecmwf_ifs025"): WeatherData {
  return {
    model,
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
    ...overrides,
  };
}

function pair(overrides: Partial<WeatherData> = {}): WeatherData[] {
  return [
    vector(overrides, "ecmwf_ifs025"),
    vector(overrides, "gfs_seamless"),
  ];
}

test("a clean forecast passes every check, scores high and agrees fully", () => {
  const result = evaluateEnvelope(pair(), profile);
  assert.deepEqual(result.unsafe, []);
  assert.deepEqual(result.uncertain, []);
  assert.equal(result.agreement, 1);
  assert.ok(result.score >= 45, `expected a comfortable score, got ${result.score}`);
  assert.ok(result.checks.every((check) => check.pass === true));
});

test("wind above the site maximum fails and drives the score to zero", () => {
  const result = evaluateEnvelope(pair({ windSpeed10mKmh: 30, windSpeed80mKmh: 31 }), profile);
  assert.equal(result.score, 0);
  assert.equal(result.agreement, 0);
  assert.deepEqual(result.failingModels.sort(), ["ecmwf_ifs025", "gfs_seamless"]);
  assert.match(result.unsafe.join(" "), /wind exceeds the site maximum/);
});

test("limits are inclusive: a value exactly at the limit still passes", () => {
  const result = evaluateEnvelope(pair({ windSpeed10mKmh: 26, windSpeed80mKmh: 26 }), profile);
  const maxCheck = result.checks.find((check) => check.rule === "wind_max");
  assert.equal(maxCheck?.pass, true);
  assert.equal(maxCheck?.margin, 0);
});

test("wind direction tolerance is inclusive and one degree beyond fails", () => {
  const atLimit = evaluateEnvelope(pair({ windDirection10mDeg: 15 }), profile);
  assert.equal(atLimit.checks.find((check) => check.rule === "wind_direction")?.pass, true);

  const beyond = evaluateEnvelope(pair({ windDirection10mDeg: 304 }), profile);
  assert.equal(beyond.checks.find((check) => check.rule === "wind_direction")?.pass, false);
  assert.match(beyond.unsafe.join(" "), /outside the site heading envelope/);
});

test("gust spread uses the difference between gusts and sustained wind", () => {
  const result = evaluateEnvelope(pair({ windSpeed10mKmh: 18, windGusts10mKmh: 30 }), profile);
  const spread = result.checks.find((check) => check.rule === "gust_spread");
  assert.equal(spread?.value, 12);
  assert.equal(spread?.pass, false);
});

test("missing forecast fields are reported as uncertain, never as passing", () => {
  const result = evaluateEnvelope(pair({ cloudCeilingM: null }), profile);
  assert.match(result.uncertain.join(" "), /missing required safety data/);
  assert.equal(result.agreement, 0);
  const completeness = result.checks.filter((check) => check.rule === "missing_data");
  assert.equal(completeness.length, 2);
  assert.ok(completeness.every((check) => check.pass === null));
  const cloudCheck = result.checks.find((check) => check.rule === "cloud_base");
  assert.equal(cloudCheck?.pass, null);
  assert.equal(cloudCheck?.message, null);
});

test("a single model is not enough for confidence", () => {
  const result = evaluateEnvelope([vector()], profile);
  assert.match(result.uncertain.join(" "), /Fewer than two forecast models/);
});

test("unconfigured coordinates are uncertain rather than unsafe", () => {
  const result = evaluateEnvelope(pair(), { ...profile, coordinatesConfigured: false });
  assert.deepEqual(result.unsafe, []);
  assert.match(result.uncertain.join(" "), /coordinates are not configured/);
});

test("score falls as the worst margin tightens", () => {
  const relaxed = evaluateEnvelope(pair({ windSpeed10mKmh: 18, windSpeed80mKmh: 18 }), profile);
  const tight = evaluateEnvelope(pair({ windSpeed10mKmh: 25, windSpeed80mKmh: 25 }), profile);
  assert.ok(tight.score < relaxed.score, `${tight.score} should be below ${relaxed.score}`);
});

test("directionDifference wraps around north correctly", () => {
  assert.equal(directionDifference(350, 10), 20);
  assert.equal(directionDifference(10, 350), 20);
  assert.equal(directionDifference(0, 180), 180);
});
