import fs from "node:fs";
import path from "node:path";
import { GoogleGenAI } from "@google/genai";
import { sanitizeAndEnrichAnalysis } from "@/lib/ev-benchmarks";

function loadEnvFallback(): void {
  const envFiles = [".env.local", ".env", ".env.example"];
  for (const file of envFiles) {
    try {
      const fullPath = path.resolve(process.cwd(), file);
      if (fs.existsSync(fullPath)) {
        const content = fs.readFileSync(fullPath, "utf-8");
        for (const line of content.split(/\r?\n/)) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith("#")) continue;
          const match = trimmed.match(/^([A-Za-z0-9_]+)=(.*)$/);
          if (match) {
            const key = match[1]!;
            let val = match[2]!.trim();
            if (
              (val.startsWith('"') && val.endsWith('"')) ||
              (val.startsWith("'") && val.endsWith("'"))
            ) {
              val = val.slice(1, -1);
            }
            if (
              val &&
              !val.includes("your_gemini_api_key_here") &&
              !val.includes("your_api_key_here")
            ) {
              if (!process.env[key]) {
                process.env[key] = val;
              }
            }
          }
        }
      }
    } catch {
      // ignore
    }
  }
}

// Automatically load fallback on import
loadEnvFallback();

// Active, standard production models in Google AI Studio
const DEFAULT_MODELS = [
  "gemini-2.0-flash",
  "gemini-2.0-flash-lite",
  "gemini-2.5-flash",
  "gemini-1.5-flash",
  "gemini-1.5-pro",
];

export function getModelsList(): string[] {
  loadEnvFallback();
  const customModel = process.env["GEMINI_MODEL"];
  if (customModel) {
    return [customModel, ...DEFAULT_MODELS.filter((m) => m !== customModel)];
  }
  return DEFAULT_MODELS;
}

const ANALYSIS_PROMPT = `You are a world-class electric vehicle and lithium battery engineer. 
Analyze the supplied image carefully and classify it as an electric vehicle/e-scooter/e-bike, a battery pack/cell module, or electric car.

Return ONLY valid JSON matching this exact shape:
{
  "detected_type": "SCOOTER_OR_EV" | "BATTERY_PACK" | "ELECTRIC_CAR" | "ELECTRIC_BIKE",
  "title_name": "string (Exact brand & model if identifiable, or descriptive classification e.g. Electroride ZL Pro)",
  "confidence_rating": "High" | "Medium" | "Low",
  "overview_summary": "string (2-3 sentences of clear visual and technical summary)",
  "specs": {
    "voltage_capacity": "string (e.g. 60V / 24–30Ah (~1.4–1.8 kWh))",
    "chemistry_type": "string (e.g. Lithium-ion (NMC / LFP High Density))",
    "estimated_range": "string (e.g. 55–75 km per charge)",
    "peak_power_output": "string (e.g. 1.8 kW – 2.5 kW Peak BLDC Hub)",
    "charging_time": "string (e.g. 4.5–6.0 Hours (Standard 220V AC))",
    "lifecycle_span": "string (e.g. 800–1,200 Full Charge Cycles)"
  },
  "compatibility": ["string", "string", "string"],
  "key_features": ["string", "string", "string", "string"],
  "pros_and_cons": {
    "pros": ["string", "string", "string"],
    "cons": ["string", "string", "string"]
  },
  "maintenance_and_safety": ["string", "string", "string", "string"]
}

CRITICAL RULES:
1. NEVER output "Unknown", "N/A", "Undetermined", or empty strings in any specification or field.
2. If exact specifications are not visibly printed on the badge, provide realistic, highly educated engineering estimates and typical industry benchmarks based on the visible form factor, wheel size, chassis class, and scooter/battery category.
3. Keep specifications detailed with standard electrical & automotive units (V, Ah, kWh, km, kW, Hours, Cycles).
4. Provide practical, accurate safety guidelines and compatibility insights tailored to the visual evidence.`;

export function getGeminiApiKey(): string | undefined {
  loadEnvFallback();
  return process.env["GEMINI_API_KEY"] || process.env["GOOGLE_API_KEY"];
}

export function getGeminiClient(apiVersion?: string): GoogleGenAI {
  const apiKey = getGeminiApiKey();
  if (!apiKey) {
    throw new Error(
      "GEMINI_API_KEY is not configured on the server. Please set GEMINI_API_KEY or GOOGLE_API_KEY in your server environment variables.",
    );
  }
  return new GoogleGenAI({
    apiKey,
    ...(apiVersion ? { apiVersion } : {}),
  });
}

