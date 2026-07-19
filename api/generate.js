// ================================================================
// api/generate.js  —  Vercel Serverless Function
// Yeh file BACKEND hai. Tumhari API key yahan safe rehti hai.
// Users ko yeh file kabhi nahi dikhti.
//
// ⚠️  SIRF EK JAGAH TUMHE KUCH KARNA HAI:
//     Vercel Dashboard mein Environment Variable set karni hai.
//     Neeche instructions hain.
// ================================================================

export default async function handler(req, res) {

  // -- CORS: Kaun kaun si websites is backend ko call kar sakti hain
  // Jab deploy ho jao toh apna Vercel URL yahan dalo
  const ALLOWED = [
    "https://pyqmaster.vercel.app",   // ← Vercel deploy ke baad yahan apna URL aayega
    "https://pyqmaster.in",           // ← Agar custom domain liya toh
    "http://localhost:5500",          // ← Local testing ke liye
    "http://127.0.0.1:5500",
    "http://localhost:3000",
  ];

  const origin = req.headers.origin || "";
  if (ALLOWED.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  } else {
    res.setHeader("Access-Control-Allow-Origin", "*");
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST")   return res.status(405).json({ error: "Method not allowed" });

  // -- Request body check
  const { prompt, lang } = req.body || {};
  if (!prompt || typeof prompt !== "string" || prompt.length < 20) {
    return res.status(400).json({ error: "Invalid request" });
  }

  // ================================================================
  // GEMINI API KEY
  // ================================================================
  // Yahan key DIRECTLY mat likho — Vercel mein Environment Variable
  // set karo. Process:
  //   1. vercel.com pe jao → apna project open karo
  //   2. "Settings" tab click karo
  //   3. "Environment Variables" click karo
  //   4. Name mein likho:  GEMINI_API_KEY
  //   5. Value mein apni key paste karo (AIzaSy...)
  //   6. Save karo → Redeploy karo
  //
  // process.env.GEMINI_API_KEY yahan se woh key automatically
  // uthata hai — tum kuch aur nahi karte.
  // ================================================================
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    console.error("GEMINI_API_KEY environment variable missing!");
    return res.status(500).json({
      error: "API key not configured. Please set GEMINI_API_KEY in Vercel settings."
    });
  }

  // -- Gemini model: gemini-2.0-flash (free tier mein available)
  const GEMINI_URL =
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;

  try {
    const geminiRes = await fetch(GEMINI_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              { text: prompt }
            ]
          }
        ],
        generationConfig: {
          temperature:     0.7,   // 0 = boring/safe, 1 = creative. 0.7 best for exam Qs
          maxOutputTokens: 8192,  // Max response size
          topP:            0.9,
        },
        safetySettings: [
          // Exam content ke liye safety filters thoda loose karte hain
          // warna historical violence wale questions block ho jaate hain
          { category: "HARM_CATEGORY_HARASSMENT",        threshold: "BLOCK_ONLY_HIGH" },
          { category: "HARM_CATEGORY_HATE_SPEECH",       threshold: "BLOCK_ONLY_HIGH" },
          { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_ONLY_HIGH" },
          { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_ONLY_HIGH" },
        ],
      }),
    });

    // -- Gemini ne error diya?
    if (!geminiRes.ok) {
      const errText = await geminiRes.text();
      console.error("Gemini API error:", geminiRes.status, errText);

      // Free tier limit hit?
      if (geminiRes.status === 429) {
        return res.status(429).json({
          error: "Too many requests. Free tier limit reached. Please wait 1 minute and try again."
        });
      }
      // Key galat hai?
      if (geminiRes.status === 400 || geminiRes.status === 403) {
        return res.status(403).json({
          error: "Invalid API key. Please check your Gemini API key in Vercel settings."
        });
      }

      return res.status(502).json({ error: "AI service error. Please try again." });
    }

    // -- Gemini ka response parse karo
    const geminiData = await geminiRes.json();

    // candidates[0].content.parts[0].text mein hota hai answer
    const raw = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text || "";

    if (!raw) {
      // Safety filter ne block kiya?
      const blocked = geminiData?.candidates?.[0]?.finishReason;
      if (blocked === "SAFETY") {
        return res.status(422).json({ error: "Content blocked by safety filter. Try again." });
      }
      throw new Error("Empty response from Gemini");
    }

    // -- JSON array nikalo response se (markdown fences hata ke)
    const cleaned = raw
      .replace(/```json\s*/gi, "")
      .replace(/```\s*/gi, "")
      .trim();

    // JSON array dhundho [ se ] tak
    const match = cleaned.match(/\[[\s\S]*\]/);
    if (!match) {
      console.error("No JSON array found. Raw:", raw.substring(0, 300));
      throw new Error("Gemini did not return valid JSON array");
    }

    let questions;
    try {
      questions = JSON.parse(match[0]);
    } catch (parseErr) {
      console.error("JSON parse failed:", parseErr.message);
      throw new Error("Could not parse questions from AI response");
    }

    if (!Array.isArray(questions) || questions.length === 0) {
      throw new Error("Empty questions array from Gemini");
    }

    // -- Har question ko validate karo (galat format wale hata do)
    const valid = questions.filter(q =>
      q &&
      typeof q.q    === "string" && q.q.length > 5 &&
      Array.isArray(q.opts)      && q.opts.length >= 2 &&
      typeof q.ans  === "number" &&
      q.ans >= 0                 && q.ans < q.opts.length
    );

    if (valid.length === 0) {
      throw new Error("No valid questions after validation");
    }

    // -- Frontend ko questions bhejo
    return res.status(200).json({
      questions: valid,
      lang,
      model: "gemini-2.0-flash",
      count: valid.length,
    });

  } catch (err) {
    console.error("Handler error:", err.message);
    return res.status(500).json({
      error: "Failed to generate questions. Please try again in a moment."
    });
  }
}
