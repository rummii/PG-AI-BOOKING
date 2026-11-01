import { config, site } from "../config/site.js";
import type { WeatherData } from "../types.js";

const MODELS = ["ecmwf_ifs025", "gfs_seamless", "icon_seamless"] as const;
const HOURLY_FIELDS = [
  "wind_speed_10m",
  "wind_speed_80m",
  "wind_direction_10m",
  "wind_gusts_10m",
  "precipitation_probability",
  "precipitation",
  "cape",
  "cloud_cover",
  "temperature_2m",
  "dew_point_2m",
].join(",");

interface OpenMeteoResponse {
  hourly?: {
    time?: string[];
    wind_speed_10m?: Array<number | null>;
    wind_speed_80m?: Array<number | null>;
    wind_direction_10m?: Array<number | null>;
    wind_gusts_10m?: Array<number | null>;
    precipitation_probability?: Array<number | null>;
    precipitation?: Array<number | null>;
    cape?: Array<number | null>;
    cloud_cover?: Array<number | null>;
    temperature_2m?: Array<number | null>;
    dew_point_2m?: Array<number | null>;
  };
}

function valueAt(values: Array<number | null> | undefined, index: number): number | null {
  const value = values?.[index];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function estimateCloudCeilingM(temperature: number | null, dewPoint: number | null): number | null {
  if (temperature === null || dewPoint === null) return null;
  return Math.max(0, (temperature - dewPoint) * 125);
}

function buildForecastUrl(model: string, forecastDays: number): URL {
  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.search = new URLSearchParams({
    latitude: String(site.latitude),
    longitude: String(site.longitude),
    hourly: HOURLY_FIELDS,
    models: model,
    wind_speed_unit: "kmh",
    precipitation_unit: "mm",
    timezone: "UTC",
    forecast_days: String(forecastDays),
  }).toString();
  return url;
}

async function fetchModel(model: string, slotTime: Date): Promise<WeatherData> {
  const url = buildForecastUrl(model, 4);

  const response = await fetch(url, { signal: AbortSignal.timeout(config.WEATHER_TIMEOUT_MS) });
  if (!response.ok) {
    throw new Error(`Open-Meteo ${model} request failed with HTTP ${response.status}`);
  }

  const payload = (await response.json()) as OpenMeteoResponse;
  const hourly = payload.hourly;
  if (!hourly?.time?.length) throw new Error(`Open-Meteo ${model} returned no hourly forecast`);

  const targetHour = Math.floor(slotTime.getTime() / 3_600_000) * 3_600_000;
  const index = hourly.time.findIndex((time) => Date.parse(`${time}Z`) === targetHour);
  if (index < 0) throw new Error(`Open-Meteo ${model} has no forecast for ${slotTime.toISOString()}`);

  const temperature = valueAt(hourly.temperature_2m, index);
  const dewPoint = valueAt(hourly.dew_point_2m, index);
  return {
    model,
    time: hourly.time[index]!,
    windSpeed10mKmh: valueAt(hourly.wind_speed_10m, index),
    windSpeed80mKmh: valueAt(hourly.wind_speed_80m, index),
    windDirection10mDeg: valueAt(hourly.wind_direction_10m, index),
    windGusts10mKmh: valueAt(hourly.wind_gusts_10m, index),
    rainProbability: valueAt(hourly.precipitation_probability, index),
    precipitationMm: valueAt(hourly.precipitation, index),
    capeJkg: valueAt(hourly.cape, index),
    cloudCoverPercent: valueAt(hourly.cloud_cover, index),
    cloudCeilingM: estimateCloudCeilingM(temperature, dewPoint),
  };
}

export async function fetchWeatherVectors(slotTime: Date): Promise<WeatherData[]> {
  const results = await Promise.allSettled(MODELS.map((model) => fetchModel(model, slotTime)));
  const vectors = results.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
  const failures = results.flatMap((result, index) =>
    result.status === "rejected"
      ? [`${MODELS[index]}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`]
      : [],
  );

  if (vectors.length === 0) {
    throw new Error(`No weather model returned a usable forecast: ${failures.join("; ")}`);
  }
  if (failures.length > 0) {
    console.warn(JSON.stringify({ event: "weather_model_partial_failure", slotTime: slotTime.toISOString(), failures }));
  }
  return vectors;
}

export interface WeatherSeriesHour {
  time: Date;
  vectors: WeatherData[];
}

export interface WeatherSeries {
  hours: WeatherSeriesHour[];
  failures: string[];
}

interface ModelSeries {
  model: string;
  byHour: Map<number, WeatherData>;
}

async function fetchModelSeries(model: string, forecastDays: number): Promise<ModelSeries> {
  const response = await fetch(buildForecastUrl(model, forecastDays), {
    signal: AbortSignal.timeout(config.WEATHER_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Open-Meteo ${model} request failed with HTTP ${response.status}`);
  }
  const payload = (await response.json()) as OpenMeteoResponse;
  const hourly = payload.hourly;
  if (!hourly?.time?.length) throw new Error(`Open-Meteo ${model} returned no hourly forecast`);

  const byHour = new Map<number, WeatherData>();
  hourly.time.forEach((time, index) => {
    const epoch = Date.parse(`${time}Z`);
    if (!Number.isFinite(epoch)) return;
    const temperature = valueAt(hourly.temperature_2m, index);
    const dewPoint = valueAt(hourly.dew_point_2m, index);
    byHour.set(epoch, {
      model,
      time,
      windSpeed10mKmh: valueAt(hourly.wind_speed_10m, index),
      windSpeed80mKmh: valueAt(hourly.wind_speed_80m, index),
      windDirection10mDeg: valueAt(hourly.wind_direction_10m, index),
      windGusts10mKmh: valueAt(hourly.wind_gusts_10m, index),
      rainProbability: valueAt(hourly.precipitation_probability, index),
      precipitationMm: valueAt(hourly.precipitation, index),
      capeJkg: valueAt(hourly.cape, index),
      cloudCoverPercent: valueAt(hourly.cloud_cover, index),
      cloudCeilingM: estimateCloudCeilingM(temperature, dewPoint),
    });
  });
  return { model, byHour };
}

/**
 * One request per model for a whole horizon, assembled into hourly vector sets. The dashboard
 * needs a curve, and asking Open-Meteo for 48 individual hours would be 144 requests.
 */
export async function fetchWeatherSeries(start: Date, hours: number): Promise<WeatherSeries> {
  const count = Math.max(1, Math.min(Math.trunc(hours), 72));
  const forecastDays = Math.max(1, Math.min(4, Math.ceil(count / 24) + 1));
  const results = await Promise.allSettled(
    MODELS.map((model) => fetchModelSeries(model, forecastDays)),
  );
  const series = results.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
  const failures = results.flatMap((result, index) =>
    result.status === "rejected"
      ? [`${MODELS[index]}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`]
      : [],
  );
  if (series.length === 0) {
    throw new Error(`No weather model returned a usable forecast: ${failures.join("; ")}`);
  }

  const firstHour = Math.ceil(start.getTime() / 3_600_000) * 3_600_000;
  const built: WeatherSeriesHour[] = [];
  for (let index = 0; index < count; index += 1) {
    const epoch = firstHour + index * 3_600_000;
    const vectors = series
      .map((entry) => entry.byHour.get(epoch))
      .filter((vector): vector is WeatherData => vector !== undefined);
    if (vectors.length > 0) built.push({ time: new Date(epoch), vectors });
  }
  return { hours: built, failures };
}
