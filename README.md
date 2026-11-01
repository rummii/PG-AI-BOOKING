# Paragliding Booking Engine

TypeScript/Node service for evaluating upcoming calendar slots against Open-Meteo forecasts, using DeepSeek as a constrained advisory evaluator, and exposing a passenger booking API.

## Safety and operations

Automated forecast evaluations are decision support, not a substitute for a qualified pilot's on-site assessment or the operator's go/no-go authority. Deterministic site-envelope checks run before DeepSeek; the model cannot make an out-of-envelope slot flyable. Missing forecasts, unavailable services, or invalid model output never open a slot. The worker moves slots with failed evaluations to `STANDBY` for human review. DeepSeek is not active until `DEEPSEEK_API_KEY` is configured; there is no built-in key or external account access.

Slot state writes are optimistic: the worker and the booking API send the calendar ETag they read. A conflicting write is retried once against a freshly read ETag, and an evaluation that cannot be completed is always recorded as `STANDBY` so a slot is never left bookable on stale or missing data. If even the `STANDBY` write fails, the failure is logged with `slot_standby_write_failed` rather than thrown away.

Calendar events in the configured calendar are treated as booking slots. Event start/end times must include `dateTime`. The service preserves existing event descriptions and extended private properties. Set the private extended property `manualOverride=true` to keep the worker from changing a slot. State is written to `extendedProperties.private`.

## Deploy to Railway

