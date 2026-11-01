import { google, type calendar_v3 } from "googleapis";
import { config } from "../config/site.js";
import type { SlotEvent, SlotStatus } from "../types.js";

const PREFIX_STATUS: Record<SlotStatus, string> = {
  OPEN: "[OPEN]",
  STANDBY: "[STANDBY]",
  LOCKED: "[LOCKED]",
  CONFIRMED: "[CONFIRMED]",
  CANCELLED: "[WX CANCEL]",
};

/** Admin cancellations are not weather cancellations; keep them visually distinct in the agenda. */
const ADMIN_CANCEL_PREFIX = "[CANCELLED]";

const STATUS_COLOR: Record<SlotStatus, string> = {
  OPEN: "10",
  CONFIRMED: "10",
  STANDBY: "5",
  CANCELLED: "11",
  LOCKED: "8",
};

/** The config event is parked in 1990 so it can never appear in an availability query. */
const CONFIG_EVENT_START = "1990-01-01T00:00:00Z";
const CONFIG_EVENT_END = "1990-01-01T00:05:00Z";
const CONFIG_EVENT_SUMMARY = "[CONFIG] Site booking configuration";

export class CalendarConflictError extends Error {}

function httpStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const candidate = error as { code?: unknown; response?: { status?: unknown } };
  if (typeof candidate.response?.status === "number") return candidate.response.status;
  return typeof candidate.code === "number" ? candidate.code : undefined;
}

function getCalendar(): calendar_v3.Calendar {
  const email = config.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const privateKey = config.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, "\n");
  if (!email || !privateKey || !config.PARAGLIDING_CALENDAR_ID) {
    throw new Error(
      "GOOGLE_SERVICE_ACCOUNT_EMAIL, GOOGLE_PRIVATE_KEY, and PARAGLIDING_CALENDAR_ID are required",
    );
  }
  const auth = new google.auth.JWT({
    email,
    key: privateKey,
    scopes: ["https://www.googleapis.com/auth/calendar"],
  });
  return google.calendar({ version: "v3", auth });
}

export function isCalendarConfigured(): boolean {
  return Boolean(
    config.GOOGLE_SERVICE_ACCOUNT_EMAIL &&
      config.GOOGLE_PRIVATE_KEY &&
      config.PARAGLIDING_CALENDAR_ID,
  );
}

function readStatus(event: calendar_v3.Schema$Event): SlotStatus {
  const status = event.extendedProperties?.private?.status;
  if (
    status === "OPEN" ||
    status === "STANDBY" ||
    status === "LOCKED" ||
    status === "CONFIRMED" ||
    status === "CANCELLED"
  ) {
    return status;
  }
  return "LOCKED";
}

export function parseSlot(event: calendar_v3.Schema$Event): SlotEvent | null {
  if (!event.id || !event.start?.dateTime || !event.end?.dateTime) return null;
  const start = new Date(event.start.dateTime);
  const end = new Date(event.end.dateTime);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start) return null;

  const privateProperties = event.extendedProperties?.private ?? {};
  const maxPax = Number(privateProperties.maxPax ?? config.DEFAULT_MAX_PAX);
  const bookedPax = Number(privateProperties.bookedPax ?? 0);
  const verdictValue = privateProperties.deepseekVerdict;
  const verdict =
    verdictValue === "FLYABLE" || verdictValue === "MARGINAL" || verdictValue === "NO_GO"
      ? verdictValue
      : undefined;
  const confidence = Number(privateProperties.confidence);
  const factors = (privateProperties.limitingFactors ?? "")
    .split(";")
    .map((factor) => factor.trim())
    .filter(Boolean);
  return {
    id: event.id,
    ...(event.etag ? { etag: event.etag } : {}),
    summary: event.summary ?? "Paragliding booking slot",
    description: event.description ?? "",
    start,
    end,
    status: readStatus(event),
    maxPax: Number.isInteger(maxPax) && maxPax > 0 ? maxPax : config.DEFAULT_MAX_PAX,
    bookedPax: Number.isInteger(bookedPax) && bookedPax >= 0 ? bookedPax : 0,
    manualOverride: privateProperties.manualOverride?.toLowerCase() === "true",
    ...(verdict ? { verdict } : {}),
    ...(Number.isFinite(confidence) && confidence > 0 ? { confidence } : {}),
    ...(privateProperties.lastEvaluatedAt ? { lastEvaluatedAt: privateProperties.lastEvaluatedAt } : {}),
    ...(factors.length > 0 ? { limitingFactors: factors } : {}),
    ...(privateProperties.reasoningSummary ? { reasoningSummary: privateProperties.reasoningSummary } : {}),
  };
}