export function safeErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    const raw = error.message;
    const msg = raw.toLowerCase();

    if (
      msg.includes("api_key_invalid") ||
      msg.includes("api key not valid") ||
      msg.includes("unauthenticated")
    ) {
      return "Gemini API key is invalid or not authorized. Please check your server GEMINI_API_KEY.";
    }
    if (msg.includes("resource has been exhausted") || msg.includes("quota")) {
      return "Gemini API rate limit or quota exceeded. Please try again in a few moments.";
    }
    if (msg.includes("not found for api version") || msg.includes("404") || msg.includes("not_found")) {
      return "Selected Gemini model is not supported on this API key or API version. Ensure the 'Generative Language API' is enabled at https://aistudio.google.com/apikeys, or specify GEMINI_MODEL=gemini-2.0-flash in your .env file.";
    }

    // Try parsing raw json error message from Google if present
    try {
      const parsed = JSON.parse(raw);
      if (parsed?.error?.message) {
        return `Gemini API: ${parsed.error.message}`;
      }
    } catch {
      // not json, use raw
    }

    return `AI Diagnostic Error: ${raw}`;
  }
  return "The operation could not be completed. Please try again with a clear image or valid prompt.";
}

let cachedAvailableModels: string[] | null = null;

async function discoverAvailableModels(ai: GoogleGenAI): Promise<string[]> {
  if (cachedAvailableModels && cachedAvailableModels.length > 0) {
    return cachedAvailableModels;
  }

  try {
    const pager = await ai.models.list();
    const discovered: string[] = [];
    for await (const m of pager) {
      if (m.name) {
        const cleanName = m.name.replace(/^models\//, "");
        if (!m.supportedActions || m.supportedActions.includes("generateContent")) {
          discovered.push(cleanName);
        }
      }
    }

    if (discovered.length > 0) {
      console.log("[Gemini] Discovered models supported by your API key:", discovered);
      cachedAvailableModels = discovered;
      return discovered;
    }
  } catch (err) {
    console.warn("[Gemini] Automatic models.list check skipped:", err instanceof Error ? err.message : err);
  }

  return [];
}

export async function generateContentWithFallback(
  ai: GoogleGenAI,
  contents: Parameters<GoogleGenAI["models"]["generateContent"]>[0]["contents"],
  config?: Parameters<GoogleGenAI["models"]["generateContent"]>[0]["config"],
): Promise<string> {
  const userModels = getModelsList();
  const discovered = await discoverAvailableModels(ai);

  // Build candidate order: user override first, then preferred flash models that exist, then remainder
  let candidateModels: string[];
  if (discovered.length > 0) {
    const custom = process.env["GEMINI_MODEL"];
    const prioritized = [
      ...(custom ? [custom] : []),
      ...["gemini-2.0-flash", "gemini-2.0-flash-lite", "gemini-2.5-flash", "gemini-1.5-flash"].filter((m) =>
        discovered.includes(m),
      ),
      ...discovered.filter((m) => m.includes("flash")),
      ...discovered,
    ];
    candidateModels = Array.from(new Set(prioritized));
  } else {
    candidateModels = userModels;
  }

  let lastError: unknown;

  for (const model of candidateModels) {
    try {
      console.log(`[Gemini] Attempting generation with model: "${model}"`);
      const response = await ai.models.generateContent({
        model,
        contents,
        ...(config ? { config } : {}),
      });
      if (response.text) {
        console.log(`[Gemini] Generation succeeded with model: "${model}"`);
        return response.text;
      }
    } catch (err) {
      console.warn(`[Gemini] Model "${model}" failed:`, err instanceof Error ? err.message : err);
      lastError = err;
      continue;
    }
  }

  throw lastError || new Error("Failed to generate content with available Gemini models.");
}

export async function analyzeEvImage(image: File) {
  const ai = getGeminiClient();
  const bytes = Buffer.from(await image.arrayBuffer()).toString("base64");

  const text = await generateContentWithFallback(
    ai,
    [
      {
        role: "user",
        parts: [{ inlineData: { data: bytes, mimeType: image.type } }, { text: ANALYSIS_PROMPT }],
      },
    ],
    { responseMimeType: "application/json" },
  );

  let parsedRaw: Record<string, unknown> = {};
  try {
    parsedRaw = JSON.parse(text);
  } catch {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      parsedRaw = JSON.parse(jsonMatch[0]);
    }
  }

  return sanitizeAndEnrichAnalysis(parsedRaw);
}

export async function chatAboutEvScan({
  question,
  analysis,
  history,
}: {
  question: string;
  analysis: Record<string, unknown>;
  history: Array<{ role: "user" | "assistant"; text: string }>;
}): Promise<string> {
  const ai = getGeminiClient();

  const promptText = `You are EvSnap, an EV and battery specialist. Answer using the scan data below. Be concise, practical, safety-conscious, and explicitly say when a fact cannot be confirmed from the scan.

SCAN DATA:
${JSON.stringify(analysis, null, 2)}

RECENT CHAT:
${history.map((m) => `${m.role}: ${m.text}`).join("\n")}

QUESTION: ${question}`;

  return await generateContentWithFallback(ai, [
    {
      role: "user",
      parts: [{ text: promptText }],
    },
  ]);
}
