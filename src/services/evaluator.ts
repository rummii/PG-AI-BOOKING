import OpenAI from "openai";
import { z } from "zod";
import { config, site } from "../config/site.js";
import type { EvaluationResult, WeatherData } from "../types.js";
import { evaluateEnvelope } from "./envelope.js";

const responseSchema = z.object({
  verdict: z.enum(["FLYABLE", "MARGINAL", "NO_GO"]),
  action: z.enum(["OPEN", "STANDBY", "CANCEL"]),
  confidence_score: z.number().min(0).max(1),
  limiting_factors: z.array(z.string().trim().min(1)).max(12),
  reasoning_summary: z.string().trim().min(1).max(1000),
});

function getClient(): OpenAI {
  if (!config.DEEPSEEK_API_KEY) throw new Error("DEEPSEEK_API_KEY is not configured");
  return new OpenAI({
    apiKey: config.DEEPSEEK_API_KEY,
    baseURL: "https://api.deepseek.com/v1",
    timeout: config.DEEPSEEK_TIMEOUT_MS,
    maxRetries: 1,
  });
}

export async function evaluateSlotConditions(
  slotTime: Date,
  weatherVectors: WeatherData[],
): Promise<EvaluationResult> {
  if (!Number.isFinite(slotTime.getTime())) throw new Error("Invalid slot time");
  if (weatherVectors.length === 0) throw new Error("Cannot evaluate a slot without weather vectors");

  const safetyFactors = evaluateEnvelope(weatherVectors);
  if (safetyFactors.unsafe.length > 0) {
    return {
      verdict: "NO_GO",
      action: "CANCEL",
      confidence_score: 1,
      limiting_factors: safetyFactors.unsafe,
      reasoning_summary: "The deterministic site safety envelope failed; the AI evaluator was not consulted.",
    };
  }
  if (safetyFactors.uncertain.length > 0) {
    return {
      verdict: "MARGINAL",
      action: "STANDBY",
      confidence_score: 0,
      limiting_factors: safetyFactors.uncertain,
      reasoning_summary: "Required location or forecast data is incomplete; the AI evaluator was not consulted.",
    };
  }

  const completion = await getClient().chat.completions.create({
    model: "deepseek-chat",
    temperature: 0.1,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content:
          "You are a conservative paragliding weather decision-support evaluator. You are advisory only; never replace the qualified pilot's on-site judgment. Deterministic site limits have already passed. Assess model disagreement, forecast uncertainty, turbulence indicators, precipitation, and cloud base conservatively. If uncertain, choose MARGINAL/STANDBY. Never invent observations or claim a flight is safe. Return only JSON with verdict (FLYABLE|MARGINAL|NO_GO), action (OPEN|STANDBY|CANCEL), confidence_score (0..1), limiting_factors (string[]), reasoning_summary (string).",
      },
      {
        role: "user",
        content: JSON.stringify({
          slotTime: slotTime.toISOString(),
          site: {
            name: site.name,
            altitudeMsl: site.altitudeMsl,
            idealHeading: site.idealHeading,
            headingTolerance: site.headingTolerance,
            windRangeKmh: [site.minWindKmh, site.maxWindKmh],
          },
          forecasts: weatherVectors,
        }),
      },
    ],
  });

  const content = completion.choices[0]?.message.content;
  if (!content) throw new Error("DeepSeek returned an empty evaluation");
  let decoded: unknown;
  try {
    decoded = JSON.parse(content);
  } catch (error) {
    throw new Error("DeepSeek returned invalid JSON", { cause: error });
  }
  const parsed = responseSchema.safeParse(decoded);
  if (!parsed.success) throw new Error(`DeepSeek response failed validation: ${parsed.error.message}`);

  const result = parsed.data;
  if (result.verdict === "FLYABLE" && result.action !== "OPEN") {
    return { ...result, verdict: "MARGINAL", action: "STANDBY" };
  }
  if (result.verdict === "NO_GO") return { ...result, action: "CANCEL" };
  if (result.verdict === "FLYABLE") return { ...result, action: "OPEN" };
  return { ...result, action: "STANDBY" };
}