async function listEvents(timeMin: Date, timeMax: Date): Promise<calendar_v3.Schema$Event[]> {
  if (!Number.isFinite(timeMin.getTime()) || !Number.isFinite(timeMax.getTime()) || timeMax <= timeMin) {
    throw new Error("Calendar query requires a valid, increasing time range");
  }
  const calendar = getCalendar();
  const events: calendar_v3.Schema$Event[] = [];
  let pageToken: string | undefined;
  do {
    const response = await calendar.events.list({
      calendarId: config.PARAGLIDING_CALENDAR_ID!,
      timeMin: timeMin.toISOString(),
      timeMax: timeMax.toISOString(),
      singleEvents: true,
      orderBy: "startTime",
      maxResults: 250,
      ...(pageToken ? { pageToken } : {}),
    });
    events.push(...(response.data.items ?? []));
    pageToken = response.data.nextPageToken ?? undefined;
  } while (pageToken);
  return events;
}

export async function getUpcomingSlots(timeMin: Date, timeMax: Date): Promise<SlotEvent[]> {
  const events = await listEvents(timeMin, timeMax);
  return events.flatMap((event) => {
    const slot = parseSlot(event);
    return slot && event.status !== "cancelled" ? [slot] : [];
  });
}

export async function getSlotById(slotId: string): Promise<SlotEvent | null> {
  if (!slotId.trim()) throw new Error("slotId cannot be empty");
  try {
    const response = await getCalendar().events.get({
      calendarId: config.PARAGLIDING_CALENDAR_ID!,
      eventId: slotId,
    });
    return parseSlot(response.data);
  } catch (error) {
    if (httpStatus(error) === 404) return null;
    throw error;
  }
}

function stripStatusPrefix(summary: string): string {
  return summary.replace(/^\[(?:OPEN|STANDBY|LOCKED|CONFIRMED|WX CANCEL|CANCELLED)\]\s*/i, "");
}

export async function updateSlotState(
  slotId: string,
  status: SlotStatus,
  evaluation: {
    verdict: string;
    confidence: number;
    evaluatedAt: Date;
    limitingFactors?: string[];
    reasoning?: string;
  },
  expectedEtag?: string,
): Promise<void> {
  const calendar = getCalendar();
  const { data: existing } = await calendar.events.get({
    calendarId: config.PARAGLIDING_CALENDAR_ID!,
    eventId: slotId,
  });
  if (expectedEtag && existing.etag !== expectedEtag) {
    throw new CalendarConflictError("Calendar slot changed; refresh and retry");
  }
  if (!existing.etag) throw new Error("Calendar did not provide an event ETag; update cannot be made safely");

  const privateProperties = existing.extendedProperties?.private ?? {};
  try {
    await calendar.events.patch(
      {
        calendarId: config.PARAGLIDING_CALENDAR_ID!,
        eventId: slotId,
        requestBody: {
          summary: `${PREFIX_STATUS[status]} ${stripStatusPrefix(existing.summary ?? "Paragliding booking slot")}`,
          colorId: STATUS_COLOR[status],
          description: existing.description ?? "",
          extendedProperties: {
            ...existing.extendedProperties,
            private: {
              ...privateProperties,
              status,
              deepseekVerdict: evaluation.verdict,
              confidence: String(evaluation.confidence),
              lastEvaluatedAt: evaluation.evaluatedAt.toISOString(),
              limitingFactors: (evaluation.limitingFactors ?? []).join("; "),
              reasoningSummary: evaluation.reasoning ?? "",
            },
          },
        },
      },
      { headers: { "If-Match": existing.etag } },
    );
  } catch (error) {
    const statusCode = httpStatus(error);
    if (statusCode === 412) throw new CalendarConflictError("Calendar slot changed during update; retry evaluation");
    throw error;
  }
}

