// Tiny helpers for building HTML safely.
//
//   html`<p>${userText}</p>`   escapes userText
//   html`<div>${raw(trustedHtml)}</div>`   inserts pre-rendered HTML as-is
//
// Only HTML produced by the build step (Markdown rendered with raw HTML
// disabled) may be passed to raw().

class SafeHtml {
  constructor(value) {
    this.value = value;
  }
  toString() {
    return this.value;
  }
}

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

export function raw(value) {
  return new SafeHtml(String(value ?? ''));
}

function format(value) {
  if (value instanceof SafeHtml) return value.value;
  if (Array.isArray(value)) return value.map(format).join('');
  if (value === null || value === undefined || value === false) return '';
  return escapeHtml(value);
}

export function html(strings, ...values) {
  let out = strings[0];
  for (let i = 0; i < values.length; i += 1) out += format(values[i]) + strings[i + 1];
  return new SafeHtml(out);
}

/** Build a hash link: link('m', id, 'pre') -> "#/m/<id>/pre". */
export function link(...parts) {
  return '#/' + parts.filter((p) => p !== undefined && p !== '').map(encodeURIComponent).join('/');
}
