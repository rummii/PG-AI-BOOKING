const slotList = document.querySelector("#slot-list");
const availabilityError = document.querySelector("#availability-error");
const dateFilter = document.querySelector("#date-filter");
const bookingDialog = document.querySelector("#booking-dialog");
const bookingForm = document.querySelector("#booking-form");
const bookingError = document.querySelector("#form-error");
const bookingSuccess = document.querySelector("#booking-success");
const dialogSlot = document.querySelector("#dialog-slot");
const siteLocation = document.querySelector("#site-location");
const policyNotice = document.querySelector("#policy-notice");
const policyNoticeHeadline = document.querySelector("#policy-notice-headline");
const policyNoticeDetail = document.querySelector("#policy-notice-detail");
const dateRail = document.querySelector("#date-rail");
let selectedSlot = null;
let requestNumber = 0;
let availableSlots = [];
let successTimer;
let railDate = "all";
let siteTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

function localDateKey(date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: siteTimeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function formatSlotDate(date) {
  return new Intl.DateTimeFormat(undefined, {
    timeZone: siteTimeZone,
    weekday: "long",
    month: "long",
    day: "numeric",
  }).format(date);
}

function formatSlotTime(date) {
  return new Intl.DateTimeFormat(undefined, {
    timeZone: siteTimeZone,
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function setLoading() {
  slotList.setAttribute("aria-busy", "true");
  slotList.innerHTML = '<div class="loading-state"><span class="spinner"></span><span>Checking the forecast and finding your flight…</span></div>';
}

function showAvailabilityError(message) {
  availabilityError.replaceChildren(document.createTextNode(message));
  const retry = document.createElement("button");
  retry.type = "button";
  retry.textContent = "Try again";
  retry.addEventListener("click", loadSlots);
  availabilityError.append(" ", retry);
  availabilityError.hidden = false;
}

function showEmpty(title, message) {
  slotList.setAttribute("aria-busy", "false");
  slotList.innerHTML = `<div class="empty-state"><span class="empty-icon" aria-hidden="true">⌁</span><strong>${title}</strong><p>${message}</p></div>`;
}

const DAY_STATE_LABELS = {
  open: "Open",
  marginal: "Marginal",
  full: "Fully booked",
  locked: "Weather review",
  blackout: "Closed",
  closed: "Closed",
  past: "Past",
};

function renderPolicyNotice(notice) {
  if (!notice || !notice.detail) {
    policyNotice.hidden = true;
    return;
  }
  policyNoticeHeadline.textContent = notice.headline || "Notice";
  policyNoticeDetail.textContent = notice.detail;
  policyNotice.dataset.tone = notice.tone || "info";
  policyNotice.hidden = false;
}

function syncRailSelection() {
  for (const chip of dateRail.querySelectorAll(".date-chip")) {
    const active = chip.dataset.date === railDate;
    chip.classList.toggle("is-active", active);
    chip.setAttribute("aria-pressed", active ? "true" : "false");
  }
}

function buildDateChip(label, detail, state, dateKey) {
  const chip = document.createElement("button");
  chip.type = "button";
  chip.className = "date-chip";
  chip.dataset.date = dateKey;
  if (state) chip.dataset.state = state;
  chip.setAttribute("aria-pressed", "false");

  const weekday = document.createElement("span");
  weekday.className = "date-chip-weekday";
  weekday.textContent = label;
  const day = document.createElement("span");
  day.className = "date-chip-day";
  day.textContent = detail;
  const status = document.createElement("span");
  status.className = "date-chip-state";
  status.textContent = state ? DAY_STATE_LABELS[state] || state : "";
  chip.append(weekday, day, status);
  return chip;
}

/**
 * The date rail mirrors the operator's policy: which days are open, which are closed, and which
 * ones the operator is pushing. It is additive — the plain date select still works without it.
 */
function renderDateRail(days) {
  if (!Array.isArray(days) || days.length === 0) {
    dateRail.hidden = true;
    dateRail.replaceChildren();
    return;
  }

  dateRail.replaceChildren();
  const allChip = buildDateChip("All", "dates", null, "all");
  allChip.querySelector(".date-chip-state").textContent = "Every open day";
  dateRail.append(allChip);

  for (const day of days) {
    const date = new Date(`${day.date}T12:00:00Z`);
    const weekday = new Intl.DateTimeFormat(undefined, {
      timeZone: siteTimeZone,
      weekday: "short",
    }).format(date);
    const detail = new Intl.DateTimeFormat(undefined, {
      timeZone: siteTimeZone,
      day: "numeric",
      month: "short",
    }).format(date);
    const chip = buildDateChip(weekday, detail, day.state, day.date);
    const bookable = Number.isInteger(day.bookable) ? day.bookable : 0;
    chip.querySelector(".date-chip-state").textContent =
      bookable > 0 ? `${bookable} ${bookable === 1 ? "time" : "times"}` : DAY_STATE_LABELS[day.state] || day.state;
    if (day.recommended) {
      chip.classList.add("is-recommended");
      chip.title = "Recommended by the operator";
    }
    if (day.focus) chip.classList.add("is-focus");
    chip.disabled = day.state === "past" || day.state === "closed" || day.state === "blackout";
    dateRail.append(chip);
  }

  if (railDate !== "all" && !days.some((day) => day.date === railDate)) railDate = "all";
  syncRailSelection();
  dateRail.hidden = false;
}

dateRail.addEventListener("click", (event) => {
  const chip = event.target.closest(".date-chip");
  if (!chip || chip.disabled) return;
  railDate = chip.dataset.date;
  if (railDate === "all") {
    dateFilter.value = "all";
  } else if (dateFilter.querySelector(`option[value="${railDate}"]`)) {
    dateFilter.value = railDate;
  }
  syncRailSelection();
  renderSlots(availableSlots);
});

function updateDateOptions(slots) {
  const previousDate = dateFilter.value;
  const dates = new Map();
  for (const slot of slots) {
    const start = new Date(slot.start);
    const key = localDateKey(start);
    const day = dates.get(key) || { date: start, count: 0 };
    day.count += 1;
    dates.set(key, day);
  }

  const signature = [...dates].map(([key, day]) => `${key}:${day.count}`).join("|");
  if (signature === dateFilter.dataset.signature) {
    dateFilter.value = dates.has(previousDate) ? previousDate : "all";
    return;
  }

  dateFilter.replaceChildren();
  const allOption = document.createElement("option");
  allOption.value = "all";
  allOption.textContent = dates.size ? "All available dates" : "No flyable dates";
  allOption.disabled = dates.size === 0;
  dateFilter.append(allOption);

  for (const [dateKey, day] of dates) {
    const option = document.createElement("option");
    option.value = dateKey;
    const label = new Intl.DateTimeFormat(undefined, {
      timeZone: siteTimeZone,
      weekday: "short",
      month: "short",
      day: "numeric",
    }).format(day.date);
    option.textContent = `${label} · ${day.count} ${day.count === 1 ? "flight" : "flights"}`;
    dateFilter.append(option);
  }
  dateFilter.value = dates.has(previousDate) ? previousDate : "all";
  dateFilter.dataset.signature = signature;
}

function renderSlots(slots) {
  availableSlots = slots;
  updateDateOptions(slots);
  const filter = railDate !== "all" ? railDate : dateFilter.value;
  const filtered = slots.filter((slot) =>
    filter === "all" || localDateKey(new Date(slot.start)) === filter
  );

  if (filtered.length === 0) {
    if (slots.length === 0) {
      showEmpty(
        "No flights on the horizon. Yet.",
        "There are no weather-approved flights right now. New times appear as forecasts are evaluated.",
      );
    } else {
      showEmpty(
        "Nothing left on that day.",
        "Those times have just been taken or closed. Choose another date to see what is still available.",
      );
    }
    return;
  }

  slotList.setAttribute("aria-busy", "false");
  slotList.innerHTML = filtered.map((slot, index) => {
    const start = new Date(slot.start);
    const end = new Date(slot.end);
    const remaining = Number.isInteger(slot.remainingCapacity) && slot.remainingCapacity > 0 ? slot.remainingCapacity : 0;
    const payload = JSON.stringify({
      id: slot.id,
      summary: slot.summary,
      start: slot.start,
      end: slot.end,
      remainingCapacity: remaining,
    });
    const safelyEncodedPayload = encodeURIComponent(payload);
    return `
      <article class="slot-row" style="animation-delay:${Math.min(index * 45, 240)}ms">
        <div class="slot-date"><strong>${formatSlotDate(start)}</strong>${remaining} ${remaining === 1 ? "seat" : "seats"} left</div>
        <div class="slot-time"><span class="slot-time-icon" aria-hidden="true">☼</span>${formatSlotTime(start)} <span aria-hidden="true">—</span> ${formatSlotTime(end)}</div>
        <div class="slot-action">
          <div class="slot-price">Tandem flight<small>Pilot-led · all levels</small></div>
          <button class="button-outline" type="button" data-slot="${safelyEncodedPayload}">Choose time<span class="sr-only"> on ${formatSlotDate(start)} at ${formatSlotTime(start)}</span> <span aria-hidden="true">↗</span></button>
        </div>
      </article>`;
  }).join("");
}

async function loadSlots() {
  const currentRequest = ++requestNumber;
  availabilityError.hidden = true;
  setLoading();
  const from = new Date();
  const to = new Date(from.getTime() + 72 * 60 * 60 * 1000);
  const params = new URLSearchParams({ from: from.toISOString(), to: to.toISOString() });

  try {
    const response = await fetch(`/api/slots/available?${params}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "We couldn't check availability just now.");
    if (currentRequest !== requestNumber) return;
    renderPolicyNotice(data.notice || null);
    renderDateRail(Array.isArray(data.days) ? data.days : []);
    renderSlots(Array.isArray(data.slots) ? data.slots : []);
  } catch (error) {
    if (currentRequest !== requestNumber) return;
    slotList.setAttribute("aria-busy", "false");
    slotList.innerHTML = "";
    availableSlots = [];
    dateRail.hidden = true;
    updateDateOptions([]);
    showAvailabilityError(error instanceof Error ? error.message : "Something went wrong while checking availability.");
  }
}

function openBooking(slot) {
  selectedSlot = slot;
  const start = new Date(slot.start);
  dialogSlot.textContent = `${slot.summary} · ${formatSlotDate(start)} at ${formatSlotTime(start)}`;
  bookingError.hidden = true;
  bookingForm.reset();
  bookingDialog.showModal();
  bookingDialog.querySelector('input[name="name"]').focus();
}

slotList.addEventListener("click", (event) => {
  const button = event.target.closest("[data-slot]");
  if (!button) return;
  try {
    openBooking(JSON.parse(decodeURIComponent(button.dataset.slot)));
  } catch {
    availabilityError.textContent = "We couldn't open that flight. Please refresh the list and try again.";
    availabilityError.hidden = false;
  }
});

dateFilter.addEventListener("change", () => {
  railDate = dateFilter.value;
  syncRailSelection();
  renderSlots(availableSlots);
});
document.querySelector(".dialog-close").addEventListener("click", () => bookingDialog.close());
bookingDialog.addEventListener("click", (event) => {
  if (event.target === bookingDialog) bookingDialog.close();
});
bookingDialog.addEventListener("close", () => {
  selectedSlot = null;
});
function showBookingSuccess() {
  window.clearTimeout(successTimer);
  bookingSuccess.hidden = false;
  successTimer = window.setTimeout(() => { bookingSuccess.hidden = true; }, 7000);
}
bookingSuccess.querySelector("button").addEventListener("click", () => {
  window.clearTimeout(successTimer);
  bookingSuccess.hidden = true;
});

bookingForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!selectedSlot) return;
  const submitButton = bookingForm.querySelector(".submit-button");
  const submitLabel = bookingForm.querySelector(".submit-label");
  const originalLabel = submitLabel.textContent;
  const formData = new FormData(bookingForm);
  const passenger = {
    name: String(formData.get("name") || "").trim(),
    weight_kg: Number(formData.get("weight_kg")),
    contact: String(formData.get("contact") || "").trim(),
    emergency_contact: String(formData.get("emergency_contact") || "").trim(),
  };

  submitButton.disabled = true;
  submitLabel.textContent = "Saving your seat…";
  bookingError.hidden = true;
  try {
    const response = await fetch("/api/slots/book", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ slotId: selectedSlot.id, passenger }),
    });
    const data = await response.json();
    if (!response.ok) {
      if (response.status === 409 || response.status === 404) {
        await loadSlots();
        throw new Error("That time was just taken or is no longer available. We refreshed the list—please choose another.");
      }
      if (response.status === 400) throw new Error("Please check your details and make sure your weight is between 20 and 250 kg.");
      throw new Error(data.error || "We couldn't complete your booking. Please try again.");
    }

    bookingDialog.close();
    showBookingSuccess();
    await loadSlots();
  } catch (error) {
    bookingError.textContent = error instanceof Error ? error.message : "Something went wrong. Please try again.";
    bookingError.hidden = false;
  } finally {
    submitButton.disabled = false;
    submitLabel.textContent = originalLabel;
  }
});

async function initializeBookingPage() {
  try {
    const response = await fetch("/api/site");
    if (response.ok) {
      const site = await response.json();
      if (site.name) siteLocation.textContent = site.name;
      if (site.timezone) {
        new Intl.DateTimeFormat(undefined, { timeZone: site.timezone });
        siteTimeZone = site.timezone;
      }
    }
  } catch {
    // The local browser timezone remains a usable fallback if site metadata is unavailable.
  }
  await loadSlots();
}

void initializeBookingPage();
