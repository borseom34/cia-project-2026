import { createFileRoute } from "@tanstack/react-router";
import { analyzeEvImage, getGeminiApiKey, safeErrorMessage } from "@/server/gemini";

export const Route = createFileRoute("/api/analyze")({
  server: {
    handlers: {
      GET: async () => {
        return Response.json(
          {
            status: "ready",
            service: "EvSnap EV Analysis API",
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

          const form = await request.formData();
          const image = form.get("image");
          if (!(image instanceof File) || !image.type.startsWith("image/")) {
            return Response.json({ error: "Please upload a valid image file." }, { status: 400 });
          }

          if (image.size > 10 * 1024 * 1024) {
            return Response.json(
              { error: "Image file is too large. Please choose an image smaller than 10 MB." },
              { status: 400 },
            );
          }

          const analysis = await analyzeEvImage(image);
          return Response.json({ analysis }, { status: 200 });
        } catch (error) {
          return Response.json({ error: safeErrorMessage(error) }, { status: 500 });
        }
      },
    },
  },
});
