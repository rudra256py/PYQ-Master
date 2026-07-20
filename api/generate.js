export default async function handler(req, res) {

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST")   return res.status(405).json({ error: "Method not allowed" });

  const { prompt, lang } = req.body || {};
  if (!prompt || typeof prompt !== "string") {
    return res.status(400).json({ error: "Invalid request" });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "GEMINI_API_KEY not set in Vercel environment variables." });
  }

  // Try these models one by one until one works
  const MODELS = [
    "gemini-3.1-flash-lite",
    "gemini-2.5-flash",
    "gemini-pro",
  ];

  let lastError = "";

  for (const model of MODELS) {
    const URL = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

    try {
      const geminiRes = await fetch(URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.7,
            maxOutputTokens: 8000,
          },
        }),
      });

      const geminiData = await geminiRes.json();

      // If this model returned an error, try next model
      if (!geminiRes.ok) {
        lastError = `Model ${model} failed: ${geminiRes.status} — ${JSON.stringify(geminiData?.error?.message || "")}`;
        console.warn(lastError);
        continue;
      }

      // Extract text from Gemini response
      const raw = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text || "";

      if (!raw) {
        lastError = `Model ${model} returned empty response`;
        console.warn(lastError);
        continue;
      }

      // Clean markdown fences if any
      const cleaned = raw.replace(/```json\s*/gi, "").replace(/```\s*/gi, "").trim();

      // Extract JSON array
      const match = cleaned.match(/\[[\s\S]*\]/);
      if (!match) {
        lastError = `Model ${model} did not return JSON array`;
        console.warn(lastError);
        continue;
      }

      const questions = JSON.parse(match[0]);

      if (!Array.isArray(questions) || questions.length === 0) {
        lastError = `Model ${model} returned empty questions array`;
        console.warn(lastError);
        continue;
      }

      // Validate each question
      const valid = questions.filter(q =>
        q &&
        typeof q.q   === "string" && q.q.length > 3 &&
        Array.isArray(q.opts)     && q.opts.length >= 2 &&
        typeof q.ans === "number" && q.ans >= 0 && q.ans < q.opts.length
      );

      if (valid.length === 0) {
        lastError = `Model ${model} returned invalid question format`;
        console.warn(lastError);
        continue;
      }

      // SUCCESS — return questions
      console.log(`✅ Success with model: ${model}, questions: ${valid.length}`);
      return res.status(200).json({ questions: valid, model, lang });

    } catch (err) {
      lastError = `Model ${model} threw error: ${err.message}`;
      console.warn(lastError);
      continue;
    }
  }

  // All models failed
  console.error("All Gemini models failed. Last error:", lastError);
  return res.status(502).json({
    error: "AI service unavailable. Please try again in a moment.",
    detail: lastError,
  });
}
