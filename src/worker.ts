import cron from "node-cron";
import { config } from "./config/site.js";
import { syncCalendarSlots } from "./services/calendar.js";
import { materialiseTemplateSlots } from "./services/slot-admin.js";
import { getSiteConfig } from "./services/site-config.js";
import {
  evaluateAndSyncSlot,
  getForecastWindowEnd,
  isCurrentLocalDay,
} from "./services/slot-evaluation.js";

let running = false;

/**
 * Keeps the calendar stocked with the slots the weekly templates promise. Runs before the
 * evaluation cycle so freshly created LOCKED slots can be assessed in the same pass.
 */
async function runMaterialisation(): Promise<void> {
  try {
    const siteConfig = await getSiteConfig();
    if (siteConfig.templates.length === 0) return;
    const result = await materialiseTemplateSlots(siteConfig, new Date());
    if (result.created.length > 0 || result.errors.length > 0) {
      console.info(
        JSON.stringify({
          event: "template_materialisation",
          created: result.created.length,
          planned: result.planned,
          skippedDates: result.skippedDates.length,
          errors: result.errors,
        }),
      );
    }
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "template_materialisation_failed",
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }
}

async function runEvaluation(mode: "rolling" | "today"): Promise<void> {
  if (running) {
    console.warn(JSON.stringify({ event: "evaluation_cycle_skipped", reason: "previous cycle still running" }));
    return;
  }
  running = true;
  const now = new Date();
  try {
    if (mode === "rolling") await runMaterialisation();
    const slots = await syncCalendarSlots(now, getForecastWindowEnd(now));
    const selected =
      mode === "today" ? slots.filter((slot) => isCurrentLocalDay(slot.start, now)) : slots;

    console.info(JSON.stringify({ event: "evaluation_cycle_started", mode, slots: selected.length }));
    for (const slot of selected) {
      if (slot.manualOverride || slot.status === "CANCELLED") continue;
      try {
        const result = await evaluateAndSyncSlot(slot);
        if (!result.skipped) {
          console.info(
            JSON.stringify({
              event: "slot_evaluation_completed",
              slotId: slot.id,
              status: result.status,
              ...(result.error ? { error: result.error } : {}),
              ...(result.alertError ? { alertError: result.alertError } : {}),
            }),
          );
        }
      } catch (error) {
        console.error(
          JSON.stringify({
            event: "slot_sync_failed",
            slotId: slot.id,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      }
    }
    console.info(JSON.stringify({ event: "evaluation_cycle_completed", mode }));
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "evaluation_cycle_failed",
        mode,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  } finally {
    running = false;
  }
}

function startWorker(): void {
  console.info(
    JSON.stringify({
      event: "worker_started",
      site: config.SITE_NAME,
      timezone: config.SITE_TIMEZONE,
      schedule: "rolling at minute 0; current local day every 15 minutes",
    }),
  );
  cron.schedule(
    "*/15 * * * *",
    () => {
      const mode = new Date().getMinutes() === 0 ? "rolling" : "today";
      void runEvaluation(mode);
    },
    { timezone: config.SITE_TIMEZONE },
  );
  void runEvaluation("rolling");
}

startWorker();
