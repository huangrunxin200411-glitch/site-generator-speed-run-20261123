// A faster drop-in for makefun-site 1.0.0: the same build, byte for byte, written
// from the README's rules with the reference as the oracle. One ES module,
// no dependencies. run(input) returns the output tree { path: text }.
//
// Shape of the work: sources are read once into line arrays (no re-splitting),
// Markdown is lexed and rendered in a single pass over those lines, inline
// markup is rendered with bulk escaping instead of one regex per character,
// slugs are memoised per build, and templates render into a parts array.

const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// ---------------------------------------------------------------- text

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** Append `s` with & < > " ' escaped, in bulk (no per-character regex). */
function escInto(out, s) {
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '&' || c === '<' || c === '>' || c === '"' || c === "'") {
      if (i > start) out.push(s.slice(start, i));
      out.push(ESCAPES[c]);
      start = i + 1;
    }
  }
  if (start < s.length) out.push(s.slice(start));
}

/** `text` with & < > " and ' escaped. */
function escapeHtml(text) {
  if (!/[&<>"']/.test(text)) return text;
  const out = [];
  escInto(out, text);
  return out.join('');
}

const SLUG_MAX = 64;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** Per-build slug cache: slugify is pure, and tag names repeat constantly. */
let slugCache = null;

function slugify(text) {
  const hit = slugCache.get(text);
  if (hit !== undefined) return hit;
  const plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
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
  out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
  const slug = out === '' ? 'untitled' : out;
  slugCache.set(text, slug);
  return slug;
}

function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

function longDate(date) {
  const [y, m, d] = date.split('-');
  return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
}

/** Words of the body lines: runs of characters other than whitespace (JS \s set). */
function wordsOfLines(lines, start) {
  let count = 0;
  let inWord = false;
  for (let i = start; i < lines.length; i++) {
    const line = lines[i];
    for (let j = 0; j < line.length; j++) {
      const c = line.charCodeAt(j);
      let ws;
      if (c === 32) ws = true;
      else if (c > 32 && c < 127) ws = false;
      else {
        ws =
          c === 9 || c === 11 || c === 12 || c === 13 ||
          c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) ||
          c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f ||
          c === 0x3000 || c === 0xfeff;
      }
      if (ws) inWord = false;
      else if (!inWord) {
        inWord = true;
        count++;
      }
    }
    inWord = false;
  }
  return count;
}

// ---------------------------------------------------------------- front matter

const FM_KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];
const FM_LINE = /^([a-z_]+):(?: (.*))?$/;
const FM_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const FM_NAME = /^[a-z0-9-]+$/;
const FM_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FM_TAG = /^[^"[\]]+$/;

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

function stringOf(raw) {
  if (raw.startsWith('"')) {
    if (raw.length < 2 || !raw.endsWith('"')) return { error: 'a quoted string is not closed' };
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
  if (raw.startsWith('[')) return { error: 'a bare string opens on [' };
  return { value: raw };
}

function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = FM_DATE.exec(raw);
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
      if (tags.some((t) => t === '' || !FM_TAG.test(t))) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return FM_NAME.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return FM_SLUG.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * Parse `lines` (already split on '\n') as front matter: { data, bodyStart } with
 * bodyStart the index of the first body line, or { error }.
 */
function parseFrontMatter(lines) {
  if (lines[0] !== '---') return { error: 'no front matter' };
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') {
      close = i;
      break;
    }
  }
  if (close === -1) return { error: 'the front matter is not closed' };
  const data = {};
  for (let i = 1; i < close; i++) {
    const line = lines[i];
    if (/^[ \t]*$/.test(line) || line.startsWith('#')) continue;
    const m = FM_LINE.exec(line);
    if (!m) return { error: `line ${i + 1} is not "key: value"` };
    const key = m[1];
    const raw = (m[2] ?? '').replace(/[ \t]+$/, '');
    if (!FM_KEYS.includes(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, bodyStart: close + 1 };
}

// ---------------------------------------------------------------- markdown

// Block detection, done by hand: the per-line regexes were the hottest cost
// in the block scan, and every one of them is a short first-character test.
function isBlank(line) {
  for (let k = 0; k < line.length; k++) {
    const c = line.charCodeAt(k);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** The fence language when `line` opens a fence, else null. */
function fenceLang(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let k = 3;
  const start = k;
  while (k < line.length) {
    const c = line.charCodeAt(k);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) k++;
    else break;
  }
  const lang = line.slice(start, k);
  while (k < line.length) {
    const c = line.charCodeAt(k);
    if (c !== 32 && c !== 9) return null;
    k++;
  }
  return lang;
}

/** Whether `line` closes a fence. */
function fenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let k = 3; k < line.length; k++) {
    const c = line.charCodeAt(k);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A heading line's level and text, or null (a heading's text is never empty). */
function headingOf(line) {
  let hashes = 0;
  while (hashes < line.length && line.charCodeAt(hashes) === 35) hashes++;
  if (hashes === 0 || hashes > 6 || hashes >= line.length) return null;
  const c = line.charCodeAt(hashes);
  if (c !== 32 && c !== 9) return null;
  let k = hashes;
  while (k < line.length && (line.charCodeAt(k) === 32 || line.charCodeAt(k) === 9)) k++;
  let end = line.length;
  while (end > k && (line.charCodeAt(end - 1) === 32 || line.charCodeAt(end - 1) === 9)) end--;
  if (end === k) return null;
  return { depth: hashes, text: line.slice(k, end) };
}

/** Whether `line` is a thematic break. */
function isHr(line) {
  if (line.length < 3) return false;
  const a = line.charCodeAt(0);
  const b = line.charCodeAt(1);
  const c = line.charCodeAt(2);
  if (!((a === 45 && b === 45 && c === 45) || (a === 42 && b === 42 && c === 42))) return false;
  for (let k = 3; k < line.length; k++) {
    const ch = line.charCodeAt(k);
    if (ch !== 32 && ch !== 9) return false;
  }
  return true;
}

/** Whether `line` starts a bullet item; the item text is line.slice(2). */
function isBullet(line) {
  const c = line.charCodeAt(0);
  return (c === 45 || c === 42) && line.charCodeAt(1) === 32;
}

/** An ordered item's [number, text] when `line` starts one, else null. */
function orderedOf(line) {
  let k = 0;
  while (k < line.length && line.charCodeAt(k) >= 48 && line.charCodeAt(k) <= 57) k++;
  if (k === 0 || k > 9) return null;
  if (line.charCodeAt(k) !== 46 || line.charCodeAt(k + 1) !== 32) return null;
  return [Number(line.slice(0, k)), line.slice(k + 2)];
}

/** Whether `line` continues a list item (two or more spaces, then a non-space). */
function isContinued(line) {
  let k = 0;
  while (k < line.length && line.charCodeAt(k) === 32) k++;
  if (k < 2 || k >= line.length) return false;
  const c = line.charCodeAt(k);
  if (c > 32 && c < 127) return true;
  return !(c === 9 || c === 11 || c === 12 || c === 13 || c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff);
}

/** Whether `line` ends a paragraph: a blank line, a fence, a heading or a thematic break. */
function endsParagraph(line) {
  return isBlank(line) || fenceLang(line) !== null || headingOf(line) !== null || isHr(line);
}

/** A line with spaces and tabs at either end dropped. */
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

function findUnescaped(s, what, from) {
  for (let j = from; j <= s.length - what.length; j++) {
    if (s[j] === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (c !== '*') continue;
    if (s[j + 1] === '*') {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

const INLINE_SPECIAL = /[\\`*\[&<>"']/g;

/**
 * `s` rendered inline into `out` (an array of string parts); `env.link(target)`
 * resolves a link's href. A native regex scan jumps from one markup character
 * to the next, so plain runs are appended whole; only the markup characters
 * are handled one at a time. The shared regex is re-entrant: lastIndex is
 * reset before every exec, so a nested call cannot corrupt the outer scan.
 */
function inlineInto(s, env, out) {
  let i = 0;
  INLINE_SPECIAL.lastIndex = 0;
  let m;
  while ((m = INLINE_SPECIAL.exec(s)) !== null) {
    const j = m.index;
    if (j > i) out.push(s.slice(i, j));
    const c = s[j];
    if (c === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
      escInto(out, s[j + 1]);
      i = j + 2;
    } else if (c === '`') {
      const k = s.indexOf('`', j + 1);
      if (k > j + 1) {
        out.push('<code>');
        escInto(out, s.slice(j + 1, k));
        out.push('</code>');
        i = k + 1;
      } else {
        out.push('`');
        i = j + 1;
      }
    } else if (c === '*') {
      if (s[j + 1] === '*') {
        const k = findUnescaped(s, '**', j + 2);
        if (k > j + 2) {
          out.push('<strong>');
          inlineInto(s.slice(j + 2, k), env, out);
          out.push('</strong>');
          i = k + 2;
        } else {
          out.push('**');
          i = j + 2;
        }
      } else {
        const k = findSingleStar(s, j + 1);
        if (k > j + 1) {
          out.push('<em>');
          inlineInto(s.slice(j + 1, k), env, out);
          out.push('</em>');
          i = k + 1;
        } else {
          out.push('*');
          i = j + 1;
        }
      }
    } else if (c === '[') {
      const k = findUnescaped(s, ']', j + 1);
      const p = k !== -1 && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
      const target = p === -1 ? '' : s.slice(k + 2, p);
      if (target !== '' && !/\s/.test(target)) {
        out.push('<a href="');
        escInto(out, env.link(target));
        out.push('">');
        inlineInto(s.slice(j + 1, k), env, out);
        out.push('</a>');
        i = p + 1;
      } else {
        out.push('[');
        i = j + 1;
      }
    } else {
      out.push(ESCAPES[c]);
      i = j + 1;
    }
    INLINE_SPECIAL.lastIndex = i;
  }
  if (i < s.length) out.push(s.slice(i));
}

/** `s` rendered inline, as a string. */
function inline(s, env) {
  const out = [];
  inlineInto(s, env, out);
  return out.join('');
}

/**
 * Render `lines[start..]` (the body) in one pass into a single parts array:
 * { html, toc, excerpt }. Blocks are rendered as they are scanned; no token
 * array and no per-block string are built. The heading's and first
 * paragraph's inline HTML are recovered by slicing the parts they filled.
 */
function renderMarkdown(lines, start, env) {
  const ids = new Set();
  const parts = [];
  const toc = [];
  let excerpt = null;
  let i = start;
  const n = lines.length;
  while (i < n) {
    const line = lines[i];
    if (isBlank(line)) {
      i++;
      continue;
    }
    const lang = fenceLang(line);
    if (lang !== null) {
      i++;
      parts.push('<pre><code');
      if (lang !== '') {
        parts.push(' class="language-');
        escInto(parts, lang);
        parts.push('"');
      }
      parts.push('>');
      while (i < n && !fenceClose(lines[i])) {
        escInto(parts, lines[i]);
        parts.push('\n');
        i++;
      }
      i++;
      parts.push('</code></pre>', '\n');
      continue;
    }
    const heading = headingOf(line);
    if (heading !== null) {
      const id = uniqueSlug(slugify(heading.text), ids);
      parts.push(`<h${heading.depth} id="${id}">`);
      const hStart = parts.length;
      inlineInto(heading.text, env, parts);
      const hEnd = parts.length;
      parts.push(`</h${heading.depth}>`, '\n');
      if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html: parts.slice(hStart, hEnd).join('') });
      i++;
      continue;
    }
    if (isHr(line)) {
      parts.push('<hr>', '\n');
      i++;
      continue;
    }
    if (line.startsWith('>')) {
      const body = [];
      while (i < n && lines[i].startsWith('>')) {
        const l = lines[i++];
        body.push(l.charCodeAt(1) === 32 ? l.slice(2) : l.slice(1));
      }
      const inner = body.map(trimLine).filter((l) => l !== '');
      if (inner.length === 0) parts.push('<blockquote>\n</blockquote>', '\n');
      else {
        parts.push('<blockquote>\n<p>');
        inlineInto(inner.join('\n'), env, parts);
        parts.push('</p>\n</blockquote>', '\n');
      }
      continue;
    }
    const bullet = isBullet(line);
    const ordered = bullet ? null : orderedOf(line);
    if (bullet || ordered !== null) {
      const isOrdered = ordered !== null;
      const items = [];
      while (i < n) {
        const l = lines[i];
        if (isOrdered) {
          const m = orderedOf(l);
          if (m !== null) {
            items.push([trimLine(m[1])]);
            i++;
            continue;
          }
        } else if (isBullet(l)) {
          items.push([trimLine(l.slice(2))]);
          i++;
          continue;
        }
        if (isContinued(l)) {
          items[items.length - 1].push(trimLine(l));
          i++;
        } else break;
      }
      const tag = isOrdered ? 'ol' : 'ul';
      const startNum = isOrdered ? ordered[0] : 1;
      parts.push(isOrdered && startNum !== 1 ? `<ol start="${startNum}">` : `<${tag}>`, '\n');
      for (const item of items) {
        parts.push('<li>');
        inlineInto(item.join('\n'), env, parts);
        parts.push('</li>\n');
      }
      parts.push(`</${tag}>`, '\n');
      continue;
    }
    const body = [trimLine(line)];
    i++;
    while (i < n && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    parts.push('<p>');
    const pStart = parts.length;
    inlineInto(body.join('\n'), env, parts);
    const pEnd = parts.length;
    parts.push('</p>', '\n');
    if (excerpt === null) excerpt = parts.slice(pStart, pEnd).join('');
  }
  return { html: parts.join(''), toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- templates

const INCLUDE_DEPTH = 8;
const TMPL_PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const TMPL_FOR = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const TMPL_IF = /^if (not )?(\S+)$/;
const TMPL_INCLUDE = /^include "([a-z0-9-]+)"$/;

class TemplateError extends Error {}

function pathOf(name, text) {
  if (!TMPL_PATH.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

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
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
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
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/**
 * `src` parsed into a flat op tree (arrays, integer opcodes: 0 text, 1 var,
 * 2 raw, 3 if, 4 for, 5 include, 6 root). A TemplateError when it does not
 * parse. Flat ops keep the render loop's dispatch on integers.
 */
function parseTemplate(name, src) {
  const root = [6, []];
  const stack = [root];
  const bodyOf = (frame) => (frame[0] === 6 ? frame[1] : frame[0] === 4 ? frame[3] : frame[4] ?? frame[3]);
  let body = root[1];
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push([0, tok.text]);
    else if (tok.t === 'var' || tok.t === 'raw') body.push([tok.t === 'var' ? 1 : 2, tok.path]);
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = TMPL_FOR.exec(tag)) !== null) {
        const node = [4, m[1], pathOf(name, m[2]), []];
        body.push(node);
        stack.push(node);
        body = node[3];
      } else if ((m = TMPL_IF.exec(tag)) !== null) {
        const node = [3, m[1] !== undefined, pathOf(name, m[2]), [], null];
        body.push(node);
        stack.push(node);
        body = node[3];
      } else if (tag === 'else') {
        if (top[0] !== 3 || top[4] !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top[4] = [];
        body = top[4];
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top[0] !== (tag === 'endfor' ? 4 : 3)) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        body = bodyOf(stack[stack.length - 1]);
      } else if ((m = TMPL_INCLUDE.exec(tag)) !== null) body.push([5, m[1]]);
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) {
    const top = stack[stack.length - 1];
    throw new TemplateError(`template "${name}": a ${top[0] === 4 ? 'for' : 'if'} is not closed`);
  }
  return root[1];
}

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

function textOf(v, out) {
  if (typeof v === 'string') out.push(v);
  else if (typeof v === 'number') out.push(String(v));
  else if (typeof v === 'boolean') out.push(v ? 'true' : 'false');
  else if (Array.isArray(v)) {
    for (let k = 0; k < v.length; k++) {
      if (k > 0) out.push(', ');
      textOf(v[k], out);
    }
  }
}

function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

function renderNodes(ops, scope, ctx, depth, out) {
  for (let k = 0; k < ops.length; k++) {
    const n = ops[k];
    switch (n[0]) {
      case 0:
        out.push(n[1]);
        break;
      case 1: {
        const v = lookup(scope, n[1]);
        if (typeof v === 'string') {
          if (v !== '') escInto(out, v);
        } else {
          const parts = [];
          textOf(v, parts);
          const s = parts.join('');
          if (s !== '') escInto(out, s);
        }
        break;
      }
      case 2: {
        const v = lookup(scope, n[1]);
        if (typeof v === 'string') out.push(v);
        else textOf(v, out);
        break;
      }
      case 3: {
        const v = truthy(lookup(scope, n[2]));
        const branch = v !== n[1] ? n[3] : n[4];
        if (branch !== null) renderNodes(branch, scope, ctx, depth, out);
        break;
      }
      case 4: {
        const xs = lookup(scope, n[2]);
        if (!Array.isArray(xs)) break;
        // One vars object and one loop object per activation, mutated per item:
        // rendering is synchronous, so no iteration can observe a later state.
        const loop = { index: 1, first: true, last: xs.length === 1, length: xs.length };
        const vars = { loop };
        const child = { vars, parent: scope };
        for (let j = 0; j < xs.length; j++) {
          vars[n[1]] = xs[j];
          vars.loop = loop;
          loop.index = j + 1;
          loop.first = j === 0;
          loop.last = j === xs.length - 1;
          renderNodes(n[3], child, ctx, depth, out);
        }
        break;
      }
      case 5: {
        const t = ctx.templates.get(n[1]);
        if (t !== undefined && depth < INCLUDE_DEPTH) renderNodes(t, scope, ctx, depth + 1, out);
        break;
      }
    }
  }
}

// ---------------------------------------------------------------- build

const RESERVED = ['posts', 'tags', 'page'];

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

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

/** One site's output tree: path -> text. */
export function run(input) {
  slugCache = new Map();
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
  const b = {
    input,
    base,
    templates,
    sources: [],
    statics: [],
    bySource: new Map(),
    broken: new Set(),
    report,
    posts: [],
    tags: [],
    cards: new Map(),
    output: {},
  };

  // 1. Sources, in code-unit order of path; .md line ends made "\n".
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      const text = f.content.includes('\r') ? f.content.replace(/\r\n?/g, '\n') : f.content;
      const lines = text.split('\n');
      b.sources.push({ path: f.path, lines });
    } else b.statics.push({ path: f.path, content: f.content });
  }

  // 2. Front matter, in order: refused, reserved dir, post without date, no layout, draft.
  {
    const kept = [];
    for (const s of b.sources) {
      const fm = parseFrontMatter(s.lines);
      if ('error' in fm) {
        b.report.push(`refused ${s.path}: ${fm.error}`);
        continue;
      }
      s.data = fm.data;
      s.bodyStart = fm.bodyStart;
      s.post = s.path.startsWith('posts/');
      const own = s.path.startsWith('tags/') ? 'tags' : s.path.startsWith('page/') ? 'page' : undefined;
      if (own !== undefined) {
        b.report.push(`refused ${s.path}: ${own}/ is the generator's own`);
        continue;
      }
      if (s.post && !Object.hasOwn(s.data, 'date')) {
        b.report.push(`refused ${s.path}: a post needs a date`);
        continue;
      }
      const layout = s.data.layout ?? (s.post ? 'post' : 'page');
      if (!b.templates.has(layout)) {
        b.report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
        continue;
      }
      s.layout = layout;
      if (s.data.draft === true) {
        b.report.push(`draft ${s.path}`);
        continue;
      }
      kept.push(s);
    }
    b.sources = kept;
  }

  // 3. Permalinks: slug unique in its directory, in source order.
  {
    const taken = new Map();
    const takenIn = (dir) => {
      if (!taken.has(dir)) taken.set(dir, new Set(dir === '' ? RESERVED : []));
      return taken.get(dir);
    };
    for (const s of b.sources) {
      const dir = s.post ? 'posts' : dirOf(s.path);
      const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), takenIn(dir));
      s.slug = slug;
      s.outDir = dir === '' ? slug : `${dir}/${slug}`;
      s.url = `${b.base}/${s.outDir}/`;
      b.bySource.set(s.path, s);
    }
  }

  // 4. Markdown, links resolved to pages and static files.
  {
    const staticPaths = new Set(b.statics.map((f) => f.path));
    for (const s of b.sources) {
      const dir = dirOf(s.path);
      const env = {
        link: (target) => {
          if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
          const hash = target.indexOf('#');
          const rel = hash === -1 ? target : target.slice(0, hash);
          const frag = hash === -1 ? '' : target.slice(hash);
          const path = rel === '' ? null : resolvePath(dir, rel);
          if (path !== null && b.bySource.has(path)) return `${b.bySource.get(path).url}${frag}`;
          if (path !== null && staticPaths.has(path)) return `${b.base}/${path}${frag}`;
          b.broken.add(`broken-link ${s.path} -> ${target}`);
          return target;
        },
      };
      const md = renderMarkdown(s.lines, s.bodyStart, env);
      s.html = md.html;
      s.toc = md.toc;
      s.excerpt = md.excerpt;
    }
  }

  // 5. Collections: posts newest first, equal dates by slug.
  {
    const posts = b.sources.filter((s) => s.post);
    posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
    b.posts = posts;
    posts.forEach((p, k) => {
      p.newer = k === 0 ? null : posts[k - 1];
      p.older = k === posts.length - 1 ? null : posts[k + 1];
    });
  }

  // 6. Tags.
  {
    const bySlug = new Map();
    const ownTags = (s) => {
      const seen = new Set();
      const out = [];
      for (const name of s.data.tags ?? []) {
        const slug = slugify(name);
        if (seen.has(slug)) continue;
        seen.add(slug);
        out.push(name);
      }
      return out;
    };
    for (const p of b.posts) {
      p.tagRefs = [];
      for (const name of ownTags(p)) {
        const slug = slugify(name);
        if (!bySlug.has(slug)) {
        const tag = { name, slug, url: `${b.base}/tags/${slug}/`, posts: [] };
        tag.view = { name, slug, url: tag.url };
        bySlug.set(slug, tag);
      }
        const tag = bySlug.get(slug);
        tag.posts.push(p);
        p.tagRefs.push(tag);
      }
    }
    for (const s of b.sources) {
      if (!s.post) {
        s.tagRefs = ownTags(s).map((name) => {
          const slug = slugify(name);
          const found = bySlug.get(slug);
          if (found) return found;
          const tag = { name, slug, url: '', posts: [] };
          tag.view = { name, slug, url: '' };
          return tag;
        });
      }
    }
    b.tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));
  }

  // 7. Layouts.
  const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });
  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsOfLines(s.lines, s.bodyStart) / 200)),
    tags: s.tagRefs.map((t) => t.view),
  });
  {
    b.cards = new Map(b.posts.map((p) => [p, cardOf(p)]));
    const site = { title: b.input.site.title, base_url: b.base };
    const allTags = b.tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
    const recent = b.posts.slice(0, b.input.site.recent).map((p) => b.cards.get(p));
    // Includes inlined at parse depth: an include renders its target at depth
    // + 1 only while the current depth is below 8, and if/for do not change
    // depth, so expanding each (template, depth) once removes every include
    // call from rendering. Depth strictly increases per expansion, so cycles
    // terminate at depth 8 with the include dropped.
    // (Constant folding of site/tags/recent was tried here and reverted:
    // an interleaved A/B showed it 14% slower — the unrolling and Map work
    // at expansion cost more than the ops it removes at render.)
    const expandedCache = new Map();
    const expandList = (ops, depth) => {
      const out = [];
      // Adjacent text ops (common across include boundaries) merge into one.
      const pushOp = (op) => {
        if (op[0] === 0) {
          const last = out[out.length - 1];
          if (last !== undefined && last[0] === 0) out[out.length - 1] = [0, last[1] + op[1]];
          else out.push(op);
        } else {
          out.push(op);
        }
      };
      for (const op of ops) {
        const k = op[0];
        if (k === 5) {
          if (depth < INCLUDE_DEPTH) {
            const inner = expandTemplate(op[1], depth + 1);
            if (inner !== null) for (const iop of inner) pushOp(iop);
          }
        } else if (k === 3) {
          pushOp([3, op[1], op[2], expandList(op[3], depth), op[4] === null ? null : expandList(op[4], depth)]);
        } else if (k === 4) {
          pushOp([4, op[1], op[2], expandList(op[3], depth)]);
        } else {
          pushOp(op);
        }
      }
      return out;
    };
    const expandTemplate = (name, depth) => {
      const key = `${name}\n${depth}`;
      let hit = expandedCache.get(key);
      if (hit === undefined) {
        const ops = b.templates.get(name);
        if (ops === undefined) return null;
        hit = expandList(ops, depth);
        expandedCache.set(key, hit);
      }
      return hit;
    };
    const ctx = { templates: b.templates };
    // One scope per render kind, its varying field mutated per call: the
    // reference builds a fresh vars object per render, but rendering is
    // synchronous and each kind's fields are overwritten before every use,
    // so no render can observe another's values.
    const pageScope = { vars: { site, tags: allTags, recent }, parent: null };
    const indexScope = { vars: { site, tags: allTags, recent }, parent: null };
    const tagScope = { vars: { site, tags: allTags, recent }, parent: null };
    const tagsScope = { vars: { site, tags: allTags, recent }, parent: null };
    const render = (name, scope) => {
      const nodes = expandTemplate(name, 0);
      if (nodes === null) return null;
      const out = [];
      renderNodes(nodes, scope, ctx, 0, out);
      return out.join('');
    };
    const pageOf = (s) => {
      const card = b.cards.get(s) ?? cardOf(s);
      return {
        title: card.title,
        url: card.url,
        date: card.date,
        date_long: card.date_long,
        summary: card.summary,
        excerpt: card.excerpt,
        reading_minutes: card.reading_minutes,
        tags: card.tags,
        slug: s.slug,
        content: s.html,
        toc: s.toc,
        newer: linkOf(s.newer ?? null),
        older: linkOf(s.older ?? null),
        is_post: s.post,
      };
    };
    for (const s of b.sources) {
      pageScope.vars.page = pageOf(s);
      b.output[`${s.outDir}/index.html`] = render(s.layout, pageScope);
    }
    const per = b.input.site.per_page;
    const pages = Math.max(1, Math.ceil(b.posts.length / per));
    const indexUrl = (k) => (k === 1 ? `${b.base}/` : `${b.base}/page/${k}/`);
    for (let k = 1; k <= pages; k++) {
      indexScope.vars.posts = b.posts.slice((k - 1) * per, k * per).map((p) => b.cards.get(p));
      indexScope.vars.pager = { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) };
      const html = render('index', indexScope);
      if (html !== null) b.output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
    }
    for (const t of b.tags) {
      tagScope.vars.tag = { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => b.cards.get(p)) };
      const html = render('tag', tagScope);
      if (html !== null) b.output[`tags/${t.slug}/index.html`] = html;
    }
    const tagsHtml = render('tags', tagsScope);
    if (tagsHtml !== null) b.output['tags/index.html'] = tagsHtml;
    for (const f of b.statics) {
      if (Object.hasOwn(b.output, f.path)) b.report.push(`shadowed ${f.path}: a built page has its path`);
      else b.output[f.path] = f.content;
    }
  }

  // 8. The report.
  {
    const lines = [...b.report, ...b.broken].sort(byCodeUnits);
    const pages = b.sources.filter((s) => !s.post).length;
    lines.push(`built ${pages} pages, ${b.posts.length} posts, ${b.tags.length} tags and ${b.statics.length} static files`);
    b.output['build-report.txt'] = `${lines.join('\n')}\n`;
  }

  slugCache = null;
  return b.output;
}
