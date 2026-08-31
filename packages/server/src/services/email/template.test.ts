/**
 * The email template.
 *
 * Emails are the one part of this system that leaves the building, so the
 * things asserted here are the things that would be embarrassing or dangerous
 * in somebody's inbox: an unescaped order name, a link to localhost, a
 * confident zero where a value was never set, and a plain-text part that is
 * unreadable because nobody looked at it.
 *
 * Run: npm test -w @opsflow/server
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { NotificationPriority } from '@opsflow/shared';
import { renderChangeEmail, renderEmail, escapeHtml, formatWhen, absoluteUrl } from './template.js';
import { config } from '../../config.js';

const writable = config as unknown as Record<string, unknown>;

function withBaseUrl<T>(url: string | undefined, fn: () => T): T {
  const saved = writable.APP_BASE_URL;
  writable.APP_BASE_URL = url;
  try { return fn(); } finally { writable.APP_BASE_URL = saved; }
}

const WHEN = new Date(2026, 7, 30, 16, 35); // 30 August 2026, 16:35 local

describe('a change email says what changed, who and when', () => {
  const email = renderChangeEmail({
    summary: 'Order PO 89-39: production quantity changed',
    orderLabel: 'PO 89-39 — Inter Shirt USA',
    actorName: 'Youssef Karim',
    when: WHEN,
    priority: NotificationPriority.NORMAL,
    fields: [{ label: 'Production quantity', oldValue: '300', newValue: '350' }],
    link: '/orders/abc?tab=production',
  });

  test('the subject names OpsFlow and the change, so an inbox list is scannable', () => {
    assert.equal(email.subject, 'OpsFlow – Order PO 89-39: production quantity changed');
  });

  test('the five facts are all in the HTML', () => {
    for (const expected of [
      'PO 89-39 — Inter Shirt USA', 'Youssef Karim',
      '30 August 2026 at 16:35', 'Production quantity', '300', '350',
    ]) {
      assert.ok(email.html.includes(escapeHtml(expected)), `missing from the HTML: ${expected}`);
    }
  });

  test('the plain-text part is readable on its own, not a stub', () => {
    assert.match(email.text, /OPSFLOW/);
    assert.match(email.text, /Changed by:\nYoussef Karim/);
    assert.match(email.text, /Production quantity\n  300  →  350/);
    assert.ok(!email.text.includes('<'), 'no markup leaks into the text part');
  });

  test('priority is stated in words, not only as a colour', () => {
    const urgent = renderChangeEmail({
      summary: 'Order PO 89-39 cancelled',
      orderLabel: 'PO 89-39', actorName: 'A', when: WHEN,
      priority: NotificationPriority.URGENT, fields: [], link: null,
    });
    assert.match(urgent.html, /Urgent/);
    assert.match(urgent.text, /Priority: Urgent/);
  });
});

describe('a value that was never set is not invented', () => {
  test('an unknown previous value says so instead of showing zero', () => {
    const email = renderChangeEmail({
      summary: 'Production recorded', orderLabel: 'PO 1', actorName: 'A', when: WHEN,
      priority: NotificationPriority.NORMAL,
      fields: [{ label: 'Quantity', oldValue: null, newValue: '150' }],
      link: null,
    });
    assert.match(email.html, /not set/);
    assert.ok(!/>0</.test(email.html), 'a zero must never stand in for "we do not know"');
    assert.match(email.text, /Quantity\n  not set  →  150/);
  });

  test('a cleared value says cleared', () => {
    const email = renderChangeEmail({
      summary: 'x', orderLabel: null, actorName: 'A', when: WHEN,
      priority: NotificationPriority.LOW,
      fields: [{ label: 'Tracking number', oldValue: 'AB123', newValue: null }],
      link: null,
    });
    assert.match(email.html, /cleared/);
  });
});

describe('what a coordinator typed cannot become markup', () => {
  test('an order name with angle brackets is escaped everywhere it appears', () => {
    const nasty = '<script>alert(1)</script>';
    const email = renderChangeEmail({
      summary: `Order ${nasty} updated`,
      orderLabel: nasty,
      actorName: nasty,
      when: WHEN,
      priority: NotificationPriority.NORMAL,
      fields: [{ label: nasty, oldValue: nasty, newValue: nasty }],
      link: null,
    });
    assert.ok(!email.html.includes('<script>'), 'script tag survived into the email body');
    assert.match(email.html, /&lt;script&gt;/);
  });

  test('an ampersand in a client name does not break the HTML', () => {
    const email = renderChangeEmail({
      summary: 'x', orderLabel: 'Smith & Sons', actorName: 'A', when: WHEN,
      priority: NotificationPriority.NORMAL, fields: [], link: null,
    });
    assert.match(email.html, /Smith &amp; Sons/);
  });

  test('escapeHtml covers the five characters that matter', () => {
    assert.equal(escapeHtml(`<>&"'`), '&lt;&gt;&amp;&quot;&#39;');
  });
});

describe('links', () => {
  test('no configured base URL means no button, rather than a guessed one', () => {
    withBaseUrl(undefined, () => {
      assert.equal(absoluteUrl('/orders/1'), null);
      const email = renderChangeEmail({
        summary: 'x', orderLabel: null, actorName: 'A', when: WHEN,
        priority: NotificationPriority.NORMAL, fields: [], link: '/orders/1',
      });
      // A link to localhost in somebody's inbox is worse than no link.
      assert.ok(!email.html.includes('Open in OpsFlow'));
    });
  });

  test('a configured base URL produces an absolute link', () => {
    withBaseUrl('https://opsflow.example.com/', () => {
      assert.equal(absoluteUrl('/orders/1?tab=production'), 'https://opsflow.example.com/orders/1?tab=production');
      const email = renderChangeEmail({
        summary: 'x', orderLabel: null, actorName: 'A', when: WHEN,
        priority: NotificationPriority.NORMAL, fields: [], link: '/orders/1',
      });
      assert.match(email.html, /https:\/\/opsflow\.example\.com\/orders\/1/);
      assert.match(email.text, /Open OpsFlow: https:\/\/opsflow\.example\.com\/orders\/1/);
    });
  });
});

describe('the shell is reusable, which is why it is a shell', () => {
  test('a message with no priority and no facts still renders', () => {
    const out = renderEmail({ subject: 'S', heading: 'H' });
    assert.equal(out.subject, 'S');
    assert.match(out.html, /<!doctype html>/i);
    // The heading sits on its own indented line, so this checks the text
    // rather than pretending to know the whitespace.
    assert.match(out.html, /<h1[^>]*>\s*H\s*<\/h1>/);
    assert.match(out.text, /^OPSFLOW/);
  });

  test('every message says why it arrived', () => {
    const out = renderEmail({ subject: 'S', heading: 'H' });
    assert.match(out.html, /Sent automatically by OpsFlow/);
    assert.match(out.text, /Sent automatically by OpsFlow/);
  });
});

describe('dates read the way the factory writes them', () => {
  test('day, month name, year and a 24-hour clock', () => {
    assert.equal(formatWhen(new Date(2026, 8, 5, 9, 4)), '5 September 2026 at 09:04');
  });
});
