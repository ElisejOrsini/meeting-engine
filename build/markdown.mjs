// Markdown rendering for content files.
//
// Content may be written by people or by an AI agent working from meeting
// transcripts, so it is treated as untrusted:
//  - raw HTML in Markdown is shown as text, never rendered
//  - links may only use http(s), mailto, in-site routes (#/...), or files in
//    the meeting folder; anything else is shown as plain text
//  - images must be files in the meeting folder; others become links
//  - headings are shifted down so they fit under the section they appear in

import { Marked } from 'marked';

const SAFE_SCHEMES = new Set(['http:', 'https:', 'mailto:']);
const NAMED_ENTITIES = { colon: ':', tab: '\t', newline: '\n', amp: '&', sol: '/', quest: '?', num: '#' };

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

/** Decode the HTML character references a browser would decode in an href. */
function decodeEntities(value) {
  return value
    .replace(/&#x([0-9a-f]+);?/gi, (_, hex) => String.fromCodePoint(Math.min(parseInt(hex, 16), 0x10ffff)))
    .replace(/&#(\d+);?/g, (_, dec) => String.fromCodePoint(Math.min(parseInt(dec, 10), 0x10ffff)))
    .replace(/&([a-z]+);/gi, (match, name) => NAMED_ENTITIES[name.toLowerCase()] ?? match);
}

/**
 * Returns the URL scheme ("https:"), null for scheme-less URLs, or "unknown:"
 * when the start of the URL can't be understood safely.
 */
function schemeOf(href) {
  // Browsers decode entities in attributes and ignore whitespace/control
  // characters inside schemes ("java&#9;script:"), so do the same first.
  const cleaned = decodeEntities(String(href)).replace(/[\u0000- \u007f-\u009f]/g, '');
  const match = /^([a-z][a-z0-9+.-]*):/i.exec(cleaned);
  if (match) return match[1].toLowerCase() + ':';
  // An undecoded entity before the first / ? # could still hide a scheme.
  if (/&/.test(cleaned.split(/[/?#]/)[0])) return 'unknown:';
  return null;
}

/**
 * Classify a link target:
 *   'external'  http(s)/mailto, kept as is
 *   'route'     "#/..." link to another page of this site, kept as is
 *   'file'      relative path to a file in the meeting folder
 *   'blocked'   anything else (other schemes, "#anchors", "/absolute")
 */
export function classifyHref(href) {
  const scheme = schemeOf(href);
  if (scheme) return SAFE_SCHEMES.has(scheme) ? 'external' : 'blocked';
  if (href.startsWith('#/')) return 'route';
  if (href.startsWith('#') || href.startsWith('/') || href.startsWith('\\') || href === '') return 'blocked';
  return 'file';
}

/** Path of a relative link inside the meeting folder ("./a%20b.pdf?x" -> "a b.pdf"). */
export function fileLinkPath(href) {
  const withoutQuery = href.split(/[?#]/)[0].replace(/^(\.\/)+/, '');
  try {
    return decodeURI(withoutQuery);
  } catch {
    return withoutQuery;
  }
}

/**
 * Create a renderer.
 *   assetBase: prefix for file links (e.g. "content/2026-11-17-foo/")
 * block(src, { headingOffset, source }) renders a document; `source` is a label
 * (usually a file name) recorded with every file link, see `fileLinks`.
 */
export function createMarkdown({ assetBase = '' } = {}) {
  const fileLinks = [];
  let headingOffset = 0;
  let source = '';

  const md = new Marked({ gfm: true, breaks: false, async: false });
  md.use({
    // Turn off marked's HTML tokenizers, so "<" is always plain text. (Only
    // overriding the html renderer is not enough: after an inline <code> tag
    // marked passes later text through unescaped.) Returning undefined, not
    // false, means "no match" without falling back to the built-in tokenizer.
    tokenizer: {
      html() { return undefined; },
      tag() { return undefined; },
    },
    walkTokens(token) {
      if (token.type !== 'link' && token.type !== 'image') return;
      const href = String(token.href ?? '').trim();
      const kind = classifyHref(href);
      if (kind === 'blocked') {
        token.blocked = true;
      } else if (token.type === 'image' && kind !== 'file') {
        // Images from other websites could track who views the page, so
        // they are shown as links instead (the CSP also blocks them).
        token.asLink = true;
      } else if (kind === 'file') {
        fileLinks.push({ source, href, path: fileLinkPath(href) });
        token.href = assetBase + href.replace(/^(\.\/)+/, '');
      }
    },
    renderer: {
      html({ text }) {
        return escapeHtml(text);
      },
      heading({ tokens, depth }) {
        const level = Math.min(depth + headingOffset, 6);
        return `<h${level}>${this.parser.parseInline(tokens)}</h${level}>\n`;
      },
      link(token) {
        // Blocked links keep their text but lose the link.
        return token.blocked ? this.parser.parseInline(token.tokens) : false;
      },
      image(token) {
        if (token.blocked) return escapeHtml(token.text);
        if (token.asLink) return `<a href="${escapeHtml(token.href)}">${escapeHtml(token.text || token.href)}</a>`;
        return false;
      },
    },
  });

  function render(fn, src, options = {}) {
    if (!src) return '';
    headingOffset = options.headingOffset ?? 0;
    source = options.source ?? '';
    return fn(String(src));
  }

  return {
    block: (src, options) => render((s) => md.parse(s), src, options),
    inline: (src, options) => render((s) => md.parseInline(s), src, options),
    fileLinks,
  };
}
