// Operations console for the booking engine: weather outlook, slot control, booking policy.
// Vanilla ES module with no build step and no runtime dependencies, matching /app.js.

const $ = (selector) => document.querySelector(selector);

const els = {
  sessionStatus: $("#session-status"),
  signOut: $("#sign-out"),
  loginPanel: $("#login-panel"),
  loginForm: $("#login-form"),
  loginToken: $("#login-token"),
  loginError: $("#login-error"),
  workspace: $("#workspace"),
  refresh: $("#refresh"),
  globalAlert: $("#global-alert"),
  outlookMeta: $("#outlook-meta"),
  kpiGrid: $("#kpi-grid"),
  scoreChart: $("#score-chart"),
  scoreTable: $("#score-table"),
  ruleChart: $("#rule-chart"),
  windowList: $("#window-list"),
  dailyTable: $("#daily-table"),
  slotDays: $("#slot-days"),
  materialise: $("#materialise"),
  createSlotForm: $("#create-slot-form"),
  slotCounts: $("#slot-counts"),
  slotTable: $("#slot-table"),
  policyEtag: $("#policy-etag"),
  policyForm: $("#policy-form"),
  weekdayToggles: $("#weekday-toggles"),
  policyStatus: $("#policy-status"),
  addTemplate: $("#add-template"),
  templateEditor: $("#template-editor"),
  saveTemplates: $("#save-templates"),
  templateStatus: $("#template-status"),
  auditList: $("#audit-list"),
};

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const VERDICT_COLOURS = { FLYABLE: "#2f6b41", MARGINAL: "#c58b3a", NO_GO: "#b4462f" };

const state = {
  csrfHeader: "x-admin-csrf",
  etag: null,
  timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  slots: [],
  weather: null,
  overview: null,
  templates: [],
  activeTab: "outlook",
};

function setAlert(message, tone = "bad") {
  if (!message) {
    els.globalAlert.hidden = true;
    els.globalAlert.textContent = "";
    return;
  }
  els.globalAlert.textContent = message;
  els.globalAlert.dataset.tone = tone;
  els.globalAlert.hidden = false;
}

function setNote(element, message, tone) {
  element.textContent = message;
  if (tone) element.dataset.tone = tone;
  else delete element.dataset.tone;
}

async function api(path, options = {}) {
  const method = options.method ?? "GET";
  const headers = {};
  if (options.body !== undefined) headers["content-type"] = "application/json";
  if (method !== "GET") headers[state.csrfHeader] = "1";
  Object.assign(headers, options.headers ?? {});

  const response = await fetch(path, {
    method,
    headers,
    credentials: "same-origin",
    ...(options.body !== undefined ? { body: options.body } : {}),
  });
  if (response.status === 401) {
    showLogin();
    throw new Error("Your session expired. Sign in again.");
  }
  if (response.status === 204) return null;
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = typeof payload.error === "string" ? payload.error : "The request failed.";
    throw new Error(detail);
  }
  return payload;
}

