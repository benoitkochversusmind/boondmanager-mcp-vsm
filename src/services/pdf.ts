import { extractText, getDocumentProxy } from "unpdf";

/**
 * Extract the text layer from a PDF buffer using unpdf (a bundled pdf.js build,
 * zero native dependencies — safe in the Alpine container). Returns the merged
 * plain text, trimmed.
 *
 * Returns "" when the PDF has no extractable text (scanned / image-only) or
 * fails to parse: the caller then falls back to handing the raw PDF to the
 * model. This is the "hybrid" read strategy (text first, PDF otherwise).
 */
export async function extractPdfText(buffer: Buffer): Promise<string> {
  try {
    const pdf = await getDocumentProxy(new Uint8Array(buffer));
    // mergePages:true → `text` is a single string (one per page joined).
    const { text } = await extractText(pdf, { mergePages: true });
    return String(text ?? "").trim();
  } catch {
    return "";
  }
}
