export type SlotStatus = "LOCKED" | "OPEN" | "STANDBY" | "CONFIRMED" | "CANCELLED";
export type Verdict = "FLYABLE" | "MARGINAL" | "NO_GO";
export type EvaluationAction = "OPEN" | "STANDBY" | "CANCEL";

export interface WeatherData {
  model: string;
  time: string;
  windSpeed10mKmh: number | null;
  windSpeed80mKmh: number | null;
  windDirection10mDeg: number | null;
  windGusts10mKmh: number | null;
  rainProbability: number | null;
  precipitationMm: number | null;
  capeJkg: number | null;
  cloudCoverPercent: number | null;
  cloudCeilingM: number | null;
}

export interface EvaluationResult {
  verdict: Verdict;
  action: EvaluationAction;
  confidence_score: number;
  limiting_factors: string[];
  reasoning_summary: string;
}

export interface SlotEvent {
  id: string;
  etag?: string;
  summary: string;
  description: string;
  start: Date;
  end: Date;
  status: SlotStatus;
  maxPax: number;
  bookedPax: number;
  manualOverride: boolean;
  /** Last AI verdict recorded on the event by the weather worker. */
  verdict?: Verdict;
  /** 0..1 confidence that accompanied `verdict`. */
  confidence?: number;
  lastEvaluatedAt?: string;
  limitingFactors?: string[];
  reasoningSummary?: string;
}

export interface Passenger {
  name: string;
  weight_kg: number;
  contact: string;
  emergency_contact: string;
}

export type BookingMode = "open" | "focus-first" | "focus-only";

export interface FocusPeriod {
  label: string;
  /** Inclusive site-local date, `YYYY-MM-DD`. */
  from: string;
  /** Inclusive site-local date, `YYYY-MM-DD`. */
  to: string;
}

/**
 * Admin-controlled rules that steer bookers towards the dates the operator wants to fill.
 * Stored with the rest of the site config; never part of the safety envelope.
 */
export interface BookingPolicy {
  bookingWindowDays: number;
  minLeadHours: number;
  mode: BookingMode;
  focus: FocusPeriod | null;
  notice: string;
  /** Site-local dates that can never be booked, `YYYY-MM-DD`. */
  blackouts: string[];
  /** 0 = Sunday … 6 = Saturday. */
  closedWeekdays: number[];
  defaultMaxPax: number;
}

export interface ScheduleTemplate {
  id: string;
  label: string;
  weekdays: number[];
  /** Site-local `HH:MM` departure times. */
  times: string[];
  durationMinutes: number;
  maxPax: number;
  enabled: boolean;
}

export interface AuditEntry {
  at: string;
  actor: string;
  action: string;
  target: string;
  detail: string;
}

export interface SiteConfig {
  version: 1;
  updatedAt: string;
  updatedBy: string;
  policy: BookingPolicy;
  templates: ScheduleTemplate[];
  audit: AuditEntry[];
}

export type DayState = "open" | "marginal" | "full" | "locked" | "blackout" | "closed" | "past";

