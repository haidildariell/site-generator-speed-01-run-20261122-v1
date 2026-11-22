// A faster drop-in for makefun-site 1.0.0 (site-generator-speed-01-run-20261122).
//
// run(input) returns exactly the output tree makefun-site 1.0.0's build returns
// for the same input, byte for byte. Written from the behaviour stated in the
// reference README and its code (front matter, template dialect, Markdown
// subset, slug rule, build report); no vendored code is reused here.
//
// Speed comes from removing the reference's per-character and per-line regex
// work, not from changing any answer:
//  - inline Markdown scans literal runs and escapes them in bulk instead of
//    escaping one character at a time;
//  - the block lexer is a single fused pass with hand-rolled line checks
//    (no regex per line) that renders straight into the output;
//  - slugify takes an ASCII fast path and is memoised per build (tag names,
//    titles and dates repeat heavily across a site);
//  - front matter is parsed by hand instead of by a regex per line;
//  - template rendering threads one output array through the tree walk
//    instead of building an intermediate string per node;
//  - per-source cards are computed once and reused.
//
// Everything a case needs is created fresh inside run(): nothing is carried
// from one case to the next.

const REPORT_FILE = 'build-report.txt';
const RESERVED = ['posts', 'tags', 'page'];
const INCLUDE_DEPTH = 8;
const SLUG_MAX = 64;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const isSpaceTab = (c) => c === 32 || c === 9;
// JavaScript's \s set, for word counting.
const isWs = (c) =>
  c === 32 || c === 9 || c === 10 || c === 11 || c === 12 || c === 13 || c === 160 || c === 5760 ||
  (c >= 8192 && c <= 8202) || c === 8232 || c === 8233 || c === 8239 || c === 8287 || c === 12288 || c === 65279;

// ---------------------------------------------------------------- text

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_RE = /[&<>"']/g;
const escReplacer = (c) => ESCAPES[c];

/** `text` with & < > " and ' escaped. A replace with no match returns the input itself. */
function escapeHtml(text) {
  return text.replace(ESC_RE, escReplacer);
}

/**
 * The slug of `text`: NFKD, combining marks dropped, A-Z lowered, every run
 * of characters other than a-z and 0-9 one "-", none at either end, at most
 * 64 characters (a "-" left at the cut dropped), "untitled" when nothing is
 * left. Pure-ASCII input skips normalisation: NFKD is the identity there and
 * ASCII holds no combining marks.
 */
function slugify(text) {
  let plain = text;
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 127) { ascii = false; break; }
  }
  if (!ascii) plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let gap = false;
  for (const ch of plain) {
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  out = out.slice(0, SLUG_MAX);
  let end = out.length;
  while (end > 0 && out.charCodeAt(end - 1) === 45) end--;
  out = out.slice(0, end);
  return out === '' ? 'untitled' : out;
}

/** `slug` made unique against `taken` (and added to it). */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

