import { site } from "../config/site.js";
import type { WeatherData } from "../types.js";

/**
 * The deterministic site safety envelope.
 *
 * This module is the single source of truth for the hard limits: the AI evaluator uses it as a
 * gate, and the admin dashboard uses it to draw pass/fail statistics. Both must therefore agree
 * by construction, which is why the rule checks live here and not in the evaluator prompt.
 */

export type EnvelopeRule =
  | "missing_data"
  | "wind_min_10m"
  | "wind_max"
  | "gust_spread"
  | "wind_direction"
  | "rain_probability"
  | "precipitation"
  | "cloud_base"
  | "cape";

export interface EnvelopeProfile {
  coordinatesConfigured: boolean;
  idealHeading: number;
  headingTolerance: number;
  minWindKmh: number;
  maxWindKmh: number;
  maxGustSpreadKmh: number;
  maxRainProbability: number;
  maxPrecipitationMm: number;
  minCloudCeilingM: number;
  maxCapeJkg: number;
}

export interface EnvelopeCheck {
  rule: EnvelopeRule;
  model: string;
  /** Human label used by the dashboard legend and the accessible table. */
  label: string;
  unit: string;
  value: number | null;
  limit: number | null;
  /** `null` means the check could not be evaluated because forecast data is missing. */
  pass: boolean | null;
  /** Remaining headroom as a 0..1 fraction of the limit; `0` at or beyond the limit. */
  margin: number | null;
  /** Present only when the check failed or could not be evaluated. */
  message: string | null;
}

export interface EnvelopeResult {
  checks: EnvelopeCheck[];
  /** Deterministic failures. Any entry here is an automatic NO_GO. */
  unsafe: string[];
  /** Missing inputs. Any entry here (without an unsafe entry) forces STANDBY. */
  uncertain: string[];
  /** 0..100. Worst headroom across every evaluable check; 0 when anything fails. */
  score: number;
  /** 0..1. Share of models whose every evaluable check passed. */
  agreement: number;
  failingModels: string[];
}

export const RULE_LABELS: Record<EnvelopeRule, string> = {
  missing_data: "Forecast completeness",
  wind_min_10m: "Minimum 10 m wind",
  wind_max: "Maximum wind",
  gust_spread: "Gust spread",
  wind_direction: "Wind direction",
  rain_probability: "Rain probability",
  precipitation: "Precipitation",
  cloud_base: "Cloud base",
  cape: "CAPE",
};

const REQUIRED_FIELDS: Array<keyof WeatherData> = [
  "windSpeed10mKmh",
  "windSpeed80mKmh",
  "windDirection10mDeg",
  "windGusts10mKmh",
  "rainProbability",
  "precipitationMm",
  "cloudCeilingM",
  "capeJkg",
  "cloudCoverPercent",
];

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/** Share of a hard limit that counts as "at the edge"; inside it, headroom is scored linearly. */
const GREEN_BAND = 0.25;

/** Headroom for a `value <= limit` rule, expressed as a fraction of the edge band. */
function maxHeadroom(value: number, limit: number): number {
  if (limit === 0) return value <= 0 ? 1 : 0;
  return clamp01((limit - value) / (Math.abs(limit) * GREEN_BAND));
}

/** Headroom for a `value >= limit` rule, expressed as a fraction of the limit. */
function minHeadroom(value: number, limit: number): number {
  if (limit === 0) return value >= 0 ? 1 : 0;
  return clamp01((value - limit) / Math.abs(limit));
}

export function directionDifference(a: number, b: number): number {
  const difference = Math.abs((((a - b) % 360) + 360) % 360);
  return Math.min(difference, 360 - difference);
}

export function directionHeadroom(direction: number, idealHeading: number, tolerance: number): number {
  const difference = directionDifference(direction, idealHeading);
  if (tolerance === 0) return difference === 0 ? 1 : 0;
  return clamp01(1 - difference / tolerance);
}

interface CheckSpec {
  rule: EnvelopeRule;
  value: number | null;
  limit: number;
  unit: string;
  /** Returns the headroom fraction, or `null` when the value is missing. */
  headroom: (value: number) => number;
  /** Overrides the default `margin > 0 || value === limit` pass rule. */
  passes?: (value: number) => boolean;
  failure: string;
}

function buildCheck(model: string, spec: CheckSpec): EnvelopeCheck {
  if (spec.value === null || !Number.isFinite(spec.value)) {
    return {
      rule: spec.rule,
      model,
      label: RULE_LABELS[spec.rule],
      unit: spec.unit,
      value: null,
      limit: spec.limit,
      pass: null,
      margin: null,
      message: null,
    };
  }
  const margin = clamp01(spec.headroom(spec.value));
  const pass = spec.passes ? spec.passes(spec.value) : margin > 0 || spec.value === spec.limit;
  return {
    rule: spec.rule,
    model,
    label: RULE_LABELS[spec.rule],
    unit: spec.unit,
    value: spec.value,
    limit: spec.limit,
    pass,
    margin,
    message: pass ? null : spec.failure,
  };
}

