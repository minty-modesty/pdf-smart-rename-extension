// rename.js — pure, dependency-free naming heuristics.
//
// Everything here is deterministic and runs the same in the browser popup and
// in Node (see ../../test/run.mjs). It takes an already-parsed representation of
// a PDF (metadata + first-page text items) and produces a suggested filename.
// No I/O, no pdf.js, no network — just string logic, so it is trivially testable.

export const DEFAULT_SETTINGS = {
  template: "{year}-{author}-{title}",
  separator: "-", // word separator inside a segment: "-", "_" or " "
  illegalReplacement: "-", // what to substitute for filesystem-illegal chars
  maxLen: 120, // max length of the name stem (without .pdf)
  lowercase: false,
};

// ---------------------------------------------------------------------------
// Sanitising
// ---------------------------------------------------------------------------

// Characters no major filesystem (Windows/macOS/Linux) accepts in a name.
const ILLEGAL = /[\/\\:*?"<>|\x00-\x1f]/g;

export function sanitizeSegment(input, settings) {
  const cfg = { ...DEFAULT_SETTINGS, ...(settings || {}) };
  if (!input) return "";
  let s = String(input);
  // Normalise unicode punctuation that tends to appear in extracted titles.
  s = s
    .replace(/[\u2018\u2019\u201b]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2013\u2014\u2015]/g, "-")
    .replace(/[\u00a0]/g, " ")
    .replace(/[\u200b-\u200f\ufeff]/g, "");
  const repl = cfg.illegalReplacement ?? "-";
  s = s.replace(ILLEGAL, repl);
  s = s.replace(/\s+/g, " ").trim();
  const sep = cfg.separator ?? "-";
  if (sep !== " ") s = s.replace(/ /g, sep);
  // Collapse each run of separator-ish chars to the run's FIRST char, so the
  // word separator and the (possibly different) illegal-char replacement are
  // both preserved rather than one being rewritten into the other.
  const collapse = new Set([sep, repl, "-", "_", " "]);
  let out = "";
  for (let i = 0; i < s.length; ) {
    const ch = s[i];
    if (collapse.has(ch)) {
      out += ch; // keep the first char of the run
      while (i < s.length && collapse.has(s[i])) i++;
    } else {
      out += ch;
      i++;
    }
  }
  // Trim leading/trailing separators/dots/spaces.
  out = out.replace(/^[\s._-]+|[\s._-]+$/g, "");
  if (cfg.lowercase) out = out.toLowerCase();
  return out;
}

// Full filename assembly: sanitise, cap length at a word boundary, add .pdf.
export function finalizeName(stem, settings = DEFAULT_SETTINGS) {
  let s = sanitizeSegment(stem, settings);
  if (!s) s = "document";
  const max = settings.maxLen ?? 120;
  if (s.length > max) {
    s = s.slice(0, max);
    const sep = settings.separator ?? "-";
    const cut = s.lastIndexOf(sep === " " ? " " : sep);
    if (cut > max * 0.5) s = s.slice(0, cut);
    s = s.replace(/[\s._-]+$/g, "");
  }
  return s + ".pdf";
}

// ---------------------------------------------------------------------------
// Metadata title cleanup
// ---------------------------------------------------------------------------

// Titles produced by authoring tools are often junk. Return "" for those so the
// pipeline falls through to the first-page heuristic.
const BAD_TITLE = /^(untitled|document\d*|microsoft word|no title|title|slide\s*\d*|presentation\d*|new document|scan|img[-_ ]?\d+|dokument\d*)$/i;

