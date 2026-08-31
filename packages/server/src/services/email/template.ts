/**
 * The OpsFlow email template.
 *
 * One renderer, reusable for everything the system will eventually send:
 * change notifications now, daily summaries, delivery-risk warnings and
 * shortage alerts later. `renderEmail` is the shell — header, priority band,
 * body blocks, footer — and the specific messages are thin functions on top of
 * it, so a change to the house style is one edit rather than six.
 *
 * Written as plain string building with no template engine, for the same
 * reason the Graph client uses `fetch`: this needs no dependency, and a
 * dependency here would be one more thing to keep current for the sake of
 * concatenating strings.
 *
 * Every message is rendered twice, HTML and plain text. Outlook renders the
 * HTML; a phone with images off, a screen reader, and anybody who has turned
 * HTML mail off entirely get the text part, and it has to be readable on its
 * own rather than a fallback nobody checked.
 */

import { PRIORITY_STYLE, type NotificationPriority } from '@opsflow/shared';
import { config } from '../../config.js';

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

/** One labelled before/after pair, already formatted for reading. */
export interface EmailField {
  label: string;
  oldValue: string | null;
  newValue: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Escaping
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Everything interpolated into the HTML goes through this.
 *
 * The values in these emails come from the database, and the database contains
 * whatever a coordinator typed — including an order name with an ampersand in
 * it, and in principle a client name somebody chose to make trouble with.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/** "30 August 2026 at 16:35". No timezone name — the factory has one. */
export function formatWhen(d: Date): string {
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()} at ${hh}:${mm}`;
}

/**
 * A link back into OpsFlow, or nothing.
 *
 * `APP_BASE_URL` is unset by default and the email simply omits the button
 * rather than guessing at a hostname. A link to `localhost` in somebody's inbox
 * is worse than no link.
 */
export function absoluteUrl(path: string | null): string | null {
  if (!path || !config.APP_BASE_URL) return null;
  return `${config.APP_BASE_URL.replace(/\/+$/, '')}${path.startsWith('/') ? path : `/${path}`}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// The shell
// ─────────────────────────────────────────────────────────────────────────────

export interface EmailShell {
  subject: string;
  /** Big line at the top of the message. */
  heading: string;
  priority?: NotificationPriority;
  /** Label/value rows shown as a definition list. */
  facts?: Array<{ label: string; value: string }>;
  /** Pre-built HTML for the middle of the message. Must already be escaped. */
  bodyHtml?: string;
  /** The same content as plain text. */
  bodyText?: string;
  action?: { label: string; url: string } | null;
}

export function renderEmail(shell: EmailShell): RenderedEmail {
  const tone = shell.priority ? PRIORITY_STYLE[shell.priority] : null;

  const facts = (shell.facts ?? [])
    .map(
      (f) => `
        <tr>
          <td style="padding:6px 16px 6px 0;color:#64748b;font-size:13px;vertical-align:top;white-space:nowrap;">
            ${escapeHtml(f.label)}
          </td>
          <td style="padding:6px 0;color:#0f172a;font-size:14px;font-weight:600;">
            ${escapeHtml(f.value)}
          </td>
        </tr>`,
    )
    .join('');

  const action = shell.action
    ? `
      <tr><td style="padding:24px 24px 0;">
        <a href="${escapeHtml(shell.action.url)}"
           style="display:inline-block;background:#1e40af;color:#ffffff;text-decoration:none;
                  padding:10px 18px;border-radius:6px;font-size:14px;font-weight:600;">
          ${escapeHtml(shell.action.label)}
        </a>
      </td></tr>`
    : '';

  const priorityBand = tone
    ? `
      <tr><td style="background:${tone.emailColor};height:4px;line-height:4px;font-size:0;">&nbsp;</td></tr>`
    : '';

  const priorityChip = tone
    ? `<span style="display:inline-block;background:${tone.emailColor};color:#ffffff;
                    border-radius:999px;padding:2px 10px;font-size:11px;font-weight:700;
                    text-transform:uppercase;letter-spacing:.04em;">${tone.label}</span>`
    : '';

  const html = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(shell.subject)}</title></head>
<body style="margin:0;padding:0;background:#f1f5f9;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
         style="background:#f1f5f9;padding:24px 12px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
             style="max-width:600px;background:#ffffff;border-radius:10px;overflow:hidden;
                    border:1px solid #e2e8f0;">
        ${priorityBand}
        <tr><td style="padding:20px 24px 0;">
          <span style="font-size:13px;font-weight:800;letter-spacing:.12em;color:#1e40af;">OPSFLOW</span>
          ${priorityChip ? `<span style="float:right;">${priorityChip}</span>` : ''}
        </td></tr>
        <tr><td style="padding:12px 24px 0;">
          <h1 style="margin:0;font-size:19px;line-height:1.35;color:#0f172a;font-weight:600;">
            ${escapeHtml(shell.heading)}
          </h1>
        </td></tr>
        ${facts ? `<tr><td style="padding:14px 24px 0;"><table role="presentation" cellpadding="0" cellspacing="0">${facts}</table></td></tr>` : ''}
        ${shell.bodyHtml ? `<tr><td style="padding:18px 24px 0;">${shell.bodyHtml}</td></tr>` : ''}
        ${action}
        <tr><td style="padding:24px;">
          <hr style="border:none;border-top:1px solid #e2e8f0;margin:0 0 12px;">
          <p style="margin:0;color:#94a3b8;font-size:12px;line-height:1.5;">
            Sent automatically by OpsFlow because a change was recorded in the system.
            You are receiving this as an active OpsFlow user.
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

