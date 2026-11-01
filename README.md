# Paragliding Booking Engine

TypeScript/Node service for evaluating upcoming calendar slots against Open-Meteo forecasts, using DeepSeek as a constrained advisory evaluator, and exposing a passenger booking API.

## Safety and operations

Automated forecast evaluations are decision support, not a substitute for a qualified pilot's on-site assessment or the operator's go/no-go authority. Deterministic site-envelope checks run before DeepSeek; the model cannot make an out-of-envelope slot flyable. Missing forecasts, unavailable services, or invalid model output never open a slot. The worker moves slots with failed evaluations to `STANDBY` for human review. DeepSeek is not active until `DEEPSEEK_API_KEY` is configured; there is no built-in key or external account access.

Slot state writes are optimistic: the worker and the booking API send the calendar ETag they read. A conflicting write is retried once against a freshly read ETag, and an evaluation that cannot be completed is always recorded as `STANDBY` so a slot is never left bookable on stale or missing data. If even the `STANDBY` write fails, the failure is logged with `slot_standby_write_failed` rather than thrown away.

Calendar events in the configured calendar are treated as booking slots. Event start/end times must include `dateTime`. The service preserves existing event descriptions and extended private properties. Set the private extended property `manualOverride=true` to keep the worker from changing a slot. State is written to `extendedProperties.private`.

Railway should run the `web` and `worker` Procfile process types as separate services using the same deployment and environment. The API process does not schedule jobs. Set `ADMIN_API_TOKEN` to a long random secret; the admin endpoint returns `503` if it is not configured.

## Configuration

Copy `.env.example` to `.env` for local development and set the site's actual coordinates and operating limits. Set a DeepSeek API key and a Google service account email/private key. Share the target Google Calendar with the service account as an editor. The private key may be supplied with escaped `\\n` newlines. Configure `ALERT_WEBHOOK_URL` to notify the operator when an evaluation cancels a slot; alert failures are logged and do not roll back the cancellation. Without calendar credentials, the booking page is served but real availability and bookings remain disabled.

`SITE_MIN_CLOUD_CEILING_M` is applied to an estimated cloud base above ground, derived from forecast temperature/dew point when available; missing cloud-base inputs prevent an automatic opening. Forecasts are requested independently for ECMWF, GFS, and ICON, and all available model results are considered by the deterministic gate. `SITE_MAX_PRECIPITATION_MM` gates forecast hourly precipitation (default `1`); lower it for stricter operations, and note that a model that omits precipitation data fails closed to `STANDBY`.

## Run

Node.js 22 or newer is required (`googleapis` and `openai` both declare `node >= 22`); `.nvmrc` pins 22 for local and host builds.

```sh
npm ci
npm run build
npm start
```

For development, use `npm run dev` and run the scheduler separately with `npm run dev:worker`. The worker evaluates the rolling 72-hour window hourly and current-local-day events every 15 minutes.

## Preview with sample data

`npm run preview` serves the same `public/` assets with a small in-memory demo backend on http://localhost:3100, so the booking flow can be reviewed without DeepSeek or Google Calendar credentials. It is a local-only tool: it never contacts the real calendar, the worker, or production data, and bookings reset when the process stops. Set `PREVIEW_PORT` to change the port and `PREVIEW_CONFLICT=1` to make one slot always answer `409` so the refresh-and-retry path can be inspected.

## Tests and checks

```sh
npm run typecheck
npm test
```

`npm test` runs the evaluator, slot-evaluation, and calendar parsing suites with the Node test runner. The suites cover the deterministic safety gate, fail-closed behaviour when DeepSeek is unconfigured, slot status decisions, ETag conflict retries, and calendar event parsing. GitHub Actions runs these same checks on every push to `main` and every pull request, plus a smoke test that starts the built server with no credentials and asserts `/api/slots/available` responds `503` rather than serving availability.

## API

- `GET /api/health` — process health.
- `GET /api/slots/available?from=<ISO>&to=<ISO>` — open events with remaining capacity.
- `POST /api/slots/book` — JSON body `{ "slotId": "...", "passenger": { "name": "...", "weight_kg": 75, "contact": "...", "emergency_contact": "..." } }`.
- `POST /api/admin/evaluate-now` — requires `Authorization: Bearer <ADMIN_API_TOKEN>` and accepts `{ "slotId": "..." }` or `{ "date": "<ISO date>" }`.

The customer booking UI is served at `/`; its date selector is populated from dates that have currently open, weather-approved calendar slots within the 72-hour forecast window. It submits passenger details to the booking API. The worker and API rely on Google Calendar event updates for shared state. Booking uses the event ETag for optimistic concurrency; clients should retry a `409` response only after refreshing available slots.