export async function bookSlot(
  slotId: string,
  passenger: { name: string; weight_kg: number; contact: string; emergency_contact: string },
): Promise<{ bookedPax: number; maxPax: number; status: SlotStatus }> {
  const calendar = getCalendar();
  const response = await calendar.events.get({
    calendarId: config.PARAGLIDING_CALENDAR_ID!,
    eventId: slotId,
  });
  const event = response.data;
  if (!event.etag) throw new Error("Calendar did not provide an event ETag; booking cannot be made safely");
  const slot = parseSlot(event);
  if (!slot) throw new Error("Calendar event is not a valid booking slot");
  if (slot.status !== "OPEN") throw new CalendarConflictError("Slot is no longer open");
  if (slot.start <= new Date()) throw new CalendarConflictError("Slot has already started");
  if (slot.bookedPax >= slot.maxPax) throw new CalendarConflictError("Slot has no remaining capacity");

  const newBookedPax = slot.bookedPax + 1;
  const nextStatus: SlotStatus = newBookedPax >= slot.maxPax ? "CONFIRMED" : "OPEN";
  const passengerEntry = [
    `Passenger ${newBookedPax}: ${passenger.name.replace(/[\r\n]+/g, " ")}`,
    `Weight: ${passenger.weight_kg} kg`,
    `Contact: ${passenger.contact.replace(/[\r\n]+/g, " ")}`,
    `Emergency contact: ${passenger.emergency_contact.replace(/[\r\n]+/g, " ")}`,
  ].join("\n");
  const description = `${event.description ?? ""}${event.description ? "\n\n" : ""}${passengerEntry}`;

  try {
    await calendar.events.patch(
      {
        calendarId: config.PARAGLIDING_CALENDAR_ID!,
        eventId: slotId,
        requestBody: {
          summary: `${PREFIX_STATUS[nextStatus]} ${stripStatusPrefix(event.summary ?? "Paragliding booking slot")}`,
          description,
          colorId: "10",
          extendedProperties: {
            ...event.extendedProperties,
            private: {
              ...event.extendedProperties?.private,
              status: nextStatus,
              maxPax: String(slot.maxPax),
              bookedPax: String(newBookedPax),
            },
          },
        },
      },
      { headers: { "If-Match": event.etag } },
    );
  } catch (error) {
    const statusCode = httpStatus(error);
    if (statusCode === 412 || statusCode === 409) {
      throw new CalendarConflictError("Slot was booked or changed by another request");
    }
    throw error;
  }
  return { bookedPax: newBookedPax, maxPax: slot.maxPax, status: nextStatus };
}

export async function syncCalendarSlots(timeMin: Date, timeMax: Date): Promise<SlotEvent[]> {
  return getUpcomingSlots(timeMin, timeMax);
}

export async function cancelSlot(slotId: string, reason: string): Promise<SlotEvent> {
  return applySlotOverride(slotId, { status: "CANCELLED", manualOverride: true, reason });
}