/** A YYYY-MM-DD date in words, from the string alone. */
function longDate(date) {
  const y = date.slice(0, 4);
  const m = Number(date.slice(5, 7));
  const d = Number(date.slice(8, 10));
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

/** The words of a body's lines: runs of characters other than whitespace (a line end breaks words, as "\n" does). */
function wordsOfLines(lines, from) {
  let n = 0;
  for (let li = from; li < lines.length; li++) {
    const text = lines[li];
    let inWord = false;
    for (let i = 0; i < text.length; i++) {
      if (isWs(text.charCodeAt(i))) inWord = false;
      else if (!inWord) { inWord = true; n++; }
    }
  }
  return n;
}

/** `rel` from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

// ---------------------------------------------------------------- front matter

const KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const NAME_RE = /^[a-z0-9-]+$/;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or a bare rest of line. */
function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = DATE_RE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      for (const t of tags) {
        if (t === '') return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        for (let i = 0; i < t.length; i++) {
          const c = t.charCodeAt(i);
          if (c === 34 || c === 91 || c === 93) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        }
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return NAME_RE.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return SLUG_RE.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

function isBlankLine(line) {
  for (let i = 0; i < line.length; i++) if (!isSpaceTab(line.charCodeAt(i))) return false;
  return true;
}

/** A source's front matter and body: { data, body }, or { error }. */
function parseFrontMatter(text) {
  const lines = text.split('\n');
  if (lines[0] !== '---') return { error: 'no front matter' };
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') { close = i; break; }
  }
  if (close === -1) return { error: 'the front matter is not closed' };
  const data = {};
  for (let i = 1; i < close; i++) {
    const line = lines[i];
    if (isBlankLine(line) || line.charCodeAt(0) === 35) continue;
    const colon = line.indexOf(':');
    if (colon <= 0) return { error: `line ${i + 1} is not "key: value"` };
    let keyOk = true;
    for (let k = 0; k < colon; k++) {
      const c = line.charCodeAt(k);
      if (!((c >= 97 && c <= 122) || c === 95)) { keyOk = false; break; }
    }
    if (!keyOk) return { error: `line ${i + 1} is not "key: value"` };
    const rest = line.slice(colon + 1);
    let raw;
    if (rest === '') raw = '';
    else if (rest.charCodeAt(0) === 32) raw = rest.slice(1);
    else return { error: `line ${i + 1} is not "key: value"` };
    let end = raw.length;
    while (end > 0 && isSpaceTab(raw.charCodeAt(end - 1))) end--;
    raw = raw.slice(0, end);
    const key = line.slice(0, colon);
    if (!KEYS.includes(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, lines, bodyFrom: close + 1 };
}

// ---------------------------------------------------------------- markdown

// The characters a backslash escapes: \ ` * _ [ ] ( ) # + - . ! >
function isEscapableCode(c) {
  return c === 92 || c === 96 || c === 42 || c === 95 || c === 91 || c === 93 || c === 40 || c === 41 ||
    c === 35 || c === 43 || c === 45 || c === 46 || c === 33 || c === 62;
}

/** The first index from `from` where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from) {
  for (let j = from; j <= s.length - what.length; j++) {
    if (s.charCodeAt(j) === 92 && j + 1 < s.length && isEscapableCode(s.charCodeAt(j + 1))) { j++; continue; }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < s.length && isEscapableCode(s.charCodeAt(j + 1))) { j++; continue; }
    if (c !== 42) continue;
    if (s.charCodeAt(j + 1) === 42) { j++; continue; }
    return j;
  }
  return -1;
}

const WS_RE = /\s/;
const INLINE_SPECIAL_RE = /[\\`*[]/;

/**
 * `s` rendered inline; `env.link(target)` is a link's href. Literal runs are
 * collected and escaped in bulk; only real constructs break the run. Text
 * with no inline construct at all is just escaped in one pass.
 */
function inline(s, env) {
  if (!INLINE_SPECIAL_RE.test(s)) return escapeHtml(s);
  const out = [];
  let i = 0;
  let lit = 0;
  while (i < s.length) {
    const c = s.charCodeAt(i);
    if (c === 92 && i + 1 < s.length && isEscapableCode(s.charCodeAt(i + 1))) {
      if (i > lit) out.push(escapeHtml(s.slice(lit, i)));
      out.push(escapeHtml(s[i + 1]));
      i += 2;
      lit = i;
      continue;
    }
    if (c === 96) {
      const j = s.indexOf('`', i + 1);
      if (j > i + 1) {
        if (i > lit) out.push(escapeHtml(s.slice(lit, i)));
        out.push('<code>', escapeHtml(s.slice(i + 1, j)), '</code>');
        i = j + 1;
        lit = i;
      } else i++;
      continue;
    }
    if (c === 42) {
      if (s.charCodeAt(i + 1) === 42) {
        const j = findUnescaped(s, '**', i + 2);
        if (j > i + 2) {
          if (i > lit) out.push(escapeHtml(s.slice(lit, i)));
          out.push('<strong>', inline(s.slice(i + 2, j), env), '</strong>');
          i = j + 2;
          lit = i;
        } else i += 2;
        continue;
      }
      const j = findSingleStar(s, i + 1);
      if (j > i + 1) {
        if (i > lit) out.push(escapeHtml(s.slice(lit, i)));
        out.push('<em>', inline(s.slice(i + 1, j), env), '</em>');
        i = j + 1;
        lit = i;
      } else i++;
      continue;
    }
    if (c === 91) {
      const k = findUnescaped(s, ']', i + 1);
      const m = k !== -1 && s.charCodeAt(k + 1) === 40 ? s.indexOf(')', k + 2) : -1;
      const target = m === -1 ? '' : s.slice(k + 2, m);
      if (target !== '' && !WS_RE.test(target)) {
        if (i > lit) out.push(escapeHtml(s.slice(lit, i)));
        out.push('<a href="', escapeHtml(env.link(target)), '">', inline(s.slice(i + 1, k), env), '</a>');
        i = m + 1;
        lit = i;
      } else i++;
      continue;
    }
    i++;
  }
  if (s.length > lit) out.push(escapeHtml(s.slice(lit)));
  return out.join('');
}

// --- block line checks (hand-rolled equivalents of the reference's line regexes)

function fenceLang(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let i = 3;
  let lang = '';
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) { lang += line[i]; i++; }
    else break;
  }
  while (i < line.length) {
    if (!isSpaceTab(line.charCodeAt(i))) return null;
    i++;
  }
  return lang;
}

function fenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let i = 3; i < line.length; i++) if (!isSpaceTab(line.charCodeAt(i))) return false;
  return true;
}