The repo is already wired for it: `railway.json` builds with `npm run build` (Nixpacks' Node provider installs dependencies first, so nothing else belongs in there), starts `npm start`, and gates the rollout on `/api/health`; `.nvmrc` pins Node 22; `dist/` is built inside the image and `public/` is committed, so nothing needs a separate static-host step. The server binds `0.0.0.0:$PORT`, which Railway injects — never set `PORT` yourself.

1. **Create the project** — Railway → *New Project* → *Deploy from GitHub repo* → pick this repository. Every push to the deployed branch rebuilds.
2. **Web service** (`railway.json`) — needs `ADMIN_API_TOKEN` (long random string; the control plane returns `503` without it) plus the Google and site variables below.
3. **Worker service** — *New* → *GitHub Repo* on the same repository, then set *Settings → Config-as-code path* to `railway.worker.json`, which runs `npm run worker` with no health check and no public networking. Its config would otherwise reuse the web health check and never go healthy. Share the same variables (use a Railway *variable group* so they cannot drift).
4. **Variables** — at minimum:

| Variable | Why |
| --- | --- |
| `NODE_ENV` | `production` |
| `TRUST_PROXY` | `true` — Railway terminates TLS at its edge. Without it the session cookie is issued without `Secure` and, because every request looks like it came from the proxy, one attacker's five bad logins throttle the whole site. `test/proxy-trust.test.ts` pins both behaviours |
| `ADMIN_API_TOKEN` | enables `/admin` and the admin API; also the default session-signing key |
| `ADMIN_SESSION_SECRET` | optional, ≥16 chars, so rotating the token does not invalidate sessions |
| `GOOGLE_SERVICE_ACCOUNT_EMAIL`, `GOOGLE_PRIVATE_KEY`, `PARAGLIDING_CALENDAR_ID` | slots and bookings; without them the page serves but availability stays `503` |
| `DEEPSEEK_API_KEY` | optional; the deterministic envelope works without it |
| `SITE_*` | real coordinates, timezone, and operating limits — the defaults (`0, 0`, `12–26 km/h`) are placeholders |

`NODE_ENV` and `LOG_LEVEL` are trimmed and matched case-insensitively, because a hand-typed `Production` or a value pasted with a trailing space would otherwise stop the container at boot. A value that is genuinely wrong (say `staging`) still fails fast, but with a single-line message naming the key and the value it received rather than a multi-line validation dump that log viewers shred into fragments — `test/config-environment.test.ts` pins both behaviours.

5. **Config storage** — by default site configuration lives in the reserved calendar event, so nothing extra is required *if* the Google variables are set. For a deployment without Google credentials, attach a volume (e.g. mounted at `/data`) and set `SITE_CONFIG_FILE=/data/site-config.json`; a file store on an ephemeral filesystem silently loses every save on redeploy.
6. **Keep it at one replica.** The login throttle is in-process and the file store compares and swaps on a local file; `numReplicas: 1` is pinned in `railway.json` for that reason. Horizontal scaling needs a shared store first.
7. **Verify the deploy** — `ADMIN_API_TOKEN=... node preview/probe.mjs https://<service>.up.railway.app --calendar-off` runs the same assertions as locally against the live URL. With real credentials, drop the flag and the data checks run too.

## Configuration

Copy `.env.example` to `.env` for local development and set the site's actual coordinates and operating limits. Set a DeepSeek API key and a Google service account email/private key. Share the target Google Calendar with the service account as an editor. The private key may be supplied with escaped `\\n` newlines. Configure `ALERT_WEBHOOK_URL` to notify the operator when an evaluation cancels a slot; alert failures are logged and do not roll back the cancellation. Without calendar credentials, the booking page is served but real availability and bookings remain disabled.

`SITE_MIN_CLOUD_CEILING_M` is applied to an estimated cloud base above ground, derived from forecast temperature/dew point when available; missing cloud-base inputs prevent an automatic opening. Forecasts are requested independently for ECMWF, GFS, and ICON, and all available model results are considered by the deterministic gate. `SITE_MAX_PRECIPITATION_MM` gates forecast hourly precipitation (default `1`); lower it for stricter operations, and note that a model that omits precipitation data fails closed to `STANDBY`.

## Operator console

`/admin` is the control plane: a weather-outlook dashboard, slot management, and booking-policy steering. It is enabled when `ADMIN_API_TOKEN` is set; set `ADMIN_WEB_ENABLED=false` to hide it entirely.

- **Sign-in** — `POST /api/admin/session` exchanges the admin token for an `HttpOnly`, `SameSite=Strict` session cookie (`Secure` on HTTPS) carrying an expiry plus an HMAC of that expiry, signed with `ADMIN_SESSION_SECRET` (which falls back to `ADMIN_API_TOKEN`). Sessions last `ADMIN_SESSION_TTL_HOURS` (default 8) and there is a five-attempt-per-five-minutes login throttle. Scripts can keep using `Authorization: Bearer <ADMIN_API_TOKEN>`; cookie-authenticated writes must also send `x-admin-csrf: 1`.
- **Weather outlook** — every hour of the next 48 hours re-runs the deterministic envelope from `src/services/envelope.ts`; the same rule engine the evaluator gates on, so the dashboard can never disagree with a decision. The page shows the score curve, the verdict band, which rule each model tripped, recommended two-hour-plus windows, and the day-by-day summary. Charts are hand-rolled SVG with a `<details>` table fallback.
- **Slots** — create ad-hoc slots, open/lock/cancel/delete, release a slot back to the worker, or trigger an immediate evaluation. Every manual change sets `manualOverride=true` (optionally with a reason, appended to the event description) so the worker stops re-deciding it.
- **Policy** — booking window, minimum lead time, closed weekdays, blackout dates, a notice banner, a focus window, weekly templates that the worker materialises ahead of the window, and the last 40 audited changes.

Policy can only hide or highlight slots: it never opens a slot the weather envelope has closed. Read `GET /api/slots/available` gains `policy`, `notice`, `days[]` and a per-slot `recommended` flag; `public/app.js` falls back to the previous behaviour when those fields are absent.

### Where the configuration lives

Site configuration is stored in a reserved calendar event (`ADMIN_CONFIG_EVENT_ID`, default `pgpolicy01`, dated 1990 so it can never appear in an availability query) with the JSON payload in its description. It is read through a cached `SiteConfigStore` (60-second TTL) behind one interface with calendar, file, and in-memory adapters — set `SITE_CONFIG_FILE` to use a file on a persistent volume instead, or swap in SQLite later without touching the admin API. Saves are compare-and-swap: send the `If-Match` ETag from the last read (`409` when it is stale). A calendar with no stored config falls back to defaults derived from the environment.


## Run

Node.js 22 or newer is required (`googleapis` and `openai` both declare `node >= 22`); `.nvmrc` pins 22 for local and host builds.

```sh
npm ci
npm run build
npm start
```

For development, use `npm run dev` and run the scheduler separately with `npm run dev:worker`. The worker evaluates the rolling 72-hour window hourly and current-local-day events every 15 minutes.

## Preview with sample data

`npm run preview` serves the same `public/` assets with a small in-memory demo backend on http://localhost:3100, so the booking flow can be reviewed without DeepSeek or Google Calendar credentials. It is a local-only tool: it never contacts the real calendar, the worker, or production data, and bookings reset when the process stops. Set `PREVIEW_PORT` to change the port and `PREVIEW_CONFLICT=1` to make one slot always answer `409` so the refresh-and-retry path can be inspected. The operator console at `/admin` accepts the token from `PREVIEW_ADMIN_TOKEN` (default `demo`); its policy edits are kept in memory and slot mutations are read-only.

The demo backend mirrors the production contract: `policy` is the same summary the server returns, config writes need `x-admin-csrf: 1`, a stale `If-Match` is a real `409`, and a present-but-blank `If-Match` is rejected with `400` instead of being read as "no precondition" (the preview ETag is the stored config version, so it moves on every save).

With the preview running, `npm run probe` walks the whole backend in one pass — health, an anonymous `401`, the wrong-token `401`, sign-in, overview, weather, slots, config read → `PATCH` → stale-`If-Match` `409` → blank-`If-Match` `400` → missing-CSRF `403`, the public API picking up the new notice and window, then logout — and prints a `PASS`/`FAIL` line per expectation, exiting non-zero if any fail.

The same probe checks a real build: start it with the control plane on (`ADMIN_WEB_ENABLED=true`, `ADMIN_API_TOKEN=...`, optionally `SITE_CONFIG_FILE=.preview-site-config.json` to exercise the file store) and run `ADMIN_API_TOKEN=... node preview/probe.mjs http://localhost:3000 --calendar-off`. The `--calendar-off` flag swaps the data assertions for the no-credentials contract: availability must answer `503`, calendar-backed admin reads must fail cleanly instead of crashing, and template materialisation must plan nothing. Session, config, CSRF and ETag behaviour are still exercised, which is the part that works without Google credentials.

## Tests and checks

```sh
npm run typecheck
npm test
```

`npm test` runs every suite in `test/` with the Node test runner: the deterministic envelope and its evaluator wrapper, slot status decisions, ETag conflict retries, calendar parsing, booking policy, the forecast series and analytics aggregation, the site-config store, and the admin HTTP surface (session cookie, CSRF enforcement, stale `If-Match`, 401 handling). GitHub Actions runs these same checks on every push to `main` and every pull request, plus a smoke test that starts the built server with no credentials and asserts `/api/slots/available` responds `503` rather than serving availability.

## API

- `GET /api/health` — process health.
- `GET /api/slots/available?from=<ISO>&to=<ISO>` — open, policy-visible events with remaining capacity, plus `policy`, `notice`, `days[]` (the date rail) and a per-slot `recommended` flag.
- `POST /api/slots/book` — JSON body `{ "slotId": "...", "passenger": { "name": "...", "weight_kg": 75, "contact": "...", "emergency_contact": "..." } }`.
- `POST /api/admin/evaluate-now` — requires `Authorization: Bearer <ADMIN_API_TOKEN>` and accepts `{ "slotId": "..." }` or `{ "date": "<ISO date>" }`.
- Admin console — `GET|POST|DELETE /api/admin/session`, `GET /api/admin/overview`, `GET /api/admin/weather?hours=48`, `GET|POST /api/admin/slots`, `POST /api/admin/slots/materialise`, `PATCH /api/admin/slots/:id`, `POST /api/admin/slots/:id/cancel`, `POST /api/admin/slots/:id/evaluate`, `DELETE /api/admin/slots/:id`, and `GET|PATCH /api/admin/config` (writes take `If-Match`).

The customer booking UI is served at `/`; its date selector is populated from dates that have currently open, weather-approved calendar slots within the 72-hour forecast window. It submits passenger details to the booking API. The worker and API rely on Google Calendar event updates for shared state. Booking uses the event ETag for optimistic concurrency; clients should retry a `409` response only after refreshing available slots.
