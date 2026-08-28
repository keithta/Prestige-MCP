/**
 * Merge-field rendering and HTML sanitization.
 *
 * The DATABASE is authoritative for what actually gets sent (rendering happens
 * once, at materialization). This module mirrors that logic so the admin UI can
 * show an accurate preview, and so sanitization can run before content is
 * stored.
 */
import sanitizeHtml from 'sanitize-html';

export interface RenderContext {
  first_name?: string | null;
  last_name?: string | null;
  company?: string | null;
  job_title?: string | null;
  email?: string | null;
  phone?: string | null;
  [key: string]: unknown;
}

const PLACEHOLDER = /\{\{\s*([a-zA-Z0-9_.]+)\s*(?:\|([^}]*))?\}\}/;

export function htmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Replace {{field}} and {{field|default}} placeholders.
 *
 * Substitution is done one placeholder at a time against the *remaining* text,
 * so a value that itself contains "{{...}}" is never re-expanded -- a contact
 * named "{{admin_password}}" cannot read anything back out.
 */
export function renderTemplate(
  template: string | null | undefined,
  context: RenderContext,
  options: { escape?: boolean; system?: Record<string, string> } = {},
): string {
  if (!template) return '';
  const escape = options.escape ?? false;
  const system = options.system ?? {};

  let out = '';
  let rest = template;
  let guard = 0;

  while (guard++ < 1000) {
    const match = PLACEHOLDER.exec(rest);
    if (!match || match.index === undefined) break;

    const [token, key = '', fallback] = match;
    // System fields win over contact attributes, so a CSV column named
    // "unsubscribe_url" cannot hijack the real link.
    const raw = system[key] ?? context[key];
    const asString = raw === null || raw === undefined ? '' : String(raw);
    const value = asString.trim() === '' ? (fallback ?? '') : asString;

    out += rest.slice(0, match.index) + (escape ? htmlEscape(value) : value);
    rest = rest.slice(match.index + token.length);
  }
  return out + rest;
}

/** Which placeholders a template uses -- drives the UI's merge-field checker. */
export function extractPlaceholders(template: string | null | undefined): string[] {
  if (!template) return [];
  const found = new Set<string>();
  const re = new RegExp(PLACEHOLDER.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(template)) !== null) {
    if (m[1]) found.add(m[1]);
  }
  return [...found].sort();
}

/**
 * Allowlist-based sanitization applied before campaign HTML is stored.
 *
 * Campaign bodies are authored by trusted operators, but they are also
 * *rendered in the admin UI's preview*. Storing raw markup would turn a pasted
 * newsletter into stored XSS against the operator's own session.
 */
export function sanitizeEmailHtml(html: string | null | undefined): string {
  if (!html) return '';
  return sanitizeHtml(html, {
    allowedTags: [
      'a', 'b', 'blockquote', 'br', 'div', 'em', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
      'hr', 'i', 'img', 'li', 'ol', 'p', 'span', 'strong', 'table', 'tbody', 'td',
      'tfoot', 'th', 'thead', 'tr', 'u', 'ul', 'center', 'small', 'sub', 'sup',
    ],
    allowedAttributes: {
      a: ['href', 'name', 'target', 'rel', 'style'],
      img: ['src', 'alt', 'width', 'height', 'style'],
      '*': ['style', 'align', 'width', 'height', 'bgcolor', 'colspan', 'rowspan', 'class'],
    },
    // http/https/mailto only. Blocks javascript: and data: URIs.
    allowedSchemes: ['http', 'https', 'mailto'],
    allowedSchemesByTag: { img: ['http', 'https', 'cid'] },
    allowProtocolRelative: false,
    // Placeholders such as {{unsubscribe_url}} must survive sanitization intact.
    parser: { lowerCaseAttributeNames: false },
    transformTags: {
      a: (tagName, attribs) => ({
        tagName,
        attribs: { ...attribs, rel: 'noopener noreferrer' },
      }),
    },
  });
}

/** A plain-text alternative derived from HTML, for the multipart text part. */
export function htmlToPlainText(html: string | null | undefined): string {
  if (!html) return '';
  return sanitizeHtml(html, { allowedTags: [], allowedAttributes: {} })
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
