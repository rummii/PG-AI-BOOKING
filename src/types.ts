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
}

export interface Passenger {
  name: string;
  weight_kg: number;
  contact: string;
  emergency_contact: string;
}
