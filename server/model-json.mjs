import { createHash } from "node:crypto";
const hash = (s) => createHash("sha256").update(s).digest("hex");
// Repair only redundant closing braces after an already complete JSON object.
// No keys, strings, formulas, values or missing delimiters are inferred.
export function parseModelJson(text) {
  let parsed, error;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    error = e;
  }
  let normalization = null;
  if (error) {
    const raw = text.trimEnd();
    for (
      let count = 1;
      count <= 8 && raw.endsWith("}".repeat(count));
      count++
    ) {
      const candidate = raw.slice(0, -count);
      try {
        const value = JSON.parse(candidate);
        if (!value || typeof value !== "object" || Array.isArray(value))
          continue;
        parsed = value;
        normalization = {
          kind: "redundant_trailing_object_closers",
          count,
          rawSha256: hash(text),
          normalizedSha256: hash(candidate),
        };
        error = null;
        break;
      } catch {
        /* Ambiguous or substantive damage stays rejected. */
      }
    }
  }
  if (error) throw error;
  return { parsed, normalization };
}

// A final message may wrap one complete JSON object in a Markdown code fence.
// Unwrap framing only: never infer missing mathematical fields or delimiters.
// Tool arguments deliberately continue to use strict JSON parsing.
export function parseModelFinalObject(text) {
  try {
    return parseModelJson(text);
  } catch (originalError) {
    const fence =
      /^([ \t]{0,3})```(?:json)?[ \t]*\r?\n([\s\S]*?)^[ \t]{0,3}```[ \t]*(?:\r?\n|$)/gm;
    const matches = [...text.matchAll(fence)];
    if (matches.length !== 1) throw originalError;
    const match = matches[0];
    const outside =
      text.slice(0, match.index) + text.slice(match.index + match[0].length);
    // More fences or another possible object make selection ambiguous.
    if (/[{}]|```|~~~/.test(outside) || /```|~~~/.test(match[2]))
      throw originalError;
    const value = parseModelJson(match[2]);
    if (
      !value.parsed ||
      typeof value.parsed !== "object" ||
      Array.isArray(value.parsed)
    )
      throw originalError;
    return {
      parsed: value.parsed,
      normalization: {
        kind: "single_fenced_json_object",
        rawSha256: hash(text),
        extractedSha256: hash(match[2]),
        normalizedSha256:
          value.normalization?.normalizedSha256 || hash(match[2]),
        innerNormalization: value.normalization,
      },
    };
  }
}