  const textFacts = (shell.facts ?? []).map((f) => `${f.label}:\n${f.value}\n`).join('\n');
  const text = [
    'OPSFLOW',
    '',
    shell.heading,
    shell.priority ? `\nPriority: ${PRIORITY_STYLE[shell.priority].label}` : '',
    textFacts ? `\n${textFacts}` : '',
    shell.bodyText ? `\n${shell.bodyText}` : '',
    shell.action ? `\nOpen OpsFlow: ${shell.action.url}` : '',
    '',
    '—',
    'Sent automatically by OpsFlow because a change was recorded in the system.',
  ].filter((s) => s !== '').join('\n');

  return { subject: shell.subject, html, text };
}

// ─────────────────────────────────────────────────────────────────────────────
// The change notification
// ─────────────────────────────────────────────────────────────────────────────

export interface ChangeEmailInput {
  summary: string;
  orderLabel: string | null;
  actorName: string;
  when: Date;
  priority: NotificationPriority;
  fields: EmailField[];
  /** App-relative path, turned absolute only if APP_BASE_URL is set. */
  link: string | null;
}

/**
 * One email for one user action, however many fields it touched.
 *
 * The before/after pairs are a table rather than a sentence because that is how
 * they are read: the eye goes down the left column looking for the field it
 * cares about. A "previous → new" row with a genuinely unknown old value says
 * "not set" rather than inventing a plausible one.
 */
export function renderChangeEmail(input: ChangeEmailInput): RenderedEmail {
  const url = absoluteUrl(input.link);

  const rows = input.fields
    .map((f) => {
      const before = f.oldValue ?? '<em style="color:#94a3b8;font-style:italic;">not set</em>';
      const after = f.newValue ?? '<em style="color:#94a3b8;font-style:italic;">cleared</em>';
      return `
        <tr>
          <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;color:#334155;font-size:13px;vertical-align:top;">
            ${escapeHtml(f.label)}
          </td>
          <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;color:#64748b;font-size:13px;vertical-align:top;">
            ${f.oldValue ? escapeHtml(f.oldValue) : before}
          </td>
          <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;color:#0f172a;font-size:13px;font-weight:600;vertical-align:top;">
            ${f.newValue ? escapeHtml(f.newValue) : after}
          </td>
        </tr>`;
    })
    .join('');

  const bodyHtml = rows
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"
              style="border:1px solid #e2e8f0;border-radius:6px;border-collapse:separate;">
         <tr style="background:#f8fafc;">
           <th align="left" style="padding:8px 12px;border-bottom:1px solid #e2e8f0;font-size:11px;
                                   text-transform:uppercase;letter-spacing:.06em;color:#64748b;">What</th>
           <th align="left" style="padding:8px 12px;border-bottom:1px solid #e2e8f0;font-size:11px;
                                   text-transform:uppercase;letter-spacing:.06em;color:#64748b;">Previous</th>
           <th align="left" style="padding:8px 12px;border-bottom:1px solid #e2e8f0;font-size:11px;
                                   text-transform:uppercase;letter-spacing:.06em;color:#64748b;">New</th>
         </tr>
         ${rows}
       </table>`
    : '';

  const bodyText = input.fields
    .map((f) => `${f.label}\n  ${f.oldValue ?? 'not set'}  →  ${f.newValue ?? 'cleared'}`)
    .join('\n');

  const facts: Array<{ label: string; value: string }> = [];
  if (input.orderLabel) facts.push({ label: 'Order', value: input.orderLabel });
  facts.push({ label: 'Changed by', value: input.actorName });
  facts.push({ label: 'Date', value: formatWhen(input.when) });

  return renderEmail({
    subject: `OpsFlow – ${input.summary}`,
    heading: input.summary,
    priority: input.priority,
    facts,
    bodyHtml,
    bodyText,
    action: url ? { label: 'Open in OpsFlow', url } : null,
  });
}

/**
 * A one-off test message, for confirming that Microsoft Graph is wired up.
 *
 * Deliberately says what it is, so nobody who receives one by accident thinks
 * something in the factory has gone wrong.
 */
export function renderTestEmail(triggeredBy: string): RenderedEmail {
  return renderEmail({
    subject: 'OpsFlow – email delivery test',
    heading: 'OpsFlow can send email through Microsoft 365',
    facts: [
      { label: 'Requested by', value: triggeredBy },
      { label: 'Date', value: formatWhen(new Date()) },
      { label: 'Sender mailbox', value: config.MICROSOFT_SENDER_EMAIL || '(not configured)' },
    ],
    bodyHtml:
      '<p style="margin:0;color:#334155;font-size:14px;line-height:1.55;">' +
      'This is a test, not a change in the factory. Nothing has been altered in any order. ' +
      'If you are reading this in Outlook, the Microsoft Graph configuration is correct and ' +
      'change notifications will arrive the same way.</p>',
    bodyText:
      'This is a test, not a change in the factory. Nothing has been altered in any order. ' +
      'If you are reading this in Outlook, the Microsoft Graph configuration is correct.',
    action: absoluteUrl('/') ? { label: 'Open OpsFlow', url: absoluteUrl('/')! } : null,
  });
}