function formatTime(iso) {
  return new Intl.DateTimeFormat(undefined, {
    timeZone: state.timeZone,
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(iso));
}

function formatDateKey(dateKey, options = {}) {
  return new Intl.DateTimeFormat(undefined, {
    timeZone: state.timeZone,
    weekday: options.weekday ?? "short",
    day: "numeric",
    month: "short",
    ...(options.year ? { year: "numeric" } : {}),
  }).format(new Date(`${dateKey}T12:00:00Z`));
}

function formatDateTime(iso) {
  return new Intl.DateTimeFormat(undefined, {
    timeZone: state.timeZone,
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(iso));
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function showLogin(message) {
  els.loginPanel.hidden = false;
  els.workspace.hidden = true;
  els.signOut.hidden = true;
  els.sessionStatus.textContent = message ?? "Signed out";
  els.sessionStatus.dataset.state = "anonymous";
  els.loginToken.focus();
}

function showWorkspace(method) {
  els.loginPanel.hidden = true;
  els.workspace.hidden = false;
  els.signOut.hidden = false;
  els.sessionStatus.textContent = method === "token" ? "Token session" : "Operator session";
  els.sessionStatus.dataset.state = "authenticated";
  els.loginError.hidden = true;
}

async function loadSession() {
  try {
    const session = await api("/api/admin/session");
    if (session.csrfHeader) state.csrfHeader = session.csrfHeader;
    if (!session.configured) {
      showLogin("Admin console disabled");
      els.loginError.textContent =
        "The control plane is switched off. Set ADMIN_API_TOKEN (and ADMIN_WEB_ENABLED) to enable it.";
      els.loginError.hidden = false;
      els.loginForm.querySelector("button").disabled = true;
      return;
    }
    if (session.authenticated) {
      showWorkspace(session.method);
      await loadAll();
      return;
    }
    showLogin();
  } catch (error) {
    showLogin("Cannot reach the server");
    els.loginError.textContent = error instanceof Error ? error.message : "Unknown error";
    els.loginError.hidden = false;
  }
}

els.loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  els.loginError.hidden = true;
  const button = els.loginForm.querySelector("button");
  button.disabled = true;
  try {
    const session = await api("/api/admin/session", {
      method: "POST",
      body: JSON.stringify({ token: els.loginToken.value }),
    });
    if (session.csrfHeader) state.csrfHeader = session.csrfHeader;
    els.loginToken.value = "";
    showWorkspace("session");
    await loadAll();
  } catch (error) {
    els.loginError.textContent = error instanceof Error ? error.message : "Sign-in failed";
    els.loginError.hidden = false;
  } finally {
    button.disabled = false;
  }
});

els.signOut.addEventListener("click", async () => {
  await api("/api/admin/session", { method: "DELETE" }).catch(() => undefined);
  showLogin();
});

function selectTab(name) {
  state.activeTab = name;
  for (const tab of document.querySelectorAll(".tab[data-tab]")) {
    const active = tab.dataset.tab === name;
    tab.classList.toggle("is-active", active);
    tab.setAttribute("aria-selected", active ? "true" : "false");
  }
  for (const panel of document.querySelectorAll("[role='tabpanel']")) {
    panel.hidden = panel.id !== `panel-${name}`;
  }
  if (name === "slots") void loadSlots();
  if (name === "policy") void loadPolicy();
}

for (const tab of document.querySelectorAll(".tab[data-tab]")) {
  tab.addEventListener("click", () => selectTab(tab.dataset.tab));
}

els.refresh.addEventListener("click", () => void loadAll());
els.slotDays.addEventListener("change", () => void loadSlots());

const escapeHtml = (value) =>
  String(value).replace(/[&<>"']/g, (character) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character],
  );

async function loadOverview() {
  try {
    const overview = await api("/api/admin/overview");
    state.overview = overview;
    state.etag = overview.etag ?? null;
    state.templates = overview.templates ?? [];
    renderOutlookMeta();
    renderAudit(overview.audit ?? []);
    els.policyEtag.textContent = state.etag ? `rev ${state.etag.slice(0, 10)}` : "not saved yet";
  } catch (error) {
    setAlert(error instanceof Error ? error.message : "Could not load the overview.");
  }
}

async function loadWeather() {
  els.scoreChart.innerHTML = '<p class="chart-empty">Loading the forecast…</p>';
  try {
    const data = await api(`/api/admin/weather?hours=48`);
    state.weather = data;
    renderKpis(data.analytics);
    renderScoreChart(data.series);
    renderRuleBars(data.analytics.ruleStats);
    renderWindows(data.series.windows);
    renderDaily(data.analytics.daily);
  } catch (error) {
    els.scoreChart.innerHTML = `<p class="chart-empty">${escapeHtml(
      error instanceof Error ? error.message : "Forecast unavailable.",
    )}</p>`;
  }
}

function renderOutlookMeta() {
  const overview = state.overview;
  els.outlookMeta.replaceChildren();
  if (overview?.counts) renderSlotCounts(overview.counts);
  if (!overview) return;
  const chips = [
    ["Window", `${overview.policy.windowDays} days · ends ${overview.policy.windowEndsOn}`],
    ["Lead time", `${overview.policy.minLeadHours} h`],
    ["Mode", overview.policy.mode],
    ["Today", overview.today],
  ];
  if (overview.policy.focus) {
    chips.push(["Focus", `${overview.policy.focus.label} (${overview.policy.focus.from} → ${overview.policy.focus.to})`]);
  }
  for (const [label, value] of chips) {
    els.outlookMeta.append(element("span", "chip", `${label}: ${value}`));
  }
}

function renderScoreChart(series) {
  const hours = Array.isArray(series?.hours) ? series.hours : [];
  els.scoreTable.replaceChildren();
  if (hours.length === 0) {
    els.scoreChart.innerHTML = '<p class="chart-empty">No forecast hours available for this window.</p>';
    return;
  }

  const width = 760;
  const height = 250;
  const padL = 36;
  const padR = 14;
  const padT = 16;
  const padB = 46;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;
  const stepX = hours.length > 1 ? plotW / (hours.length - 1) : 0;
  const px = (index) => padL + index * stepX;
  const py = (score) => padT + plotH - (Math.max(0, Math.min(100, score)) / 100) * plotH;

  const points = hours.map((hour, index) => `${px(index).toFixed(1)},${py(hour.score).toFixed(1)}`);
  const area = `M ${padL},${(padT + plotH).toFixed(1)} L ${points.join(" L ")} L ${(padL + plotW).toFixed(1)},${(padT + plotH).toFixed(1)} Z`;
  const bands = hours
    .map((hour, index) => {
      const barWidth = hours.length > 1 ? stepX : plotW;
      const colour = VERDICT_COLOURS[hour.verdict] ?? "#9aa39b";
      return `<rect x="${px(index).toFixed(1)}" y="${(padT + plotH + 8).toFixed(1)}" width="${Math.max(1, barWidth - 1).toFixed(1)}" height="6" rx="1.5" fill="${colour}" opacity="0.85"></rect>`;
    })
    .join("");

  let separators = "";
  let previousDate = null;
  hours.forEach((hour, index) => {
    if (hour.date === previousDate) return;
    previousDate = hour.date;
    const x = px(index).toFixed(1);
    separators += `<line x1="${x}" y1="${padT}" x2="${x}" y2="${(padT + plotH).toFixed(1)}" stroke="#e6e8dd" stroke-width="1"></line><text x="${Number(x) + 4}" y="${height - 8}" fill="#78817b" font-size="9">${escapeHtml(formatDateKey(hour.date))}</text>`;
  });

  const gridLines = [0, 50, 100]
    .map(
      (value) =>
        `<line x1="${padL}" y1="${py(value).toFixed(1)}" x2="${(padL + plotW).toFixed(1)}" y2="${py(value).toFixed(1)}" stroke="#eef0e6" stroke-width="1"></line><text x="4" y="${(py(value) + 3).toFixed(1)}" fill="#9aa39b" font-size="9">${value}</text>`,
    )
    .join("");

  const threshold = `<line x1="${padL}" y1="${py(60).toFixed(1)}" x2="${(padL + plotW).toFixed(1)}" y2="${py(60).toFixed(1)}" stroke="#ed765c" stroke-width="1" stroke-dasharray="5 4" opacity="0.8"></line>`;

  els.scoreChart.innerHTML = `
    <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Flyability score for the next ${hours.length} hours">
      <title>Flyability score by hour</title>
      <desc>Area chart of the deterministic site-envelope score, with a verdict band under each hour.</desc>
      <defs>
        <linearGradient id="scoreFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#ed765c" stop-opacity="0.28"></stop>
          <stop offset="100%" stop-color="#ed765c" stop-opacity="0.02"></stop>
        </linearGradient>
      </defs>
      ${gridLines}
      ${separators}
      ${threshold}
      <path d="${area}" fill="url(#scoreFill)"></path>
      <polyline points="${points.join(" ")}" fill="none" stroke="#2f463d" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"></polyline>
      ${bands}
    </svg>
    <div class="chart-legend">
      <span><i class="legend-swatch" style="background:#2f6b41"></i> Flyable</span>
      <span><i class="legend-swatch" style="background:#c58b3a"></i> Marginal</span>
      <span><i class="legend-swatch" style="background:#b4462f"></i> No-go</span>
      <span>Generated ${escapeHtml(formatDateTime(series.generatedAt))}</span>
    </div>`;

  renderScoreTable(hours);
}

function renderScoreTable(hours) {
  const table = element("table", "data-table");
  table.append(element("caption", "", "Hourly scores (same numbers as the chart)"));
  const head = element("thead");
  const headRow = element("tr");
  for (const label of ["Hour", "Score", "Agreement", "Verdict", "First limiting factor"]) {
    headRow.append(element("th", "", label));
  }
  head.append(headRow);
  const body = element("tbody");
  for (const hour of hours) {
    const row = element("tr");
    const verdictCell = element("td");
    const badge = element("span", "badge", hour.verdict);
    badge.dataset.verdict = hour.verdict;
    verdictCell.append(badge);
    row.append(
      element("td", "", `${formatDateKey(hour.date)} ${formatTime(hour.time)}`),
      element("td", "num", `${hour.score}`),
      element("td", "num", `${Math.round(hour.agreement * 100)}%`),
      verdictCell,
      element("td", "row-reason", hour.messages[0] ?? "—"),
    );
    body.append(row);
  }
  table.append(head, body);
  els.scoreTable.append(table);
}


function renderKpis(analytics) {
  els.kpiGrid.replaceChildren();
  if (!analytics) return;
  const total = analytics.hours || 0;
  const flyableShare = total === 0 ? 0 : Math.round((analytics.verdicts.FLYABLE / total) * 100);
  const tiles = [
    {
      label: "Average score",
      value: `${analytics.averageScore}`,
      note: "worst margin across all checks",
      tone: analytics.averageScore >= 60 ? "good" : analytics.averageScore >= 35 ? "warn" : "bad",
    },
    {
      label: "Flyable hours",
      value: `${analytics.verdicts.FLYABLE}`,
      note: `${flyableShare}% of ${total} forecast hours`,
      tone: flyableShare >= 40 ? "good" : flyableShare > 0 ? "warn" : "bad",
    },
    {
      label: "Model disagreement",
      value: `${analytics.disagreementHours}`,
      note: "hours where models split",
      tone: analytics.disagreementHours === 0 ? "good" : "warn",
    },
    {
      label: "NO_GO hours",
      value: `${analytics.verdicts.NO_GO}`,
      note: "hard envelope breach",
      tone: analytics.verdicts.NO_GO === 0 ? "good" : "bad",
    },
    {
      label: "Open / total slots",
      value: `${analytics.slots.open} / ${analytics.slots.total}`,
      note: `${analytics.slots.manualOverrides} manual overrides`,
      tone: "neutral",
    },
    {
      label: "Seats sold",
      value: `${analytics.slots.seatsSold} / ${analytics.slots.seatsOffered}`,
      note: `${Math.round(analytics.slots.utilization * 100)}% utilisation`,
      tone: "neutral",
    },
  ];
  for (const tile of tiles) {
    const card = element("div", "kpi");
    if (tile.tone !== "neutral") card.dataset.tone = tile.tone;
    card.append(
      element("span", "kpi-label", tile.label),
      element("span", "kpi-value", tile.value),
      element("span", "kpi-note", tile.note),
    );
    els.kpiGrid.append(card);
  }
}



function renderRuleBars(ruleStats) {
  els.ruleChart.replaceChildren();
  if (!Array.isArray(ruleStats) || ruleStats.length === 0) {
    els.ruleChart.append(element("p", "card-hint", "No rule failures in this window."));
    return;
  }
  const max = Math.max(...ruleStats.map((stat) => stat.hours), 1);
  for (const stat of ruleStats) {
    const row = element("div", "bar-row");
    const track = element("div", "bar-track");
    const fill = element("div", "bar-fill");
    fill.style.width = `${Math.round((stat.hours / max) * 100)}%`;
    track.append(fill);
    row.append(
      element("span", "", stat.label),
      track,
      element("span", "bar-value", `${stat.hours}h · ${Math.round(stat.share * 100)}%`),
    );
    els.ruleChart.append(row);
  }
}

function renderWindows(windows) {
  els.windowList.replaceChildren();
  if (!Array.isArray(windows) || windows.length === 0) {
    els.windowList.append(
      element("li", "empty", "No flyable window of two hours or more in this forecast."),
    );
    return;
  }
  for (const window of windows) {
    const item = element("li");
    item.append(
      element(
        "span",
        "",
        `${formatDateKey(window.date)} · ${formatTime(window.from)} – ${formatTime(window.to)} (${window.hours}h)`,
      ),
      element("span", "window-score", `score ${window.averageScore}`),
    );
    els.windowList.append(item);
  }
}

function renderDaily(daily) {
  els.dailyTable.replaceChildren();
  if (!Array.isArray(daily) || daily.length === 0) {
    els.dailyTable.append(element("p", "card-hint", "No daily data yet."));
    return;
  }
  const table = element("table", "data-table");
  const head = element("thead");
  const headRow = element("tr");
  for (const label of ["Day", "Hours", "Flyable", "Marginal", "No-go", "Best", "Worst", "Average"]) {
    headRow.append(element("th", "", label));
  }
  head.append(headRow);
  const body = element("tbody");
  for (const day of daily) {
    const row = element("tr");
    row.append(
      element("td", "", formatDateKey(day.date, { weekday: "long" })),
      element("td", "num", `${day.hours}`),
      element("td", "num", `${day.flyable}`),
      element("td", "num", `${day.marginal}`),
      element("td", "num", `${day.noGo}`),
      element("td", "num", `${day.bestScore}`),
      element("td", "num", `${day.worstScore}`),
      element("td", "num", `${day.averageScore}`),
    );
    body.append(row);
  }
  table.append(head, body);
  els.dailyTable.append(table);
}

function renderAudit(entries) {
  els.auditList.replaceChildren();
  if (!Array.isArray(entries) || entries.length === 0) {
    els.auditList.append(element("li", "empty", "No changes recorded yet."));
    return;
  }
  for (const entry of entries) {
    const item = element("li");
    item.append(
      element("time", "", formatDateTime(entry.at)),
      element("span", "audit-actor", entry.actor),
      element("span", "", `${entry.action} · ${entry.detail || entry.target}`),
    );
    els.auditList.append(item);
  }
}

async function loadAll() {
  setAlert(null);
  await Promise.allSettled([loadOverview(), loadWeather()]);
  if (state.activeTab === "slots") await loadSlots();
  if (state.activeTab === "policy") await loadPolicy();
}



function renderSlotCounts(counts) {
  els.slotCounts.replaceChildren();
  if (!counts) return;
  for (const [status, count] of Object.entries(counts)) {
    const chip = element("span", "chip", `${status.toLowerCase()}: ${count}`);
    if (status === "OPEN" && count > 0) chip.dataset.tone = "good";
    if (status === "STANDBY" && count > 0) chip.dataset.tone = "warn";
    if (status === "CANCELLED" && count > 0) chip.dataset.tone = "bad";
    els.slotCounts.append(chip);
  }
}

async function loadSlots() {
  try {
    const days = Number(els.slotDays.value) || 30;
    const list = await api(`/api/admin/slots?days=${days}`);
    state.slots = list.slots;
    renderSlotCounts(list.counts);
    renderSlotTable(list.slots);
  } catch (error) {
    setAlert(error instanceof Error ? error.message : "Could not load slots.");
  }
}

function slotActionButton(label, handler, options = {}) {
  const button = element("button", "", label);
  button.type = "button";
  if (options.danger) button.dataset.danger = "true";
  button.addEventListener("click", handler);
  return button;
}

function renderSlotTable(slots) {
  els.slotTable.replaceChildren();
  if (!Array.isArray(slots) || slots.length === 0) {
    els.slotTable.append(
      element("caption", "", "No slots in this horizon. Add one above or materialise a template."),
    );
    return;
  }

  const head = element("thead");
  const headRow = element("tr");
  for (const label of ["When", "Status", "Seats", "Verdict", "Override", "Policy", "Actions"]) {
    headRow.append(element("th", "", label));
  }
  head.append(headRow);
  const body = element("tbody");

  for (const slot of slots) {
    const row = element("tr");
    const when = element("td");
    when.append(
      element("strong", "", `${formatDateKey(slot.date)} ${slot.time}`),
      element("div", "row-muted", slot.summary.replace(/^\[[A-Z ]+\]\s*/, "")),
    );

    const statusBadge = element("span", "badge", slot.status);
    statusBadge.dataset.status = slot.status;
    const statusCell = element("td");
    statusCell.append(statusBadge);

    const verdictCell = element("td");
    if (slot.verdict) {
      const badge = element("span", "badge", slot.verdict);
      badge.dataset.verdict = slot.verdict;
      verdictCell.append(badge);
      if (typeof slot.confidence === "number") {
        verdictCell.append(element("span", "row-muted", ` ${Math.round(slot.confidence * 100)}%`));
      }
    } else {
      verdictCell.append(element("span", "row-muted", "not evaluated"));
    }

    const overrideCell = element("td");
    overrideCell.append(
      slot.manualOverride
        ? element("span", "slot-focus", "pinned")
        : element("span", "row-muted", "worker"),
    );

    const policyCell = element("td");
    if (slot.hiddenReason) {
      const badge = element("span", "badge", slot.hiddenReason);
      badge.dataset.hidden = "true";
      policyCell.append(badge);
    } else if (slot.recommended) {
      policyCell.append(element("span", "slot-focus", "promoted"));
    } else {
      policyCell.append(element("span", "row-muted", "visible"));
    }

    const actions = element("td");
    const actionRow = element("div", "row-actions");
    actionRow.append(...slotActions(slot));
    actions.append(actionRow);
    row.append(
      when,
      statusCell,
      element("td", "num", `${slot.bookedPax}/${slot.maxPax}`),
      verdictCell,
      overrideCell,
      policyCell,
      actions,
    );
    body.append(row);
  }

  els.slotTable.append(head, body);
}

function slotActions(slot) {
  const buttons = [];
  const patch = async (body, message) => {
    try {
      await api(`/api/admin/slots/${encodeURIComponent(slot.id)}`, {
        method: "PATCH",
        body: JSON.stringify(body),
        headers: slot.etag ? { "if-match": slot.etag } : {},
      });
      await loadSlots();
      setAlert(message, "good");
    } catch (error) {
      setAlert(error instanceof Error ? error.message : "Could not update the slot.");
    }
  };

  if (slot.status !== "OPEN" && slot.status !== "CANCELLED") {
    buttons.push(
      slotActionButton("Open", () =>
        patch({ status: "OPEN", manualOverride: true, reason: "Opened from admin console" }, "Slot opened and pinned."),
      ),
    );
  }
  if (slot.status === "OPEN") {
    buttons.push(
      slotActionButton("Lock", () =>
        patch({ status: "LOCKED", manualOverride: true, reason: "Locked from admin console" }, "Slot locked and pinned."),
      ),
    );
  }
  if (slot.manualOverride) {
    buttons.push(
      slotActionButton(
        "Release",
        () => patch({ manualOverride: false, reason: "Override released to the weather worker" }, "Slot released to the worker."),
        { title: "Let the weather worker manage this slot again" },
      ),
    );
  }
  buttons.push(
    slotActionButton("Evaluate", async () => {
      try {
        await api(`/api/admin/slots/${encodeURIComponent(slot.id)}/evaluate`, { method: "POST" });
        await loadSlots();
        setAlert("Evaluation finished.", "good");
      } catch (error) {
        setAlert(error instanceof Error ? error.message : "Evaluation failed.");
      }
    }),
  );
  if (slot.status !== "CANCELLED") {
    buttons.push(
      slotActionButton(
        "Cancel",
        async () => {
          const reason = window.prompt("Reason for cancelling this slot?", "Cancelled by operator");
          if (reason === null) return;
          if (reason.trim().length < 3) {
            setAlert("Please give a reason of at least three characters.");
            return;
          }
          try {
            await api(`/api/admin/slots/${encodeURIComponent(slot.id)}/cancel`, {
              method: "POST",
              body: JSON.stringify({ reason: reason.trim() }),
            });
            await loadSlots();
            setAlert("Slot cancelled.", "good");
          } catch (error) {
            setAlert(error instanceof Error ? error.message : "Could not cancel the slot.");
          }
        },
        { danger: true },
      ),
    );
  }
  buttons.push(
    slotActionButton(
      "Delete",
      async () => {
        if (!window.confirm("Delete this slot from the calendar? This cannot be undone.")) return;
        try {
          await api(`/api/admin/slots/${encodeURIComponent(slot.id)}`, { method: "DELETE" });
          await loadSlots();
          setAlert("Slot deleted.", "good");
        } catch (error) {
          setAlert(error instanceof Error ? error.message : "Could not delete the slot.");
        }
      },
      { danger: true },
    ),
  );
  return buttons;
}

els.createSlotForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(els.createSlotForm);
  const button = els.createSlotForm.querySelector("button[type='submit']");
  button.disabled = true;
  try {
    await api("/api/admin/slots", {
      method: "POST",
      body: JSON.stringify({
        date: String(form.get("date") ?? ""),
        time: String(form.get("time") ?? ""),
        durationMinutes: Number(form.get("durationMinutes")),
        maxPax: Number(form.get("maxPax")),
        label: String(form.get("label") ?? ""),
      }),
    });
    els.createSlotForm.reset();
    await loadSlots();
    setAlert("Slot created as LOCKED. Evaluate it or let the worker open it.", "good");
  } catch (error) {
    setAlert(error instanceof Error ? error.message : "Could not create the slot.");
  } finally {
    button.disabled = false;
  }
});

