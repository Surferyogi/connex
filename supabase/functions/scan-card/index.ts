// ============================================================================
// Connex — scan-card Edge Function (Deno)
// Receives a base64 card image, asks Claude to extract ONLY what is printed,
// returns strict JSON. The Anthropic API key NEVER leaves the server.
//
// Deploy WITH JWT verification (default) so only signed-in users can call it:
//   supabase functions deploy scan-card
//
// Set the secret first (never commit it):
//   supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
//   (optional) supabase secrets set CLAUDE_MODEL=claude-sonnet-4-6
// ============================================================================

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const MODEL = Deno.env.get("CLAUDE_MODEL") ?? "claude-sonnet-4-6";
const ANTHROPIC_VERSION = "2023-06-01";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });

const SYSTEM = `You extract contact details from a photograph of a single business card.

HARD RULES:
- Extract ONLY text that is actually printed on the card. Never guess, infer, complete, translate, or invent anything.
- If a field is not clearly present, use null. For list fields use an empty array.
- Preserve the original script and the number/email exactly as printed (do not reformat phone numbers).
- If the card shows a name in both a local script and a romanized/phonetic form, put the most prominent one in "full_name" and the other in "name_phonetic".
- Classify each phone's "label" ONLY from printed labels or icons (e.g. Mobile/携帯, Tel, Fax, Direct). If unclear, use "other". Never assume which number is a mobile.

Return ONLY one minified JSON object, with no prose, no explanation, and no markdown code fences. Use exactly these keys:
{"full_name":string|null,"name_phonetic":string|null,"job_title":string|null,"department":string|null,"company":string|null,"emails":string[],"phones":[{"label":string,"number":string}],"website":string|null,"address":string|null,"notes":string|null,"languages_detected":string[]}`;

function extractJson(text: string): Record<string, unknown> | null {
  if (!text) return null;
  // Be tolerant in case the model wraps output despite instructions.
  let t = text.trim();
  t = t.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return null;
  try {
    return JSON.parse(t.slice(start, end + 1));
  } catch {
    return null;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (!ANTHROPIC_API_KEY) {
    return json({ error: "Server is missing ANTHROPIC_API_KEY secret." }, 500);
  }

  let payload: { image_base64?: string; media_type?: string };
  try {
    payload = await req.json();
  } catch {
    return json({ error: "Body must be JSON." }, 400);
  }

  const image_base64 = (payload.image_base64 ?? "").replace(/^data:[^,]+,/, "");
  const media_type = payload.media_type ?? "image/jpeg";
  if (!image_base64) return json({ error: "image_base64 is required." }, 400);

  try {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": ANTHROPIC_VERSION,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1024,
        system: SYSTEM,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: { type: "base64", media_type, data: image_base64 },
              },
              {
                type: "text",
                text:
                  "Extract the contact details from this business card as instructed. Return JSON only.",
              },
            ],
          },
        ],
      }),
    });

    if (!resp.ok) {
      const detail = await resp.text();
      return json(
        { error: "Extraction service error.", status: resp.status, detail },
        502,
      );
    }

    const data = await resp.json();
    const text =
      Array.isArray(data?.content)
        ? data.content.filter((b: any) => b?.type === "text").map((b: any) => b.text).join("\n")
        : "";

    const parsed = extractJson(text);
    if (!parsed) {
      // Honest failure: surface raw text instead of fabricating fields.
      return json(
        { error: "Could not parse a clean result from the card.", raw_text: text },
        422,
      );
    }

    return json({ fields: parsed, model_used: MODEL });
  } catch (e) {
    return json({ error: "Unexpected server error.", detail: String(e) }, 500);
  }
});
