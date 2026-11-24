import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { chatAboutEvScan, getGeminiApiKey, safeErrorMessage } from "@/server/gemini";

const chatSchema = z.object({
  question: z.string().trim().min(1, "Question cannot be empty"),
  analysis: z.record(z.unknown()),
  history: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        text: z.string(),
      }),
    )
    .max(20),
});

export const Route = createFileRoute("/api/scan-chat")({
  server: {
    handlers: {
      GET: async () => {
        return Response.json(
          {
            status: "ready",
            service: "EvSnap EV Diagnostic Chat API",
            method: "POST",
            configured: !!getGeminiApiKey(),
          },
          { status: 200 },
        );
      },
      POST: async ({ request }) => {
        try {
          if (!getGeminiApiKey()) {
            return Response.json(
              {
                error:
                  "Server configuration error: GEMINI_API_KEY is not set. Please set GEMINI_API_KEY in your environment variables.",
              },
              { status: 503 },
            );
          }

          const body = await request.json().catch(() => null);
          if (!body) {
            return Response.json({ error: "Invalid JSON body provided." }, { status: 400 });
          }

          const parsed = chatSchema.safeParse(body);
          if (!parsed.success) {
            return Response.json(
              {
                error: "Invalid request payload.",
                details: parsed.error.flatten().fieldErrors,
              },
              { status: 400 },
            );
          }

          const answer = await chatAboutEvScan(parsed.data);
          return Response.json({ answer }, { status: 200 });
        } catch (error) {
          return Response.json({ error: safeErrorMessage(error) }, { status: 500 });
        }
      },
    },
  },
});