els.materialise.addEventListener("click", async () => {
  els.materialise.disabled = true;
  try {
    const result = await api("/api/admin/slots/materialise", { method: "POST" });
    await loadSlots();
    const errorNote = result.errors?.length ? ` ${result.errors.length} failed.` : "";
    setAlert(`Created ${result.created} of ${result.planned} planned slots.${errorNote}`, "good");
  } catch (error) {
    setAlert(error instanceof Error ? error.message : "Materialisation failed.");
  } finally {
    els.materialise.disabled = false;
  }
});


function renderWeekdayToggles(closedWeekdays) {
  els.weekdayToggles.replaceChildren();
  WEEKDAYS.forEach((name, index) => {
    const label = element("label", "chip-toggle");
    const input = document.createElement("input");
    input.type = "checkbox";
    input.value = String(index);
    input.checked = closedWeekdays.includes(index);
    label.append(input, document.createTextNode(name.slice(0, 3)));
    els.weekdayToggles.append(label);
  });
}

function readClosedWeekdays() {
  return [...els.weekdayToggles.querySelectorAll("input:checked")].map((input) => Number(input.value));
}

function fillPolicyForm(policy) {
  const form = els.policyForm.elements;
  form.bookingWindowDays.value = String(policy.bookingWindowDays);
  form.minLeadHours.value = String(policy.minLeadHours);
  form.defaultMaxPax.value = String(policy.defaultMaxPax);
  form.mode.value = policy.mode;
  form.notice.value = policy.notice ?? "";
  form.focusLabel.value = policy.focus?.label ?? "";
  form.focusFrom.value = policy.focus?.from ?? "";
  form.focusTo.value = policy.focus?.to ?? "";
  form.blackouts.value = (policy.blackouts ?? []).join("\n");
  renderWeekdayToggles(policy.closedWeekdays ?? []);
}

