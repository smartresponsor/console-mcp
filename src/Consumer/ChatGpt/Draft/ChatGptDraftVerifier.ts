export type DraftVerificationStatus = "RAW_MATCH" | "NORMALIZED_MATCH" | "MISMATCH";
export type MismatchClassification = "newline_only" | "whitespace_only" | "unicode_only" | "content_changed" | "unknown";

export function verifyDraft(expected: string, actual: string): Record<string, unknown> {
  const rawMatch = expected === actual;
  const normalizedExpected = normalizeDraftForComparison(expected);
  const normalizedActual = normalizeDraftForComparison(actual);
  const normalizedMatch = normalizedExpected === normalizedActual;
  const status: DraftVerificationStatus = rawMatch ? "RAW_MATCH" : (normalizedMatch ? "NORMALIZED_MATCH" : "MISMATCH");
  return {
    draft_verification: status,
    expected_length: expected.length,
    actual_length: actual.length,
    normalized_expected_length: normalizedExpected.length,
    normalized_actual_length: normalizedActual.length,
    mismatch_classification: status === "MISMATCH" ? classifyDraftMismatch(expected, actual) : classifyNonContentDifference(expected, actual),
  };
}

function normalizeDraftForComparison(value: string): string {
  const normalized = typeof value.normalize === "function" ? value.normalize("NFKC") : value;
  return normalized
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\u00a0/g, " ")
    .replace(/[\u200b-\u200d\ufeff]/g, "")
    .replace(/\n$/u, "");
}

function classifyNonContentDifference(expected: string, actual: string): MismatchClassification {
  if (expected === actual) return "unknown";
  if (expected.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n$/u, "") === actual.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n$/u, "")) return "newline_only";
  if (expected.replace(/\s+/gu, " ") === actual.replace(/\s+/gu, " ")) return "whitespace_only";
  if ((typeof expected.normalize === "function" ? expected.normalize("NFKC") : expected) === (typeof actual.normalize === "function" ? actual.normalize("NFKC") : actual)) return "unicode_only";
  return "unknown";
}

function classifyDraftMismatch(expected: string, actual: string): MismatchClassification {
  if (normalizeDraftForComparison(expected) === normalizeDraftForComparison(actual)) return classifyNonContentDifference(expected, actual);
  if (expected.replace(/\r\n/g, "\n").replace(/\r/g, "\n") === actual.replace(/\r\n/g, "\n").replace(/\r/g, "\n")) return "newline_only";
  if (normalizeDraftForComparison(expected).replace(/\s+/gu, " ") === normalizeDraftForComparison(actual).replace(/\s+/gu, " ")) return "whitespace_only";
  const unicodeExpected = typeof expected.normalize === "function" ? expected.normalize("NFKC") : expected;
  const unicodeActual = typeof actual.normalize === "function" ? actual.normalize("NFKC") : actual;
  if (unicodeExpected === unicodeActual) return "unicode_only";
  return expected.length !== actual.length || !actual.includes(expected.slice(0, Math.min(20, expected.length))) ? "content_changed" : "unknown";
}
