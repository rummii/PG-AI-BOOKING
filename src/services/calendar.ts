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
  return summary.replace(/^\[(?:OPEN|STANDBY|LOCKED|CONFIRMED|WX CANCEL)\]\s*/i, "");
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
          colorId:
            status === "OPEN" || status === "CONFIRMED"
              ? "10"
              : status === "STANDBY"
                ? "5"
                : status === "CANCELLED"
                  ? "11"
                  : "8",
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
