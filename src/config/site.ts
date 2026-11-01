import "dotenv/config";
import { z } from "zod";

const numeric = (fallback: number) =>
  z.preprocess(
    (value) => (value === undefined || value === "" ? fallback : Number(value)),
    z.number().finite(),
  );

const environmentSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: numeric(3000).pipe(z.number().int().min(1).max(65535)),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  SITE_NAME: z.string().trim().min(1).default("Paragliding Site"),
  SITE_LAT: numeric(0).pipe(z.number().min(-90).max(90)),
  SITE_LON: numeric(0).pipe(z.number().min(-180).max(180)),
  SITE_ALTITUDE_MSL: numeric(0),
  SITE_TIMEZONE: z
    .string()
    .trim()
    .min(1)
    .default("UTC")
    .refine((timezone) => {
      try {
        new Intl.DateTimeFormat("en-US", { timeZone: timezone });
        return true;
      } catch {
        return false;
      }
    }, "must be a valid IANA timezone"),
  SITE_IDEAL_HEADING: numeric(340).pipe(z.number().min(0).max(359)),
  SITE_HEADING_TOLERANCE: numeric(35).pipe(z.number().min(0).max(180)),
  SITE_MIN_WIND_KMH: numeric(12).pipe(z.number().min(0)),
  SITE_MAX_WIND_KMH: numeric(26).pipe(z.number().min(0)),
  SITE_MAX_GUST_SPREAD_KMH: numeric(8).pipe(z.number().min(0)),
  SITE_MAX_RAIN_PROBABILITY: numeric(20).pipe(z.number().min(0).max(100)),
  SITE_MAX_PRECIPITATION_MM: numeric(1).pipe(z.number().min(0).max(50)),
  SITE_MIN_CLOUD_CEILING_M: numeric(300).pipe(z.number().min(0)),
  SITE_MAX_CAPE_J_KG: numeric(1000).pipe(z.number().min(0)),
  DEEPSEEK_API_KEY: z.string().optional(),
  GOOGLE_SERVICE_ACCOUNT_EMAIL: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.string().email().optional(),
  ),
  GOOGLE_PRIVATE_KEY: z.string().optional(),
  PARAGLIDING_CALENDAR_ID: z.string().optional(),
  SITE_CONFIG_FILE: z.string().optional(),
  ALERT_WEBHOOK_URL: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.string().url().optional(),
  ),
  ADMIN_API_TOKEN: z.string().optional(),
  ADMIN_SESSION_SECRET: z.string().min(16).optional(),
  ADMIN_CONFIG_EVENT_ID: z
    .string()
    .regex(/^[a-v0-9]{5,1024}$/, "must be a valid Google Calendar event id")
    .default("pgpolicy01"),
  ADMIN_BOOKING_WINDOW_DAYS: numeric(14).pipe(z.number().int().min(1).max(90)),
  ADMIN_SESSION_TTL_HOURS: numeric(8).pipe(z.number().int().min(1).max(72)),
  ADMIN_WEB_ENABLED: z
    .preprocess(
      (value) =>
        value === undefined || value === ""
          ? true
          : !["false", "0", "no", "off"].includes(String(value).toLowerCase()),
      z.boolean(),
    )
    .default(true),
  /**
   * Platforms that terminate TLS at an edge proxy (Railway, Fly, Render, any ingress) forward the
   * client protocol in `x-forwarded-proto` and the client IP in `x-forwarded-for`. Without this the
   * session cookie never gets its `Secure` flag and every visitor shares the proxy's IP, which turns
   * the login throttle into a global one. Only enable it behind a proxy you control.
   */
  TRUST_PROXY: z
    .preprocess(
      (value) =>
        value === undefined || value === ""
          ? false
          : ["true", "1", "yes", "on"].includes(String(value).toLowerCase()),
      z.boolean(),
    )
    .default(false),
  DEFAULT_MAX_PAX: numeric(1).pipe(z.number().int().min(1).max(100)),
  WEATHER_TIMEOUT_MS: numeric(10000).pipe(z.number().int().min(1000).max(120000)),
  DEEPSEEK_TIMEOUT_MS: numeric(15000).pipe(z.number().int().min(1000).max(120000)),
});

const parsedEnvironment = environmentSchema.safeParse(process.env);
if (!parsedEnvironment.success) {
  throw new Error(`Invalid environment configuration: ${parsedEnvironment.error.message}`);
}

export const config = parsedEnvironment.data;

export const site = {
  name: config.SITE_NAME,
  latitude: config.SITE_LAT,
  longitude: config.SITE_LON,
  altitudeMsl: config.SITE_ALTITUDE_MSL,
  timezone: config.SITE_TIMEZONE,
  idealHeading: config.SITE_IDEAL_HEADING,
  headingTolerance: config.SITE_HEADING_TOLERANCE,
  minWindKmh: config.SITE_MIN_WIND_KMH,
  maxWindKmh: config.SITE_MAX_WIND_KMH,
  maxGustSpreadKmh: config.SITE_MAX_GUST_SPREAD_KMH,
  maxRainProbability: config.SITE_MAX_RAIN_PROBABILITY,
  maxPrecipitationMm: config.SITE_MAX_PRECIPITATION_MM,
  minCloudCeilingM: config.SITE_MIN_CLOUD_CEILING_M,
  maxCapeJkg: config.SITE_MAX_CAPE_J_KG,
  coordinatesConfigured: Boolean(process.env.SITE_LAT?.trim() && process.env.SITE_LON?.trim()),
};

if (site.minWindKmh > site.maxWindKmh) {
  throw new Error("SITE_MIN_WIND_KMH cannot be greater than SITE_MAX_WIND_KMH");
}
