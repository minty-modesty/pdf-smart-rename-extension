// pdfparse.js — thin glue over the locally-bundled pdf.js.
//
// Turns a PDF File/ArrayBuffer into the plain structure rename.js consumes:
// { meta, page1Items:[{str,x,y,size}], page1Text, fullText, pageCount,
//   pageHeight, originalName }. No rendering, no network, no eval.

import * as pdfjsLib from "./vendor/pdf.min.mjs";

// The worker ships inside the extension; never fetched from a CDN.
pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL("vendor/pdf.worker.min.mjs");

function itemsFromTextContent(textContent, pageHeight) {
  const out = [];
  for (const it of textContent.items) {
    if (!it.str || !it.transform) continue;
    const t = it.transform; // [a, b, c, d, e, f]
    const size = Math.hypot(t[2], t[3]) || it.height || 0;
    out.push({
      str: it.str,
      x: t[4],
      y: pageHeight - t[5], // flip so y grows downward from the page top
      size,
    });
  }
  return out;
}

const pageText = (tc) => tc.items.map((i) => i.str).join(" ").replace(/\s+/g, " ").trim();

export async function parsePdf(file) {
  const data =
    file instanceof ArrayBuffer ? new Uint8Array(file) : new Uint8Array(await file.arrayBuffer());

  const doc = await pdfjsLib.getDocument({
    data,
    isEvalSupported: false, // CSP: never use eval / new Function
    disableFontFace: true, // we only read text, no glyph rendering
    disableAutoFetch: true,
    disableStream: true,
    useSystemFonts: false,
  }).promise;

  try {
    const metaRes = await doc.getMetadata().catch(() => null);
    const meta = (metaRes && metaRes.info) || {};
    const pageCount = doc.numPages;

    const page1 = await doc.getPage(1);
    const vp = page1.getViewport({ scale: 1 });
    const pageHeight = vp.height;
    const tc1 = await page1.getTextContent();
    const page1Items = itemsFromTextContent(tc1, pageHeight);
    const page1Text = pageText(tc1);

    // A little extra text (up to 2 more pages) helps ID/date detection that
    // often lives in a header/footer or the second page. Cheap and bounded.
    let fullText = page1Text;
    for (let p = 2; p <= Math.min(pageCount, 3); p++) {
      const pg = await doc.getPage(p);
      fullText += " " + pageText(await pg.getTextContent());
      pg.cleanup();
    }

    return {
      meta,
      page1Items,
      page1Text,
      fullText: fullText.slice(0, 20000),
      pageCount,
      pageHeight,
      originalName: file.name || "",
    };
  } finally {
    await doc.cleanup().catch(() => {});
    doc.destroy();
  }
}