/** A heading line's level and text, or null (a heading's text is never empty). */
function headingOf(line) {
  let n = 0;
  while (n < line.length && line.charCodeAt(n) === 35) n++;
  if (n === 0 || n > 6 || n >= line.length) return null;
  if (!isSpaceTab(line.charCodeAt(n))) return null;
  let j = n;
  while (j < line.length && isSpaceTab(line.charCodeAt(j))) j++;
  if (j >= line.length) return null;
  let end = line.length;
  while (end > j && isSpaceTab(line.charCodeAt(end - 1))) end--;
  const text = line.slice(j, end);
  if (text === '') return null;
  return { depth: n, text };
}

function isHr(line) {
  if (line.charCodeAt(0) !== 45 && line.charCodeAt(0) !== 42) return false;
  const triple = line.charCodeAt(0) === 45 ? '---' : '***';
  if (!line.startsWith(triple)) return false;
  for (let i = 3; i < line.length; i++) if (!isSpaceTab(line.charCodeAt(i))) return false;
  return true;
}

/** Whether `line` ends a paragraph: a blank line, a fence, a heading or a thematic break. */
function endsParagraph(line) {
  return isBlankLine(line) || fenceLang(line) !== null || headingOf(line) !== null || isHr(line);
}

const trimLine = (line) => {
  let a = 0;
  let b = line.length;
  while (a < b && isSpaceTab(line.charCodeAt(a))) a++;
  while (b > a && isSpaceTab(line.charCodeAt(b - 1))) b--;
  return line.slice(a, b);
};

/** A list item's marker: { ordered, num, content } or null. */
function listMarker(line) {
  const c0 = line.charCodeAt(0);
  if ((c0 === 45 || c0 === 42) && line.charCodeAt(1) === 32) return { ordered: false, num: 1, content: line.slice(2) };
  if (c0 >= 48 && c0 <= 57) {
    let i = 0;
    while (i < line.length && line.charCodeAt(i) >= 48 && line.charCodeAt(i) <= 57) i++;
    if (i >= 1 && i <= 9 && line.charCodeAt(i) === 46 && line.charCodeAt(i + 1) === 32) {
      return { ordered: true, num: Number(line.slice(0, i)), content: line.slice(i + 2) };
    }
  }
  return null;
}

function isContinued(line) {
  let i = 0;
  while (i < line.length && line.charCodeAt(i) === 32) i++;
  if (i < 2 || i >= line.length) return false;
  return !isWs(line.charCodeAt(i));
}

/**
 * `lines` from `from` rendered in one fused pass: its HTML (each block on its
 * own lines, a "\n" after the last), its table of contents and its excerpt.
 */
