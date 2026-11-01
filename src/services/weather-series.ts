import { site } from "../config/site.js";
import type { Verdict } from "../types.js";
import { evaluateEnvelope, type EnvelopeRule } from "./envelope.js";
import { localDateKey, localTimeLabel } from "./site-time.js";
import { fetchWeatherSeries, type WeatherSeries } from "./weather.js";

/**
 * Turns raw multi-model forecast hours into the numbers the admin outlook draws: a per-hour
 * score, the verdict that score implies, and which rule each model tripped.
 */

export interface SeriesModel {
  model: string;
  wind10Kmh: number | null;
  wind80Kmh: number | null;
  gustSpreadKmh: number | null;
  directionDeg: number | null;
  rainProbability: number | null;
  precipitationMm: number | null;
  cloudCeilingM: number | null;
  capeJkg: number | null;
  score: number;
  pass: boolean;
}

export interface SeriesRuleFailure {
  rule: EnvelopeRule;
  label: string;
  models: string[];
}

export interface SeriesHour {
  time: string;
  date: string;
  label: string;
  score: number;
  agreement: number;
  verdict: Verdict;
  models: SeriesModel[];
  ruleFailures: SeriesRuleFailure[];
  /** Human-readable failures, matching the wording the evaluator logs. */
  messages: string[];
}

export interface RecommendedWindow {
  from: string;
  to: string;
  date: string;
  hours: number;
  averageScore: number;
}

export interface ForecastSeries {
  generatedAt: string;
  horizonHours: number;
  hours: SeriesHour[];
  windows: RecommendedWindow[];
  failures: string[];
  profile: {
    maxWindKmh: number;
    minWindKmh: number;
    maxGustSpreadKmh: number;
    idealHeading: number;
    headingTolerance: number;
    maxRainProbability: number;
    maxPrecipitationMm: number;
    minCloudCeilingM: number;
    maxCapeJkg: number;
  };
}

/** A window is only promoted when a comfortable share of the models agree it is on. */
const FLYABLE_SCORE = 60;
const FLYABLE_AGREEMENT = 0.66;

export function verdictFor(score: number, agreement: number, hasFailure: boolean): Verdict {
  if (hasFailure) return "NO_GO";
  if (score >= FLYABLE_SCORE && agreement >= FLYABLE_AGREEMENT) return "FLYABLE";
  return "MARGINAL";
}

export function buildForecastSeries(series: WeatherSeries, now: Date): ForecastSeries {
  const hours: SeriesHour[] = series.hours.map((hour) => {
    const envelope = evaluateEnvelope(hour.vectors);
    const models: SeriesModel[] = hour.vectors.map((vector) => {
      // Scoring one model at a time is what "did this model pass?" means; the hour-level
      // verdict below still uses every model together.
      const own = evaluateEnvelope([vector]);
      return {
        model: vector.model,
        wind10Kmh: vector.windSpeed10mKmh,
        wind80Kmh: vector.windSpeed80mKmh,
        gustSpreadKmh:
          vector.windGusts10mKmh === null || vector.windSpeed10mKmh === null
            ? null
            : vector.windGusts10mKmh - vector.windSpeed10mKmh,
        directionDeg: vector.windDirection10mDeg,
        rainProbability: vector.rainProbability,
        precipitationMm: vector.precipitationMm,
        cloudCeilingM: vector.cloudCeilingM,
        capeJkg: vector.capeJkg,
        score: own.score,
        pass: own.checks.every((check) => check.pass === true),
      };
    });

    const failuresByRule = new Map<EnvelopeRule, SeriesRuleFailure>();
    for (const check of envelope.checks) {
      if (check.pass !== false) continue;
      const existing = failuresByRule.get(check.rule);
      if (existing) {
        if (!existing.models.includes(check.model)) existing.models.push(check.model);
      } else {
        failuresByRule.set(check.rule, {
          rule: check.rule,
          label: check.label,
          models: [check.model],
        });
      }
    }

    return {
      time: hour.time.toISOString(),
      date: localDateKey(hour.time),
      label: localTimeLabel(hour.time),
      score: envelope.score,
      agreement: envelope.agreement,
      verdict: verdictFor(envelope.score, envelope.agreement, envelope.unsafe.length > 0),
      models,
      ruleFailures: [...failuresByRule.values()],
      messages: envelope.unsafe,
    };
  });

  return {
    generatedAt: now.toISOString(),
    horizonHours: hours.length,
    hours,
    windows: findWindows(hours),
    failures: series.failures,
    profile: {
      maxWindKmh: site.maxWindKmh,
      minWindKmh: site.minWindKmh,
      maxGustSpreadKmh: site.maxGustSpreadKmh,
      idealHeading: site.idealHeading,
      headingTolerance: site.headingTolerance,
      maxRainProbability: site.maxRainProbability,
      maxPrecipitationMm: site.maxPrecipitationMm,
      minCloudCeilingM: site.minCloudCeilingM,
      maxCapeJkg: site.maxCapeJkg,
    },
  };
}

/** Groups consecutive FLYABLE hours into windows a human can plan a day around. */
export function findWindows(hours: SeriesHour[], minimumHours = 2): RecommendedWindow[] {
  const windows: RecommendedWindow[] = [];
  let current: SeriesHour[] = [];

  const flush = (): void => {
    if (current.length >= minimumHours) {
      const first = current[0];
      const last = current[current.length - 1];
      if (first && last) {
        const scores = current.map((hour) => hour.score);
        windows.push({
          from: first.time,
          to: last.time,
          date: first.date,
          hours: current.length,
          averageScore: Math.round(scores.reduce((sum, score) => sum + score, 0) / current.length),
        });
      }
    }
    current = [];
  };

  for (const hour of hours) {
    if (hour.verdict === "FLYABLE") current.push(hour);
    else flush();
  }
  flush();
  return windows;
}

export async function getForecastSeries(
  options: { hours?: number; now?: Date } = {},
): Promise<ForecastSeries> {
  const now = options.now ?? new Date();
  const horizon = Math.max(6, Math.min(options.hours ?? 48, 72));
  const series = await fetchWeatherSeries(now, horizon);
  return buildForecastSeries(series, now);
}