async function loadPolicy() {
  try {
    const data = await api("/api/admin/config");
    state.config = data.config;
    state.etag = data.etag;
    state.templates = data.config.templates;
    fillPolicyForm(data.config.policy);
    renderTemplates(state.templates);
    els.policyEtag.textContent = state.etag ? `rev ${state.etag.slice(0, 10)}` : "not saved yet";
    setNote(
      els.policyStatus,
      data.stored ? "Loaded from the stored configuration." : "Using defaults — nothing saved yet.",
      "good",
    );
  } catch (error) {
    setNote(els.policyStatus, error instanceof Error ? error.message : "Could not load the policy.", "bad");
  }
}

els.policyForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(els.policyForm);
  const focusLabel = String(form.get("focusLabel") ?? "").trim();
  const focusFrom = String(form.get("focusFrom") ?? "");
  const focusTo = String(form.get("focusTo") ?? "");
  const policy = {
    bookingWindowDays: Number(form.get("bookingWindowDays")),
    minLeadHours: Number(form.get("minLeadHours")),
    defaultMaxPax: Number(form.get("defaultMaxPax")),
    mode: String(form.get("mode")),
    notice: String(form.get("notice") ?? "").trim(),
    closedWeekdays: readClosedWeekdays(),
    blackouts: String(form.get("blackouts") ?? "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean),
    focus: focusLabel && focusFrom && focusTo ? { label: focusLabel, from: focusFrom, to: focusTo } : null,
  };

  const button = els.policyForm.querySelector("button[type='submit']");
  button.disabled = true;
  setNote(els.policyStatus, "Saving…");
  try {
    const data = await api("/api/admin/config", {
      method: "PATCH",
      body: JSON.stringify({ policy }),
      headers: state.etag ? { "if-match": state.etag } : {},
    });
    state.config = data.config;
    state.etag = data.etag;
    state.templates = data.config.templates;
    fillPolicyForm(data.config.policy);
    renderTemplates(data.config.templates);
    els.policyEtag.textContent = state.etag ? `rev ${state.etag.slice(0, 10)}` : "not saved yet";
    setNote(els.policyStatus, `Saved at ${formatDateTime(data.config.updatedAt)}`, "good");
    await loadOverview();
  } catch (error) {
    setNote(els.policyStatus, error instanceof Error ? error.message : "Save failed.", "bad");
  } finally {
    button.disabled = false;
  }
});