/** Hard-deletes an empty slot. Refuses when seats are already sold. */
export async function deleteSlot(slotId: string): Promise<void> {
  const calendar = getCalendar();
  const event = await calendar.events.get({
    calendarId: config.PARAGLIDING_CALENDAR_ID!,
    eventId: slotId,
  });
  const slot = parseSlot(event.data);
  if (!slot) throw new Error("Calendar event is not a booking slot");
  if (slot.bookedPax > 0) {
    throw new Error("Cannot delete a slot with confirmed bookings; cancel it instead");
  }
  try {
    await calendar.events.delete({
      calendarId: config.PARAGLIDING_CALENDAR_ID!,
      eventId: slotId,
    });
  } catch (error) {
    if (httpStatus(error) === 404) return;
    throw error;
  }
}

export interface ConfigEventSnapshot {
  description: string;
  etag?: string;
  exists: boolean;
}

/** Reads the reserved config event, tolerating its absence on a fresh calendar. */
export async function readConfigEvent(eventId: string): Promise<ConfigEventSnapshot> {
  const calendar = getCalendar();
  try {
    const response = await calendar.events.get({
      calendarId: config.PARAGLIDING_CALENDAR_ID!,
      eventId,
    });
    return {
      description: response.data.description ?? "",
      ...(response.data.etag ? { etag: response.data.etag } : {}),
      exists: true,
    };
  } catch (error) {
    if (httpStatus(error) === 404) return { description: "", exists: false };
    throw error;
  }
}

/**
 * Writes the config event, creating it on first use. `expectedEtag` turns the write into a
 * compare-and-swap so two operators saving at once cannot silently drop each other's edits.
 */
export async function writeConfigEvent(
  eventId: string,
  payload: string,
  expectedEtag?: string,
): Promise<{ etag?: string }> {
  const calendar = getCalendar();
  const requestBody = {
    id: eventId,
    summary: CONFIG_EVENT_SUMMARY,
    description: payload,
    transparency: "transparent",
    start: { dateTime: CONFIG_EVENT_START, timeZone: "UTC" },
    end: { dateTime: CONFIG_EVENT_END, timeZone: "UTC" },
    extendedProperties: { private: { kind: "SITE_CONFIG", status: "LOCKED" } },
  };

  let etag = expectedEtag;
  if (!etag) {
    const current = await readConfigEvent(eventId);
    if (!current.exists) {
      const inserted = await calendar.events.insert({
        calendarId: config.PARAGLIDING_CALENDAR_ID!,
        requestBody,
      });
      return inserted.data.etag ? { etag: inserted.data.etag } : {};
    }
    if (!current.etag) throw new Error("Config event did not return an ETag");
    etag = current.etag;
  }

  try {
    const updated = await calendar.events.update(
      { calendarId: config.PARAGLIDING_CALENDAR_ID!, eventId, requestBody },
      { headers: { "If-Match": etag } },
    );
    return updated.data.etag ? { etag: updated.data.etag } : {};
  } catch (error) {
    const statusCode = httpStatus(error);
    if (statusCode === 412 || statusCode === 409) {
      throw new CalendarConflictError("Configuration changed since you loaded it");
    }
    throw error;
  }
}


export interface CreateSlotInput {
  start: Date;
  end: Date;
  maxPax: number;
  label?: string;
  description?: string;
  status?: SlotStatus;
}

/**
 * Creates a slot that is not yet sellable. Templates and manual slots both start LOCKED so the
 * weather worker — not the admin form — decides when the calendar opens for bookings.
 */
export async function createSlot(input: CreateSlotInput): Promise<SlotEvent> {
  if (input.end.getTime() <= input.start.getTime()) {
    throw new Error("Slot end must be after its start");
  }
  const calendar = getCalendar();
  const status = input.status ?? "LOCKED";
  const response = await calendar.events.insert({
    calendarId: config.PARAGLIDING_CALENDAR_ID!,
    requestBody: {
      summary: `${PREFIX_STATUS[status]} ${(input.label ?? "Paragliding booking slot").slice(0, 160)}`,
      description: input.description ?? "",
      start: { dateTime: input.start.toISOString(), timeZone: "UTC" },
      end: { dateTime: input.end.toISOString(), timeZone: "UTC" },
      colorId: STATUS_COLOR[status],
      extendedProperties: {
        private: {
          status,
          maxPax: String(input.maxPax),
          bookedPax: "0",
          manualOverride: "false",
        },
      },
    },
  });
  const slot = parseSlot(response.data);
  if (!slot) throw new Error("Google Calendar returned a slot without a usable start/end time");
  return slot;
}

