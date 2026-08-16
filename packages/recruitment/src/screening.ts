// CV screening. Reads the application's CV from R2 + the form fields, sends them to Gemini,
// and writes the traffic-light assessment onto the D1 row. Port of the website's /api/screen
// (which wrote to Twenty). Rules mirror skills/ops/recruiting/rubric.md and
// workflows/internship-recruiting.md; keep them in step when the rubric changes.

import type { Env } from "./index.js";

// gemini-3 previews 503 on inline PDFs; gemini-flash-latest reads them reliably (per screen.ts).
const MODEL = "gemini-flash-latest";

const RUBRIC = `You are screening a candidate for an internship at Impact Finance Belgium (IFB), a
membership association growing sustainable and impact investing in Belgium. The internship targets a
September start. Read the CV (attached) and the form fields below, then return ONE JSON object.
Only state what the material supports; use null when not evidenced. Rules:
- start_fit vs September: "good"=September; "ok"=a bit before/after (Jul,Aug,Oct,Nov); "off"=later/much earlier.
- full_or_part_time: "full" or "part".
- study_level: level + year + whether it is a mandatory internship during studies.
- mandatory_for_studies: true/false.
- country_residence, nationality: short strings.
- lang_fr/lang_nl/lang_en: "fluent"|"knowledge"|"none". Role needs English + at least French or Dutch.
- finance_experience, impact_experience: exactly "No" | "Yes (University)" | "Yes (Professional)" | "Yes (Both)".
- score: "good"|"maybe"|"not_good" = worst level across dimensions ("good" only if all strong;
  "not_good" if any clearly weak). Languages are ONE dimension (English fluent AND one of FR/NL fluent = strong);
  do not mark weak only for a missing non-required third language.
- score_comment: one short sentence.
Return ONLY the JSON, keys: start_fit, full_or_part_time, study_level, mandatory_for_studies,
country_residence, nationality, lang_fr, lang_nl, lang_en, finance_experience, impact_experience,
score, score_comment.`;

interface RawApp {
  cv_key: string | null;
  motivation_text: string | null;
  position_applied: string | null;
  start_month: string | null;
  country_residence: string | null;
  nationality: string | null;
  study_level: string | null;
  full_or_part_time: string | null;
}

async function cvBase64(env: Env, key: string): Promise<{ data: string; mime: string } | null> {
  const obj = await env.CVS.get(key);
  if (!obj) return null;
  const buf = await obj.arrayBuffer();
  let bin = "";
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return { data: btoa(bin), mime: obj.httpMetadata?.contentType || "application/pdf" };
}

const jsonRes = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { "content-type": "application/json" } });

export async function screenApplication(env: Env, id: string): Promise<Response> {
  if (!env.GOOGLE_API_KEY) return jsonRes({ error: "GOOGLE_API_KEY not set" }, 500);
  const app = await env.DB.prepare(
    `SELECT cv_key, motivation_text, position_applied, start_month, country_residence, nationality,
            study_level, full_or_part_time FROM recruitment_application WHERE id = ?`,
  ).bind(id).first<RawApp>();
  if (!app) return jsonRes({ error: "application not found" }, 404);

  const parts: unknown[] = [{
    text: `${RUBRIC}\n\nForm fields (candidate-provided, may be partial):\n`
      + JSON.stringify({
        position: app.position_applied, start_month: app.start_month,
        country_residence: app.country_residence, nationality: app.nationality,
        study_level: app.study_level, full_or_part_time: app.full_or_part_time,
        motivation: app.motivation_text,
      }),
  }];
  if (app.cv_key) {
    const cv = await cvBase64(env, app.cv_key);
    if (cv) parts.push({ inline_data: { mime_type: cv.mime, data: cv.data } });
  }

  let assessment: Record<string, unknown>;
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${env.GOOGLE_API_KEY}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts }],
          generationConfig: { responseMimeType: "application/json", temperature: 0.2 },
        }),
      },
    );
    if (!res.ok) return jsonRes({ error: `Gemini ${res.status}: ${(await res.text()).slice(0, 200)}` }, 502);
    const out = (await res.json()) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
    const text = out.candidates?.[0]?.content?.parts?.[0]?.text ?? "{}";
    assessment = JSON.parse(text);
  } catch (err) {
    return jsonRes({ error: `screening failed: ${(err as Error).message}` }, 502);
  }

  const g = (k: string) => {
    const v = assessment[k];
    return v === undefined || v === null || v === "" ? null : v;
  };
  await env.DB.prepare(
    `UPDATE recruitment_application SET
       start_fit=?, full_or_part_time=COALESCE(?,full_or_part_time), study_level=COALESCE(?,study_level),
       mandatory_for_studies=COALESCE(?,mandatory_for_studies),
       country_residence=COALESCE(?,country_residence), nationality=COALESCE(?,nationality),
       lang_fr=?, lang_nl=?, lang_en=?, finance_experience=?, impact_experience=?,
       score=?, score_comment=?, stage=CASE WHEN stage='applied' THEN 'cv_screen' ELSE stage END,
       updated_at=datetime('now')
     WHERE id=?`,
  ).bind(
    g("start_fit"), g("full_or_part_time"), g("study_level"),
    typeof g("mandatory_for_studies") === "boolean" ? (g("mandatory_for_studies") ? 1 : 0) : null,
    g("country_residence"), g("nationality"),
    g("lang_fr"), g("lang_nl"), g("lang_en"), g("finance_experience"), g("impact_experience"),
    g("score"), g("score_comment"), id,
  ).run();

  return jsonRes({ ok: true, id, score: g("score") });
}