function labelledField(label, input) {
  const wrapper = element("label", "field");
  wrapper.append(element("span", "", label), input);
  return wrapper;
}

function templateInput(field, value, options = {}) {
  const input = document.createElement("input");
  input.type = options.type ?? "text";
  input.value = value === undefined || value === null ? "" : String(value);
  input.dataset.field = field;
  if (options.min !== undefined) input.min = String(options.min);
  if (options.max !== undefined) input.max = String(options.max);
  if (options.placeholder) input.placeholder = options.placeholder;
  return input;
}

function templateRow(template, index) {
  const row = element("div", "template-row");
  const head = element("div", "template-row-head");
  head.append(element("strong", "", `Template ${index + 1}`));

  const enabledLabel = element("label", "chip-toggle");
  const enabled = document.createElement("input");
  enabled.type = "checkbox";
  enabled.dataset.field = "enabled";
  enabled.checked = template.enabled !== false;
  enabledLabel.append(enabled, document.createTextNode("Enabled"));

  const remove = element("button", "button-ghost", "Remove");
  remove.type = "button";
  remove.addEventListener("click", () => {
    row.remove();
    if (els.templateEditor.querySelectorAll(".template-row").length === 0) {
      els.templateEditor.append(
        element("p", "template-empty", "No templates yet. Add one to have the worker create slots automatically."),
      );
    }
  });
  head.append(enabledLabel, remove);

  const grid = element("div", "field-grid");
  grid.append(
    labelledField("Id", templateInput("id", template.id, { placeholder: "weekday-mornings" })),
    labelledField("Label", templateInput("label", template.label, { placeholder: "Morning tandems" })),
    labelledField("Times (HH:MM, comma separated)", templateInput("times", (template.times ?? []).join(", "), { placeholder: "09:00, 11:00" })),
    labelledField("Duration (min)", templateInput("durationMinutes", template.durationMinutes ?? 120, { type: "number", min: 30, max: 480 })),
    labelledField("Seats", templateInput("maxPax", template.maxPax ?? 4, { type: "number", min: 1, max: 16 })),
  );

  const weekdayField = element("div", "field field-wide");
  weekdayField.append(element("span", "", "Weekdays"));
  const weekdayBoxes = element("div", "chip-toggles");
  WEEKDAYS.forEach((name, weekdayIndex) => {
    const label = element("label", "chip-toggle");
    const input = document.createElement("input");
    input.type = "checkbox";
    input.value = String(weekdayIndex);
    input.dataset.field = "weekday";
    input.checked = (template.weekdays ?? []).includes(weekdayIndex);
    label.append(input, document.createTextNode(name.slice(0, 3)));
    weekdayBoxes.append(label);
  });
  weekdayField.append(weekdayBoxes);

  row.append(head, grid, weekdayField);
  return row;
}