export interface SlotOverrideInput {
  status?: SlotStatus;
  maxPax?: number;
  manualOverride?: boolean;
  reason?: string;
  /** ETag the operator last saw; when supplied the write is rejected if the slot moved on. */
  expectedEtag?: string;
}

export function sanitizeNote(value: string, maxLength: number): string {
  return value.replace(/[\r\n]+/g, " ").trim().slice(0, maxLength);
}

/**
 * Applies an operator decision to a slot. Manual overrides are recorded so the weather worker
 * stops re-opening (or re-cancelling) the slot, and every change leaves an audit trail in the
 * event description.
 */
export async function applySlotOverride(
  slotId: string,
  input: SlotOverrideInput,
): Promise<SlotEvent> {
  const calendar = getCalendar();
  const event = await calendar.events.get({
    calendarId: config.PARAGLIDING_CALENDAR_ID!,
    eventId: slotId,
  });
  const existing = event.data;
  if (!existing.etag) throw new Error("Calendar event did not return an ETag");
  if (input.expectedEtag && existing.etag !== input.expectedEtag) {
    throw new CalendarConflictError("Slot changed since you loaded it. Reload and try again.");
  }
  const slot = parseSlot(existing);
  if (!slot) throw new Error("Calendar event is not a booking slot");

  const nextStatus = input.status ?? slot.status;
  const nextMaxPax = input.maxPax ?? slot.maxPax;
  if (nextMaxPax < slot.bookedPax) {
    throw new Error(`Capacity cannot be below the ${slot.bookedPax} seats already booked`);
  }

  const privateProps: Record<string, string> = {
    ...(existing.extendedProperties?.private ?? {}),
    status: nextStatus,
    maxPax: String(nextMaxPax),
    bookedPax: String(slot.bookedPax),
    manualOverride: String(input.manualOverride ?? slot.manualOverride),
  };
  if (input.manualOverride) {
    privateProps.manualOverrideAt = new Date().toISOString();
    privateProps.manualOverrideReason = sanitizeNote(input.reason ?? "operator decision", 200);
  }
  if (input.manualOverride === false) {
    delete privateProps.manualOverrideAt;
    delete privateProps.manualOverrideReason;
  }

  const prefix =
    input.manualOverride && nextStatus === "CANCELLED"
      ? ADMIN_CANCEL_PREFIX
      : PREFIX_STATUS[nextStatus];
  const note = input.reason
    ? `\n\n[admin ${new Date().toISOString()}] ${sanitizeNote(input.reason, 500)}`
    : "";

  try {
    const response = await calendar.events.patch(
      {
        calendarId: config.PARAGLIDING_CALENDAR_ID!,
        eventId: slotId,
        requestBody: {
          summary: `${prefix} ${stripStatusPrefix(existing.summary ?? "Paragliding booking slot")}`,
          description: `${existing.description ?? ""}${note}`,
          colorId: STATUS_COLOR[nextStatus],
          extendedProperties: { ...existing.extendedProperties, private: privateProps },
        },
      },
      { headers: { "If-Match": existing.etag } },
    );
    const updated = parseSlot(response.data);
    if (!updated) throw new Error("Google Calendar returned an unusable slot after the update");
    return updated;
  } catch (error) {
    const statusCode = httpStatus(error);
    if (statusCode === 412 || statusCode === 409) {
      throw new CalendarConflictError("Slot changed since you loaded it. Reload and try again.");
    }
    throw error;
  }
}


