import { describe, expect, it } from 'vitest';
import {
  extractPlaceholders, htmlEscape, htmlToPlainText, renderTemplate, sanitizeEmailHtml,
} from '@campaign/core';

const contact = {
  first_name: 'Alice', last_name: 'Anderson', company: 'Acme',
  email: 'alice@example.com', job_title: null, phone: null,
};

describe('renderTemplate', () => {
  it('substitutes contact fields', () => {
    expect(renderTemplate('Hi {{first_name}} at {{company}}', contact)).toBe('Hi Alice at Acme');
  });

  it('uses the default when a field is missing or blank', () => {
    expect(renderTemplate('Hi {{first_name|there}}', { first_name: null })).toBe('Hi there');
    expect(renderTemplate('Hi {{first_name|there}}', { first_name: '   ' })).toBe('Hi there');
    expect(renderTemplate('Hi {{nickname|friend}}', contact)).toBe('Hi friend');
  });

  it('leaves an unknown field with no default as empty', () => {
    expect(renderTemplate('Hi {{nope}}!', contact)).toBe('Hi !');
  });

  it('escapes substituted values when rendering HTML', () => {
    const hostile = { first_name: '<script>alert(1)</script>' };
    const out = renderTemplate('<p>Hi {{first_name}}</p>', hostile, { escape: true });
    expect(out).toBe('<p>Hi &lt;script&gt;alert(1)&lt;/script&gt;</p>');
    expect(out).not.toContain('<script>');
  });

  // A contact whose name is itself a placeholder must not be able to read
  // anything back out of the template engine.
  it('does not re-expand a substituted value', () => {
    const sneaky = { first_name: '{{company}}', company: 'SECRET' };
    expect(renderTemplate('Hi {{first_name}}', sneaky)).toBe('Hi {{company}}');
  });

  it('lets system fields win over a contact attribute of the same name', () => {
    const spoofed = { first_name: 'Alice', unsubscribe_url: 'https://evil.example/steal' };
    const out = renderTemplate('{{unsubscribe_url}}', spoofed, {
      system: { unsubscribe_url: 'https://real.example/u/abc' },
    });
    expect(out).toBe('https://real.example/u/abc');
  });

  it('handles an empty or missing template', () => {
    expect(renderTemplate(null, contact)).toBe('');
    expect(renderTemplate('', contact)).toBe('');
  });

  it('renders many placeholders without falling into a loop', () => {
    const template = Array.from({ length: 100 }, (_, i) => `{{f${i}|x}}`).join(' ');
    expect(renderTemplate(template, {})).toBe(Array(100).fill('x').join(' '));
  });
});

describe('extractPlaceholders', () => {
  it('lists the distinct fields a template uses', () => {
    expect(extractPlaceholders('{{a}} {{b|d}} {{a}}')).toEqual(['a', 'b']);
  });
});

describe('sanitizeEmailHtml', () => {
  it('strips script tags', () => {
    expect(sanitizeEmailHtml('<p>ok</p><script>alert(1)</script>')).toBe('<p>ok</p>');
  });

  it('strips inline event handlers', () => {
    expect(sanitizeEmailHtml('<p onclick="steal()">hi</p>')).toBe('<p>hi</p>');
  });

  it('strips javascript: and data: URIs', () => {
    expect(sanitizeEmailHtml('<a href="javascript:alert(1)">x</a>')).not.toContain('javascript:');
    expect(sanitizeEmailHtml('<a href="data:text/html,<script>">x</a>')).not.toContain('data:');
  });

  it('keeps ordinary formatting and links', () => {
    const out = sanitizeEmailHtml('<p><strong>Hi</strong> <a href="https://x.example">link</a></p>');
    expect(out).toContain('<strong>Hi</strong>');
    expect(out).toContain('https://x.example');
    expect(out).toContain('rel="noopener noreferrer"');
  });

  it('preserves merge-field placeholders intact', () => {
    expect(sanitizeEmailHtml('<a href="{{unsubscribe_url}}">Unsubscribe</a>'))
      .toContain('{{unsubscribe_url}}');
  });
});

describe('htmlToPlainText', () => {
  it('produces a readable text alternative', () => {
    expect(htmlToPlainText('<p>Hello <strong>there</strong></p>')).toBe('Hello there');
  });
});

describe('htmlEscape', () => {
  it('escapes every character that could break out of markup', () => {
    expect(htmlEscape(`<>&"'`)).toBe('&lt;&gt;&amp;&quot;&#39;');
  });
});