export function cleanMetaTitle(raw) {
  if (!raw) return "";
  let t = String(raw).trim();
  // Strip "Microsoft Word - foo.docx" style wrappers.
  t = t.replace(/^microsoft\s+word\s*-\s*/i, "");
  t = t.replace(/^(microsoft\s+powerpoint|powerpoint\s+presentation)\s*-\s*/i, "");
  // Drop a trailing source-file extension the tool left in the title.
  t = t.replace(/\.(docx?|pptx?|pages|tex|indd|pdf|rtf|odt)$/i, "").trim();
  if (!t) return "";
  if (BAD_TITLE.test(t)) return "";
  // A title that is literally a filename (no spaces, has an ext, or is a hash).
  if (/^[0-9a-f]{16,}$/i.test(t)) return "";
  if (t.length < 3) return "";
  // Reject titles that are just a URL.
  if (/^https?:\/\//i.test(t)) return "";
  return t;
}

// ---------------------------------------------------------------------------
// Structured identifiers
// ---------------------------------------------------------------------------

export function findStructuredIds(text) {
  const t = text || "";
  const out = {};

  // arXiv — modern (YYMM.NNNNN) and legacy (subject/YYMMNNN) forms.
  let m =
    t.match(/arXiv:\s*(\d{4}\.\d{4,5})(v\d+)?/i) ||
    t.match(/\b(\d{4}\.\d{4,5})(v\d+)\b/) ||
    t.match(/arXiv:\s*([a-z-]+(?:\.[A-Z]{2})?\/\d{7})/i);
  if (m) out.arxiv = m[1];

  // DOI.
  m = t.match(/\b(10\.\d{4,9}\/[-._;()\/:a-z0-9]+)\b/i);
  if (m) out.doi = m[1].replace(/[.,;]+$/, "");

  // ISBN-13 / ISBN-10.
  m = t.match(/ISBN(?:-1[03])?:?\s*((?:97[89][- ]?)?(?:\d[- ]?){9}[\dxX])/i);
  if (m) out.isbn = m[1].replace(/[- ]/g, "");

  // Invoice / receipt number.
  m =
    t.match(/\b(?:invoice|inv|receipt|bill)\s*(?:no\.?|number|#|nr\.?)\s*:?\s*([A-Z0-9][A-Z0-9\-\/]{2,20})/i) ||
    t.match(/\binvoice\s*#\s*([A-Z0-9][A-Z0-9\-\/]{2,20})/i);
  if (m) out.invoiceNo = m[1].replace(/[-\/]+$/, "");

  out.dates = findDates(t);
  return out;
}

// Return ISO dates (YYYY-MM-DD) found in free text, best-effort, deduped.
export function findDates(text) {
  const t = text || "";
  const found = [];
  const push = (y, mo, d) => {
    y = +y; mo = +mo; d = +d;
    if (y < 1900 || y > 2100 || mo < 1 || mo > 12 || d < 1 || d > 31) return;
    found.push(`${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`);
  };
  let m;
  // ISO: 2024-01-15 or 2024/01/15
  const iso = /\b(20\d{2}|19\d{2})[-\/.](\d{1,2})[-\/.](\d{1,2})\b/g;
  while ((m = iso.exec(t))) push(m[1], m[2], m[3]);
  // D/M/Y or M/D/Y — ambiguous; assume the larger of the first two is the day
  // when > 12, else treat as M/D/Y (US) as a coin-flip default.
  const dmy = /\b(\d{1,2})[-\/.](\d{1,2})[-\/.](20\d{2}|19\d{2})\b/g;
  while ((m = dmy.exec(t))) {
    let a = +m[1], b = +m[2];
    if (a > 12 && b <= 12) push(m[3], b, a);
    else push(m[3], a, b);
  }
  // "15 January 2024" / "January 15, 2024" / "Jan 15 2024"
  const MON = "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";
  const monNum = (s) => ["jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"].indexOf(s.slice(0, 3).toLowerCase()) + 1;
  const md = new RegExp(`\\b(${MON})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(20\\d{2}|19\\d{2})\\b`, "gi");
  while ((m = md.exec(t))) push(m[3], monNum(m[1]), m[2]);
  const dm = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MON})\\.?,?\\s+(20\\d{2}|19\\d{2})\\b`, "gi");
  while ((m = dm.exec(t))) push(m[3], monNum(m[2]), m[1]);
  return [...new Set(found)];
}

// A PDF metadata date like "D:20240115093000+01'00'" -> YYYY-MM-DD.
export function parsePdfDate(raw) {
  if (!raw) return "";
  const m = String(raw).match(/D?:?\s*(\d{4})(\d{2})?(\d{2})?/);
  if (!m) return "";
  const y = m[1], mo = m[2] || "01", d = m[3] || "01";
  if (+y < 1900 || +y > 2100) return "";
  return `${y}-${mo}-${d}`;
}

// ---------------------------------------------------------------------------
// First-page big-font title detection
// ---------------------------------------------------------------------------

const JUNK_LINE = /^(abstract|introduction|keywords?|contents|table of contents|references|acknowledge?ments|arxiv:|doi:|copyright|all rights reserved|confidential|draft|preprint|www\.|https?:|page \d+|\d+ of \d+|figure \d+|chapter \d+)/i;

function looksLikeTitle(str) {
  const s = str.trim();
  if (s.length < 6 || s.length > 250) return false;
  if (JUNK_LINE.test(s)) return false;
  if (/^\d[\d\s.,\/-]*$/.test(s)) return false; // just numbers
  if (/@/.test(s)) return false; // email / affiliation line
  const letters = (s.match(/[a-z]/gi) || []).length;
  if (letters < s.length * 0.4) return false; // mostly symbols/digits
  const words = s.split(/\s+/).length;
  if (words < 2 && s.length < 12) return false; // single short token
  return true;
}

// items: [{ str, x, y, size }]  (y measured from page top, increasing downward)
// pageHeight: text-space height. Groups items into lines and returns the text
// set in the largest font in the top region of the page.
export function pickTitleFromItems(items, pageHeight) {
  if (!items || !items.length) return "";
  const topLimit = pageHeight * 0.55; // only consider the top ~55% of page 1

  // Cluster into lines by y (tolerance scales with font size).
  const lines = [];
  for (const it of items) {
    const str = (it.str || "").trim();
    if (!str) continue;
    if (it.y > topLimit) continue;
    const tol = Math.max(2, (it.size || 10) * 0.4);
    let line = lines.find((l) => Math.abs(l.y - it.y) <= tol);
    if (!line) {
      line = { y: it.y, size: 0, parts: [] };
      lines.push(line);
    }
    line.parts.push({ x: it.x, str, size: it.size || 0 });
    line.size = Math.max(line.size, it.size || 0);
  }
  if (!lines.length) return "";

  for (const l of lines) {
    l.parts.sort((a, b) => a.x - b.x);
    l.text = l.parts.map((p) => p.str).join(" ").replace(/\s+/g, " ").trim();
  }
  lines.sort((a, b) => a.y - b.y); // top -> down

  // Largest font among plausible title lines.
  const maxSize = Math.max(...lines.filter((l) => looksLikeTitle(l.text)).map((l) => l.size).concat(0));
  if (!maxSize) return "";

  // Join consecutive top lines in (near) the max font size — multi-line titles.
  // The FIRST line must look like a real title; later same-size lines are
  // accepted as continuations even if short (e.g. a title wrapping to a single
  // trailing word like "Languages"), as long as they aren't obvious junk.
  const chosen = [];
  for (const l of lines) {
    const big = l.size >= maxSize * 0.92;
    if (!big) {
      if (chosen.length) break; // title block ended
      continue; // haven't reached the title line yet
    }
    const ok = chosen.length
      ? !JUNK_LINE.test(l.text) && !/@/.test(l.text) && !/^\d[\d\s.,\/-]*$/.test(l.text)
      : looksLikeTitle(l.text);
    if (ok) {
      chosen.push(l.text);
      if (chosen.join(" ").length > 200) break;
    } else if (chosen.length) {
      break;
    }
  }
  return chosen.join(" ").replace(/\s+/g, " ").trim();
}

// ---------------------------------------------------------------------------
// Author / year
// ---------------------------------------------------------------------------

// Turn a raw author string into a single "surname" token for filenames.
export function firstAuthorSurname(rawAuthor) {
  if (!rawAuthor) return "";
  let a = String(rawAuthor).trim();
  // Split multiple authors.
  const first = a.split(/\s*(?:;|,\s*and\s+|\band\b|&|,|\/|·)\s*/i)[0]?.trim();
  // But "Smith, John" means surname is the part BEFORE the comma.
  const commaForm = a.match(/^([A-Z][\p{L}'’-]+)\s*,\s*[A-Z]/u);
  let candidate = commaForm ? commaForm[1] : first || a;
  // From "John Q. Smith" take the last token as surname.
  const tokens = candidate.split(/\s+/).filter(Boolean);
  let surname = tokens[tokens.length - 1] || candidate;
  surname = surname.replace(/[^\p{L}'’-]/gu, "");
  if (surname.length < 2) surname = candidate.replace(/[^\p{L}'’-]/gu, "");
  return surname;
}

export function pickYear({ ids, metaDate, page1Text }) {
  if (ids?.arxiv) {
    const m = ids.arxiv.match(/^(\d{2})(\d{2})\./);
    if (m) return "20" + m[1];
    const leg = ids.arxiv.match(/\/(\d{2})/); // legacy YYMMNNN
    if (leg) return "20" + leg[1];
  }
  if (ids?.dates?.length) return ids.dates[0].slice(0, 4);
  const md = parsePdfDate(metaDate);
  if (md) return md.slice(0, 4);
  const m = (page1Text || "").match(/\b(19\d{2}|20\d{2})\b/);
  if (m) return m[1];
  return "";
}

// ---------------------------------------------------------------------------
// Classification + field extraction
// ---------------------------------------------------------------------------

const INVOICE_HINT = /\b(invoice|receipt|bill to|billed to|amount due|balance due|total due|subtotal|purchase order|order confirmation|payment|vat|tax id)\b/i;
const PAPER_HINT = /\b(abstract|we propose|in this paper|et al\.?|proceedings|journal of|conference on|university|department of|arxiv)\b/i;

export function buildParsed(input, settings = DEFAULT_SETTINGS) {
  const {
    meta = {},
    page1Items = [],
    page1Text = "",
    fullText = "",
    pageCount = 0,
    pageHeight = 792,
    originalName = "",
  } = input;

  const text = fullText || page1Text;
  const ids = findStructuredIds(text);
  const metaTitle = cleanMetaTitle(meta.Title);
  const bigTitle = pickTitleFromItems(page1Items, pageHeight);
  const title = metaTitle || bigTitle || "";
  const year = pickYear({ ids, metaDate: meta.CreationDate || meta.ModDate, page1Text: text });

  // Classify.
  let type = "document";
  const invScore = INVOICE_HINT.test(text) || ids.invoiceNo;
  const paperScore = ids.arxiv || ids.doi || PAPER_HINT.test(text);
  if (invScore && !ids.arxiv && !ids.doi) type = "invoice";
  else if (paperScore) type = "paper";
  else if (ids.isbn || (meta.Author && pageCount > 30)) type = "ebook";

  // Author / vendor.
  let author = "";
  let vendor = "";
  if (type === "paper" || type === "ebook") {
    // Prefer the embedded Author metadata. Only fall back to a first-page name
    // line when it clearly isn't part of the title (guessAuthorLine self-checks),
    // because a wrong author reads worse than none at all.
    author = firstAuthorSurname(meta.Author);
    if (!author) {
      const guess = guessAuthorLine(page1Items, pageHeight, title);
      if (guess && !titleContains(title, guess)) author = firstAuthorSurname(guess);
    }
  }
  if (type === "invoice") {
    // Vendor: metadata author/company, else the biggest line on the page.
    vendor = (meta.Author && meta.Author.trim()) || bigTitle || meta.Creator || "";
    vendor = vendor.split(/\r?\n/)[0].slice(0, 40);
  }

  // Date (for invoices/general): prefer an explicit in-text date, else meta.
  const date = (ids.dates && ids.dates[0]) || parsePdfDate(meta.CreationDate || meta.ModDate) || "";

  // Best structured id string for the {id} token.
  let id = "";
  if (ids.arxiv) id = "arXiv-" + ids.arxiv;
  else if (ids.doi) id = "DOI-" + ids.doi.replace(/\//g, "_");
  else if (ids.isbn) id = "ISBN-" + ids.isbn;
  else if (ids.invoiceNo) id = /^(inv|invoice|receipt|bill)/i.test(ids.invoiceNo)
    ? ids.invoiceNo
    : "INV-" + ids.invoiceNo;

  return {
    type,
    title,
    titleSource: metaTitle ? "metadata" : bigTitle ? "firstpage" : "none",
    author,
    authors: meta.Author || "",
    vendor,
    year,
    date,
    id,
    ids,
    pageCount,
    originalName,
  };
}

// True if most words of `line` already appear in `title` — i.e. the "author"
// candidate is really a wrapped fragment of the title, so we must reject it.
function titleContains(title, line) {
  if (!title || !line) return false;
  const tl = title.toLowerCase();
  const words = line.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
  if (!words.length) return false;
  const hit = words.filter((w) => tl.includes(w)).length;
  return hit / words.length >= 0.6;
}

// Heuristic: the line just below the title that looks like an author list.
function guessAuthorLine(items, pageHeight, title) {
  if (!items || !items.length) return "";
  const topLimit = pageHeight * 0.55;
  const lines = [];
  for (const it of items) {
    const str = (it.str || "").trim();
    if (!str || it.y > topLimit) continue;
    let line = lines.find((l) => Math.abs(l.y - it.y) <= Math.max(2, (it.size || 10) * 0.4));
    if (!line) { line = { y: it.y, parts: [] }; lines.push(line); }
    line.parts.push({ x: it.x, str });
  }
  lines.sort((a, b) => a.y - b.y);
  for (const l of lines) {
    l.text = l.parts.sort((a, b) => a.x - b.x).map((p) => p.str).join(" ").replace(/\s+/g, " ").trim();
  }
  const ti = lines.findIndex((l) => title && l.text && title.startsWith(l.text.slice(0, 12)));
  const scan = ti >= 0 ? lines.slice(ti + 1, ti + 4) : lines.slice(0, 3);
  for (const l of scan) {
    const s = l.text;
    if (!s || /@/.test(s) || JUNK_LINE.test(s)) continue;
    // A name line: 1-6 capitalised words, maybe separated by commas/and.
    if (/^([A-Z][\p{L}'’.-]+(?:\s+[A-Z][\p{L}'’.-]+){0,3})(?:\s*(?:,|and|&)\s*[A-Z].*)?$/u.test(s)) {
      return s;
    }
  }
  return "";
}

// ---------------------------------------------------------------------------
// Template rendering
// ---------------------------------------------------------------------------

// Render "{year}-{author}-{title}" against the parsed fields, dropping empty
// tokens and cleaning up the separators/dividers they leave behind.
export function renderTemplate(template, fields, settings = DEFAULT_SETTINGS) {
  const tpl = template || DEFAULT_SETTINGS.template;
  // Each token becomes its sanitised value; empty tokens leave the surrounding
  // literal dividers behind, which sanitizeSegment()/finalizeName() collapse
  // (runs of separators -> one) and trim from the ends.
  return tpl.replace(/\{(\w+)\}/g, (_, name) => {
    const v = fields[name];
    return v == null ? "" : sanitizeSegment(String(v), settings);
  });
}

export function suggestName(input, settings = DEFAULT_SETTINGS) {
  const cfg = { ...DEFAULT_SETTINGS, ...settings };
  const p = buildParsed(input, cfg);

  const fields = {
    title: p.title,
    author: p.author,
    authors: p.authors,
    vendor: p.vendor,
    year: p.year,
    date: p.date,
    id: p.id,
    type: p.type,
    original: (p.originalName || "").replace(/\.pdf$/i, ""),
  };

  // Choose an effective template. If the user is still on the built-in default,
  // pick a template that fits the detected document type (an invoice wants
  // vendor+date+number, not the paper-style {year}-{author}-{title}). If the
  // user customised the template, honour it verbatim. Either way, fall through
  // to progressively simpler templates when a candidate yields nothing usable.
  const usingDefault = cfg.template === DEFAULT_SETTINGS.template;
  const candidates = [];
  if (usingDefault && p.type === "invoice") candidates.push("{date}-{vendor}-invoice-{id}", "{date}-{vendor}-invoice");
  candidates.push(cfg.template);
  if (p.type === "invoice") candidates.push("{date}-{vendor}-invoice-{id}", "{date}-{vendor}-invoice");
  if (p.type === "paper") candidates.push("{year}-{author}-{title}", "{title}-{id}");
  if (p.type === "ebook") candidates.push("{author}-{title}", "{title}");
  candidates.push("{title}", "{id}", "{date}-document", "{original}");

  let stem = "";
  for (const c of candidates) {
    stem = renderTemplate(c, fields, cfg);
    const cleaned = sanitizeSegment(stem, cfg);
    if (cleaned && cleaned.length >= 3) { stem = cleaned; break; }
    stem = "";
  }
  if (!stem) stem = "document";

  return {
    name: finalizeName(stem, cfg),
    parsed: p,
  };
}