function renderMarkdown(lines, from, env, slug) {
  const blocks = [];
  const toc = [];
  const ids = new Set();
  let excerpt = null;
  let i = from;
  while (i < lines.length) {
    const line = lines[i];
    if (isBlankLine(line)) { i++; continue; }
    const lang = fenceLang(line);
    if (lang !== null) {
      const body = [];
      i++;
      while (i < lines.length && !fenceClose(lines[i])) body.push(lines[i++]);
      i++;
      let code = '';
      for (const l of body) { code += escapeHtml(l); code += '\n'; }
      blocks.push(`<pre><code${lang === '' ? '' : ` class="language-${escapeHtml(lang)}"`}>${code}</code></pre>\n`);
      continue;
    }
    const h = headingOf(line);
    if (h !== null) {
      const id = uniqueSlug(slug(h.text), ids);
      const html = inline(h.text, env);
      blocks.push(`<h${h.depth} id="${id}">${html}</h${h.depth}>\n`);
      if (h.depth === 2 || h.depth === 3) toc.push({ level: h.depth, id, html });
      i++;
      continue;
    }
    if (isHr(line)) { blocks.push('<hr>\n'); i++; continue; }
    if (line.charCodeAt(0) === 62) {
      const body = [];
      while (i < lines.length && lines[i].charCodeAt(0) === 62) {
        const l = lines[i++];
        body.push(trimLine(l.charCodeAt(1) === 32 ? l.slice(2) : l.slice(1)));
      }
      const kept = body.filter((l) => l !== '');
      blocks.push(kept.length === 0 ? '<blockquote>\n</blockquote>\n' : `<blockquote>\n<p>${inline(kept.join('\n'), env)}</p>\n</blockquote>\n`);
      continue;
    }
    const marker = listMarker(line);
    if (marker !== null) {
      const ordered = marker.ordered;
      const start = marker.num;
      const items = [];
      while (i < lines.length) {
        const mm = listMarker(lines[i]);
        if (mm !== null && mm.ordered === ordered) { items.push([trimLine(mm.content)]); i++; }
        else if (isContinued(lines[i])) { items[items.length - 1].push(trimLine(lines[i])); i++; }
        else break;
      }
      const tag = ordered ? 'ol' : 'ul';
      const open = ordered && start !== 1 ? `<ol start="${start}">` : `<${tag}>`;
      let html = `${open}\n`;
      for (const item of items) html += `<li>${inline(item.join('\n'), env)}</li>\n`;
      html += `</${tag}>\n`;
      blocks.push(html);
      continue;
    }
    const body = [trimLine(line)];
    i++;
    while (i < lines.length && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    const html = inline(body.join('\n'), env);
    if (excerpt === null) excerpt = html;
    blocks.push(`<p>${html}</p>\n`);
  }
  return { html: blocks.join(''), toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- templates

class TemplateError extends Error {}

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src.charCodeAt(open + 1);
    if (next !== 123 && next !== 37) {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === 123) {
      const raw = src.charCodeAt(open + 2) === 123;
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    let standalone = true;
    for (let k = lineStart; k < open; k++) if (!isSpaceTab(src.charCodeAt(k))) { standalone = false; break; }
    if (standalone) for (let k = end; k < lineEnd; k++) if (!isSpaceTab(src.charCodeAt(k))) { standalone = false; break; }
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/** The value at `path` in the scope chain: its first name from the nearest scope holding it, then own properties. */
function lookup(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

// ---------------------------------------------------------------- template render cache
//
// A template whose render can only depend on `site`, `tags` and `recent`
// (the same for every page of a case) renders the same string wherever it is
// included, so it is rendered once per case and depth and reused. Which
// templates qualify is decided by a conservative free-name analysis over the
// parsed trees (see templateFreeNames below); at each include the scope chain
// is checked for a loop frame that binds one of those names, which would
// shadow the top-level value and make the cached string wrong.

const CASE_CONSTANTS = ['site', 'tags', 'recent'];

/** Direct free first-segments of `nodes`, plus the templates it includes. */
function templateDirectFree(nodes) {
  const free = new Set();
  const includes = [];
  const walk = (ns, bound) => {
    for (const n of ns) {
      if (n.kind === 'var' || n.kind === 'raw' || n.kind === 'if') {
        if (!bound.has(n.path[0])) free.add(n.path[0]);
      } else if (n.kind === 'for') {
        if (!bound.has(n.path[0])) free.add(n.path[0]);
        const inner = new Set(bound);
        inner.add(n.name);
        inner.add('loop');
        walk(n.body, inner);
        continue;
      } else if (n.kind === 'include') {
        includes.push(n.name);
        continue;
      }
      if (n.kind === 'if') {
        walk(n.then, bound);
        if (n.else !== null) walk(n.else, bound);
      }
    }
  };
  walk(nodes, new Set());
  return { free, includes };
}

/** For each template, its transitive free names (fixpoint over includes). */
function templateFreeNames(templates) {
  const direct = new Map();
  for (const [name, nodes] of templates) direct.set(name, templateDirectFree(nodes));
  const free = new Map();
  for (const [name, d] of direct) free.set(name, new Set(d.free));
  let changed = true;
  while (changed) {
    changed = false;
    for (const [name, d] of direct) {
      const f = free.get(name);
      for (const inc of d.includes) {
        const g = free.get(inc);
        if (g === undefined) continue;
        for (const x of g) if (!f.has(x)) { f.add(x); changed = true; }
      }
    }
  }
  return free;
}

/** Whether any loop frame in the scope chain (above the top frame) binds a case constant. */
function scopeShadowsConstants(scope) {
  let s = scope;
  while (s !== null && s.parent !== null) {
    for (const c of CASE_CONSTANTS) if (Object.hasOwn(s.vars, c)) return true;
    s = s.parent;
  }
  return false;
}

/** `nodes` rendered into `out` in `scope`. `ctx` holds the parsed templates and the HTML escape. */
function renderNodes(nodes, scope, ctx, depth, out) {
  for (const n of nodes) {
    switch (n.kind) {
      case 'text':
        out.push(n.text);
        break;
      case 'var': {
        const v = lookup(scope, n.path);
        out.push(typeof v === 'string' ? ctx.escape(v) : ctx.escape(textOf(v)));
        break;
      }
      case 'raw': {
        const v = lookup(scope, n.path);
        out.push(typeof v === 'string' ? v : textOf(v));
        break;
      }
      case 'if': {
        const v = truthy(lookup(scope, n.path));
        const branch = v !== n.not ? n.then : n.else;
        if (branch !== null) renderNodes(branch, scope, ctx, depth, out);
        break;
      }
      case 'for': {
        const xs = lookup(scope, n.path);
        if (!Array.isArray(xs)) break;
        for (let k = 0; k < xs.length; k++) {
          const vars = { [n.name]: xs[k], loop: { index: k + 1, first: k === 0, last: k === xs.length - 1, length: xs.length } };
          renderNodes(n.body, { vars, parent: scope }, ctx, depth, out);
        }
        break;
      }
      case 'include': {
        const t = ctx.templates.get(n.name);
        if (t !== undefined && depth < INCLUDE_DEPTH) {
          if (ctx.cacheable.has(n.name) && !scopeShadowsConstants(scope)) {
            const key = `${n.name}|${depth + 1}`;
            let s = ctx.cache.get(key);
            if (s === undefined) {
              const sub = [];
              renderNodes(t, scope, ctx, depth + 1, sub);
              s = sub.join('');
              ctx.cache.set(key, s);
            }
            out.push(s);
          } else {
            renderNodes(t, scope, ctx, depth + 1, out);
          }
        }
        break;
      }
    }
  }
}

// ---------------------------------------------------------------- build

/** One site's output tree: path -> text. */
export function run(input) {
  const slugCache = new Map();
  const slug = (t) => {
    let s = slugCache.get(t);
    if (s === undefined) { s = slugify(t); slugCache.set(t, s); }
    return s;
  };
  const dateCache = new Map();
  const long = (d) => {
    let s = dateCache.get(d);
    if (s === undefined) { s = longDate(d); dateCache.set(d, s); }
    return s;
  };
  const cardCache = new Map();

  const templates = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }

  const base = input.site.base_url.replace(/\/+$/, '');
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  let sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) sources.push({ path: f.path, text: f.content.includes('\r') ? f.content.replace(/\r\n?/g, '\n') : f.content });
    else statics.push({ path: f.path, content: f.content });
  }

  // Front matter, in source order, first failing check reported.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.bodyLines = fm.lines;
    s.bodyFrom = fm.bodyFrom;
    s.post = s.path.startsWith('posts/');
    const own = RESERVED.find((d) => d !== 'posts' && s.path.startsWith(`${d}/`));
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }
  sources = kept;

  // Permalinks: slug unique in its directory, in source order.
  const taken = new Map();
  const takenIn = (dir) => {
    if (!taken.has(dir)) taken.set(dir, new Set(dir === '' ? RESERVED : []));
    return taken.get(dir);
  };
  const bySource = new Map();
  for (const s of sources) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    s.slug = uniqueSlug(s.data.slug ?? slug(s.data.title), takenIn(dir));
    s.outDir = dir === '' ? s.slug : `${dir}/${s.slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // Markdown, its links resolved.
  const broken = new Set();
  const staticPaths = new Set(statics.map((f) => f.path));
  const SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:/;
  for (const s of sources) {
    const dir = dirOf(s.path);
    const env = {
      link: (target) => {
        if (SCHEME_RE.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePath(dir, rel);
        if (path !== null && bySource.has(path)) return `${bySource.get(path).url}${frag}`;
        if (path !== null && staticPaths.has(path)) return `${base}/${path}${frag}`;
        broken.add(`broken-link ${s.path} -> ${target}`);
        return target;
      },
    };
    const md = renderMarkdown(s.bodyLines, s.bodyFrom, env, slug);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // Collections: posts newest first, equal dates by slug.
  const posts = sources.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // Tags, grouped by slug, named as first met in collection order.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const sl = slug(name);
      if (!seen.has(sl)) { seen.add(sl); out.push(name); }
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const sl = slug(name);
      if (!bySlug.has(sl)) bySlug.set(sl, { name, slug: sl, url: `${base}/tags/${sl}/`, posts: [] });
      const tag = bySlug.get(sl);
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of sources) {
    if (!s.post) s.tagRefs = ownTags(s).map((name) => bySlug.get(slug(name)) ?? { name, slug: slug(name), url: '', posts: [] });
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : long(s.data.date) });

  function cardOf(s) {
    let c = cardCache.get(s);
    if (c === undefined) {
      c = {
        title: s.data.title,
        url: s.url,
        date: s.data.date ?? '',
        date_long: s.data.date === undefined ? '' : long(s.data.date),
        summary: s.data.summary ?? '',
        excerpt: s.excerpt,
        reading_minutes: Math.max(1, Math.ceil(wordsOfLines(s.bodyLines, s.bodyFrom) / 200)),
        tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
      };
      cardCache.set(s, c);
    }
    return c;
  }

  function pageOf(s) {
    return {
      ...cardOf(s),
      slug: s.slug,
      content: s.html,
      toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
      newer: linkOf(s.newer ?? null),
      older: linkOf(s.older ?? null),
      is_post: s.post,
    };
  }

  // Layouts.
  const output = {};
  const cards = new Map(posts.map((p) => [p, cardOf(p)]));
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const ctx = { templates, escape: escapeHtml, cache: new Map(), cacheable: new Set() };
  {
    const free = templateFreeNames(templates);
    for (const [name, f] of free) {
      let ok = true;
      for (const x of f) if (!CASE_CONSTANTS.includes(x)) { ok = false; break; }
      if (ok) ctx.cacheable.add(name);
    }
  }
  const render = (name, vars) => {
    const nodes = templates.get(name);
    if (nodes === undefined) return null;
    if (ctx.cacheable.has(name)) {
      const key = `${name}|0`;
      let s = ctx.cache.get(key);
      if (s === undefined) {
        const out = [];
        renderNodes(nodes, { vars: { site, tags: allTags, recent, ...vars }, parent: null }, ctx, 0, out);
        s = out.join('');
        ctx.cache.set(key, s);
      }
      return s;
    }
    const out = [];
    renderNodes(nodes, { vars: { site, tags: allTags, recent, ...vars }, parent: null }, ctx, 0, out);
    return out.join('');
  };
  for (const s of sources) output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  const tagOf = (t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) });
  for (const t of tags) {
    const html = render('tag', { tag: tagOf(t) });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // The report.
  const lines = [...report, ...broken].sort(byCodeUnits);
  const pageCount = sources.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output[REPORT_FILE] = `${lines.join('\n')}\n`;
  return output;
}