function renderTemplates(templates) {
  els.templateEditor.replaceChildren();
  if (!Array.isArray(templates) || templates.length === 0) {
    els.templateEditor.append(
      element("p", "template-empty", "No templates yet. Add one to have the worker create slots automatically."),
    );
    return;
  }
  templates.forEach((template, index) => els.templateEditor.append(templateRow(template, index)));
}

function collectTemplates() {
  return [...els.templateEditor.querySelectorAll(".template-row")].map((row) => ({
    id: row.querySelector("[data-field='id']").value.trim().toLowerCase(),
    label: row.querySelector("[data-field='label']").value.trim(),
    weekdays: [...row.querySelectorAll("[data-field='weekday']:checked")].map((input) => Number(input.value)),
    times: row
      .querySelector("[data-field='times']")
      .value.split(",")
      .map((time) => time.trim())
      .filter(Boolean),
    durationMinutes: Number(row.querySelector("[data-field='durationMinutes']").value),
    maxPax: Number(row.querySelector("[data-field='maxPax']").value),
    enabled: row.querySelector("[data-field='enabled']").checked,
  }));
}

els.addTemplate.addEventListener("click", () => {
  const templates = collectTemplates();
  templates.push({
    id: `template-${Math.random().toString(36).slice(2, 7)}`,
    label: "New template",
    weekdays: [1, 2, 3, 4, 5],
    times: ["09:00", "11:00"],
    durationMinutes: 120,
    maxPax: 4,
    enabled: false,
  });
  renderTemplates(templates);
});

els.saveTemplates.addEventListener("click", async () => {
  els.saveTemplates.disabled = true;
  setNote(els.templateStatus, "Saving…");
  try {
    const data = await api("/api/admin/config", {
      method: "PATCH",
      body: JSON.stringify({ templates: collectTemplates() }),
      headers: state.etag ? { "if-match": state.etag } : {},
    });
    state.config = data.config;
    state.etag = data.etag;
    state.templates = data.config.templates;
    renderTemplates(data.config.templates);
    els.policyEtag.textContent = state.etag ? `rev ${state.etag.slice(0, 10)}` : "not saved yet";
    setNote(els.templateStatus, `Saved ${data.config.templates.length} templates`, "good");
    await loadOverview();
  } catch (error) {
    setNote(els.templateStatus, error instanceof Error ? error.message : "Save failed.", "bad");
  } finally {
    els.saveTemplates.disabled = false;
  }
});

void loadSession();