function checkSpecs(vector: WeatherData, profile: EnvelopeProfile): CheckSpec[] {
  const windCeiling = Math.max(vector.windSpeed10mKmh ?? Number.NEGATIVE_INFINITY, vector.windSpeed80mKmh ?? Number.NEGATIVE_INFINITY);
  return [
    {
      rule: "wind_min_10m",
      value: vector.windSpeed10mKmh,
      limit: profile.minWindKmh,
      unit: "km/h",
      headroom: (value) => minHeadroom(value, profile.minWindKmh),
      failure: `${vector.model} 10m wind is below the site minimum`,
    },
    {
      rule: "wind_max",
      value: Number.isFinite(windCeiling) ? windCeiling : null,
      limit: profile.maxWindKmh,
      unit: "km/h",
      headroom: (value) => maxHeadroom(value, profile.maxWindKmh),
      failure: `${vector.model} wind exceeds the site maximum`,
    },
    {
      rule: "gust_spread",
      value:
        vector.windGusts10mKmh === null || vector.windSpeed10mKmh === null
          ? null
          : vector.windGusts10mKmh - vector.windSpeed10mKmh,
      limit: profile.maxGustSpreadKmh,
      unit: "km/h",
      headroom: (value) => maxHeadroom(value, profile.maxGustSpreadKmh),
      failure: `${vector.model} gust spread exceeds the site limit`,
    },
    {
      rule: "wind_direction",
      value: vector.windDirection10mDeg,
      limit: profile.headingTolerance,
      unit: "° off ideal",
      headroom: (value) => directionHeadroom(value, profile.idealHeading, profile.headingTolerance),
      passes: (value) =>
        directionDifference(value, profile.idealHeading) <= profile.headingTolerance,
      failure: `${vector.model} wind direction is outside the site heading envelope`,
    },
    {
      rule: "rain_probability",
      value: vector.rainProbability,
      limit: profile.maxRainProbability,
      unit: "%",
      headroom: (value) => maxHeadroom(value, profile.maxRainProbability),
      failure: `${vector.model} rain probability exceeds the site limit`,
    },
    {
      rule: "precipitation",
      value: vector.precipitationMm,
      limit: profile.maxPrecipitationMm,
      unit: "mm",
      headroom: (value) => maxHeadroom(value, profile.maxPrecipitationMm),
      failure: `${vector.model} forecast precipitation exceeds the site limit`,
    },
    {
      rule: "cloud_base",
      value: vector.cloudCeilingM,
      limit: profile.minCloudCeilingM,
      unit: "m",
      headroom: (value) => minHeadroom(value, profile.minCloudCeilingM),
      failure: `${vector.model} estimated cloud base is below the site minimum`,
    },
    {
      rule: "cape",
      value: vector.capeJkg,
      limit: profile.maxCapeJkg,
      unit: "J/kg",
      headroom: (value) => maxHeadroom(value, profile.maxCapeJkg),
      failure: `${vector.model} CAPE exceeds the configured limit`,
    },
  ];
}

export function evaluateEnvelope(
  vectors: WeatherData[],
  profile: EnvelopeProfile = site,
): EnvelopeResult {
  const unsafe = new Set<string>();
  const uncertain = new Set<string>();
  const failingModels = new Set<string>();
  const checks: EnvelopeCheck[] = [];
  let fullyPassing = 0;
  let minimumMargin: number | null = null;

  if (!profile.coordinatesConfigured) uncertain.add("Site coordinates are not configured");
  if (vectors.length < 2) uncertain.add("Fewer than two forecast models are available");

  for (const vector of vectors) {
    const model = vector.model;
    const missing = REQUIRED_FIELDS.some((field) => vector[field] === null);
    const completeness: EnvelopeCheck = missing
      ? {
          rule: "missing_data",
          model,
          label: RULE_LABELS.missing_data,
          unit: "",
          value: null,
          limit: REQUIRED_FIELDS.length,
          pass: null,
          margin: null,
          message: `${model} forecast is missing required safety data`,
        }
      : {
          rule: "missing_data",
          model,
          label: RULE_LABELS.missing_data,
          unit: "",
          value: REQUIRED_FIELDS.length,
          limit: REQUIRED_FIELDS.length,
          pass: true,
          margin: 1,
          message: null,
        };
    if (missing) uncertain.add(`${model} forecast is missing required safety data`);
    checks.push(completeness);

    let modelPasses = !missing;
    for (const spec of checkSpecs(vector, profile)) {
      const check = buildCheck(model, spec);
      checks.push(check);
      if (check.margin !== null) {
        minimumMargin = minimumMargin === null ? check.margin : Math.min(minimumMargin, check.margin);
      }
      if (check.pass === false) {
        modelPasses = false;
        unsafe.add(spec.failure);
      }
    }

    if (modelPasses) fullyPassing += 1;
    else failingModels.add(model);
  }

  return {
    checks,
    unsafe: [...unsafe],
    uncertain: [...uncertain],
    score: minimumMargin === null ? 0 : Math.round(minimumMargin * 100),
    agreement: vectors.length === 0 ? 0 : fullyPassing / vectors.length,
    failingModels: [...failingModels],
  };
}
