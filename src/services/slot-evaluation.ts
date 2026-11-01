import { config, site } from "../config/site.js";
import type { EvaluationResult, SlotEvent, SlotStatus } from "../types.js";
import { CalendarConflictError, updateSlotState } from "./calendar.js";
import { evaluateSlotConditions } from "./evaluator.js";
import { fetchWeatherVectors } from "./weather.js";

/** Conflicting calendar writes are retried once with a freshly read ETag before giving up. */
const SLOT_UPDATE_ATTEMPTS = 2;

export interface SlotStateEvaluation {
  verdict: string;
  confidence: number;
  evaluatedAt: Date;
  limitingFactors: string[];
  reasoning: string;
}

export interface SlotEvaluationDependencies {
  fetchWeatherVectors: typeof fetchWeatherVectors;
  evaluateSlotConditions: typeof evaluateSlotConditions;
  updateSlotState: typeof updateSlotState;
}

export interface SlotEvaluationOutcome {
  skipped: boolean;
  status?: SlotStatus;
  error?: string;
  alertError?: string;
}

const defaultDependencies: SlotEvaluationDependencies = {
  fetchWeatherVectors,
  evaluateSlotConditions,
  updateSlotState,
};

export function chooseStatus(slot: SlotEvent, evaluation: EvaluationResult, now: Date): SlotStatus {
  if (evaluation.verdict === "NO_GO") return "CANCELLED";
  if (evaluation.verdict === "MARGINAL") return "STANDBY";

  const hoursUntilSlot = (slot.start.getTime() - now.getTime()) / 3_600_000;
  if (hoursUntilSlot <= 2) return "CONFIRMED";
  if (slot.status === "OPEN" || slot.status === "CONFIRMED") return slot.status;
  if (slot.status === "LOCKED" && hoursUntilSlot <= 72 && hoursUntilSlot >= 48) return "OPEN";
  return slot.status;
}

async function writeSlotStatus(
  dependencies: SlotEvaluationDependencies,
  slot: SlotEvent,
  status: SlotStatus,
  evaluation: SlotStateEvaluation,
): Promise<void> {
  let expectedEtag: string | undefined = slot.etag;
  for (let attempt = 1; attempt <= SLOT_UPDATE_ATTEMPTS; attempt += 1) {
    try {
      await dependencies.updateSlotState(slot.id, status, evaluation, expectedEtag);
      return;
    } catch (error) {
      if (!(error instanceof CalendarConflictError) || attempt === SLOT_UPDATE_ATTEMPTS) throw error;
      console.warn(
        JSON.stringify({
          event: "slot_update_conflict_retry",
          slotId: slot.id,
          status,
          attempt,
        }),
      );
      expectedEtag = undefined;
    }
  }
}

export async function evaluateAndSyncSlot(
  slot: SlotEvent,
  options: { ignoreManualOverride?: boolean; now?: Date } = {},
  dependencies: SlotEvaluationDependencies = defaultDependencies,
): Promise<SlotEvaluationOutcome> {
  if (slot.manualOverride && !options.ignoreManualOverride) return { skipped: true };
  if (slot.status === "CANCELLED") return { skipped: true };

  const evaluatedAt = options.now ?? new Date();
  try {
    const vectors = await dependencies.fetchWeatherVectors(slot.start);
    const evaluation = await dependencies.evaluateSlotConditions(slot.start, vectors);
    const status = chooseStatus(slot, evaluation, evaluatedAt);
    await writeSlotStatus(dependencies, slot, status, {
      verdict: evaluation.verdict,
      confidence: evaluation.confidence_score,
      evaluatedAt,
      limitingFactors: evaluation.limiting_factors,
      reasoning: evaluation.reasoning_summary,
    });
    if (status === "CANCELLED") {
      try {
        await sendAbortAlert(slot, evaluation, evaluatedAt);
      } catch (error) {
        const alertError = error instanceof Error ? error.message : String(error);
        console.error(
          JSON.stringify({
            event: "abort_alert_failed",
            slotId: slot.id,
            error: alertError,
          }),
        );
        return { skipped: false, status, alertError };
      }
    }
    return { skipped: false, status };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      JSON.stringify({
        event: "slot_evaluation_failed",
        slotId: slot.id,
        error: message,
      }),
    );
    try {
      await writeSlotStatus(dependencies, slot, "STANDBY", {
        verdict: "MARGINAL",
        confidence: 0,
        evaluatedAt,
        limitingFactors: ["Automated evaluation unavailable; human review required"],
        reasoning: "The automated evaluation did not complete successfully. This slot was not opened.",
      });
    } catch (standbyError) {
      const standbyMessage = standbyError instanceof Error ? standbyError.message : String(standbyError);
      console.error(
        JSON.stringify({
          event: "slot_standby_write_failed",
          slotId: slot.id,
          error: standbyMessage,
          evaluationError: message,
        }),
      );
      return { skipped: false, error: `${message}; STANDBY could not be recorded: ${standbyMessage}` };
    }
    return { skipped: false, status: "STANDBY", error: message };
  }
}

async function sendAbortAlert(
  slot: SlotEvent,
  evaluation: EvaluationResult,
  evaluatedAt: Date,
): Promise<void> {
  const webhookUrl = config.ALERT_WEBHOOK_URL;
  if (!webhookUrl) throw new Error("ALERT_WEBHOOK_URL is not configured");
  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    signal: AbortSignal.timeout(config.DEEPSEEK_TIMEOUT_MS),
    body: JSON.stringify({
      event: "paragliding.slot_abort",
      site: site.name,
      slotId: slot.id,
      summary: slot.summary,
      start: slot.start.toISOString(),
      bookedPax: slot.bookedPax,
      status: "CANCELLED",
      verdict: evaluation.verdict,
      limitingFactors: evaluation.limiting_factors,
      reasoning: evaluation.reasoning_summary,
      evaluatedAt: evaluatedAt.toISOString(),
    }),
  });
  if (!response.ok) throw new Error(`Abort alert webhook failed with HTTP ${response.status}`);
}



export function getForecastWindowEnd(now: Date): Date {
  return new Date(now.getTime() + 72 * 3_600_000);
}

export function isCurrentLocalDay(date: Date, now: Date): boolean {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: config.SITE_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return formatter.format(date) === formatter.format(now);
}
