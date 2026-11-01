import type { EnvelopeRule } from "./envelope.js";
import type { ForecastSeries, SeriesHour } from "./weather-series.js";
import type { SlotEvent, Verdict } from "../types.js";

/**
 * Aggregates the forecast series and the calendar into the numbers the dashboard charts show.
 * Pure functions only: everything here is derived from inputs, so it is cheap to test.
 */

export interface VerdictCounts {
  FLYABLE: number;
  MARGINAL: number;
  NO_GO: number;
}

export interface RuleStat {
  rule: EnvelopeRule;
  label: string;
  /** Hours in which at least one model tripped this rule. */
  hours: number;
  /** Share of forecast hours, 0..1. */
  share: number;
}

export interface DailyStat {
  date: string;
  hours: number;
  flyable: number;
  marginal: number;
  noGo: number;
  bestScore: number;
  worstScore: number;
  averageScore: number;
}

export interface SlotStats {
  total: number;
  open: number;
  locked: number;
  standby: number;
  cancelled: number;
  confirmed: number;
  seatsSold: number;
  seatsOffered: number;
  utilization: number;
  manualOverrides: number;
}

export interface WeatherAnalytics {
  generatedAt: string;
  verdicts: VerdictCounts;
  hours: number;
  averageScore: number;
  averageAgreement: number;
  /** Hours where the models did not all agree on pass/fail. */
  disagreementHours: number;
  ruleStats: RuleStat[];
  daily: DailyStat[];
  slots: SlotStats;
  windows: ForecastSeries["windows"];
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function summariseSlots(slots: SlotEvent[]): SlotStats {
  const stats: SlotStats = {
    total: slots.length,
    open: 0,
    locked: 0,
    standby: 0,
    cancelled: 0,
    confirmed: 0,
    seatsSold: 0,
    seatsOffered: 0,
    utilization: 0,
    manualOverrides: 0,
  };
  for (const slot of slots) {
    if (slot.status === "OPEN") stats.open += 1;
    else if (slot.status === "LOCKED") stats.locked += 1;
    else if (slot.status === "STANDBY") stats.standby += 1;
    else if (slot.status === "CANCELLED") stats.cancelled += 1;
    else stats.confirmed += 1;
    if (slot.status !== "CANCELLED") {
      stats.seatsSold += slot.bookedPax;
      stats.seatsOffered += slot.maxPax;
    }
    if (slot.manualOverride) stats.manualOverrides += 1;
  }
  stats.utilization = stats.seatsOffered === 0 ? 0 : stats.seatsSold / stats.seatsOffered;
  return stats;
}

export function summariseRules(hours: SeriesHour[]): RuleStat[] {
  const counts = new Map<EnvelopeRule, { label: string; hours: number }>();
  for (const hour of hours) {
    for (const failure of hour.ruleFailures) {
      const existing = counts.get(failure.rule);
      if (existing) existing.hours += 1;
      else counts.set(failure.rule, { label: failure.label, hours: 1 });
    }
  }
  return [...counts.entries()]
    .map(([rule, value]) => ({
      rule,
      label: value.label,
      hours: value.hours,
      share: hours.length === 0 ? 0 : value.hours / hours.length,
    }))
    .sort((left, right) => right.hours - left.hours);
}

export function summariseDays(hours: SeriesHour[]): DailyStat[] {
  const byDate = new Map<string, SeriesHour[]>();
  for (const hour of hours) {
    const bucket = byDate.get(hour.date);
    if (bucket) bucket.push(hour);
    else byDate.set(hour.date, [hour]);
  }
  return [...byDate.entries()]
    .sort((left, right) => left[0].localeCompare(right[0]))
    .map(([date, dayHours]) => {
      const scores = dayHours.map((hour) => hour.score);
      const count = (verdict: Verdict): number =>
        dayHours.filter((hour) => hour.verdict === verdict).length;
      return {
        date,
        hours: dayHours.length,
        flyable: count("FLYABLE"),
        marginal: count("MARGINAL"),
        noGo: count("NO_GO"),
        bestScore: Math.max(...scores),
        worstScore: Math.min(...scores),
        averageScore: Math.round(average(scores)),
      };
    });
}

export function buildWeatherAnalytics(series: ForecastSeries, slots: SlotEvent[]): WeatherAnalytics {
  const verdicts: VerdictCounts = { FLYABLE: 0, MARGINAL: 0, NO_GO: 0 };
  for (const hour of series.hours) verdicts[hour.verdict] += 1;

  return {
    generatedAt: series.generatedAt,
    verdicts,
    hours: series.hours.length,
    averageScore: Math.round(average(series.hours.map((hour) => hour.score))),
    averageAgreement: Number(average(series.hours.map((hour) => hour.agreement)).toFixed(2)),
    disagreementHours: series.hours.filter((hour) => hour.agreement > 0 && hour.agreement < 1).length,
    ruleStats: summariseRules(series.hours),
    daily: summariseDays(series.hours),
    slots: summariseSlots(slots),
    windows: series.windows,
  };
}
