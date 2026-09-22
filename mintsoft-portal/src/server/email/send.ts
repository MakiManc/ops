/**
 * Email, through Resend.
 *
 * Every send is best-effort and never blocks the thing it is telling people about. An
 * order that was approved has been approved whether or not the email left the building,
 * and throwing here would roll back work that genuinely happened. Failures are recorded
 * and shown on the sync health screen instead.
 */

export interface EmailEnv {
  RESEND_API_KEY?: string
  /** Who the portal sends as. Falls back to a sensible default if unset. */
  PORTAL_FROM_EMAIL?: string
  /** Where the portal lives, for links in the email. */
  PORTAL_URL?: string
}

export interface Email {
  to: string[]
  subject: string
  /** Plain text. These are short, operational notes, not marketing. */
  text: string
}

export interface EmailResult { sent: boolean; detail?: string }

export async function sendEmail(env: EmailEnv, email: Email): Promise<EmailResult> {
  if (!env.RESEND_API_KEY) {
    // Not an error: in development and before the key is set, the portal simply does
    // not email. Saying so is more useful than failing.
    return { sent: false, detail: 'No RESEND_API_KEY set, so no email was sent.' }
  }
  const recipients = email.to.filter((t) => t.includes('@'))
  if (recipients.length === 0) return { sent: false, detail: 'No valid recipients.' }

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: env.PORTAL_FROM_EMAIL ?? 'Maki Ordering <ordering@makiramen.co.uk>',
        to: recipients,
        subject: email.subject,
        text: email.text,
      }),
    })
    if (!res.ok) {
      // The body can echo recipient addresses, so only the status is recorded.
      return { sent: false, detail: `Resend returned HTTP ${res.status}.` }
    }
    return { sent: true }
  } catch (err) {
    return { sent: false, detail: `Could not reach Resend: ${err instanceof Error ? err.message : 'unknown'}` }
  }
}

const portalLink = (env: EmailEnv) => env.PORTAL_URL ?? 'the ordering portal'

/** A request is waiting for sign-off. Goes to the approvers. */
export const requestSubmitted = (env: EmailEnv, o: {
  orderNumber: string; siteName: string; requesterName: string; lineCount: number
  earlyOrderReason: string | null
}): Email => ({
  to: [],
  subject: `${o.siteName} has requested stock (${o.orderNumber})`,
  text: [
    `${o.requesterName} at ${o.siteName} has asked for ${o.lineCount} item${o.lineCount === 1 ? '' : 's'}.`,
    o.earlyOrderReason
      ? `\nThis is inside the site's usual gap between orders. Reason given:\n"${o.earlyOrderReason}"`
      : '',
    `\nSign it off at ${portalLink(env)}.`,
  ].filter(Boolean).join('\n'),
})

/** A request has been approved. Goes to the site. */
export const requestApproved = (env: EmailEnv, o: {
  orderNumber: string; siteName: string; changed: boolean
}): Email => ({
  to: [],
  subject: `Your stock request has been approved (${o.orderNumber})`,
  text: [
    `Your request for ${o.siteName} has been approved and is on its way to the warehouse.`,
    o.changed
      ? '\nSome quantities were changed. Open the portal to see what was approved.'
      : '',
    `\nTrack it at ${portalLink(env)}.`,
  ].filter(Boolean).join('\n'),
})

/** A request has been sent back. Goes to the site, with the reason. */
export const requestRejected = (env: EmailEnv, o: {
  orderNumber: string; siteName: string; reason: string
}): Email => ({
  to: [],
  subject: `Your stock request needs another look (${o.orderNumber})`,
  text:
    `Your request for ${o.siteName} has been sent back.\n\n` +
    `Reason given:\n"${o.reason}"\n\n` +
    `You can change it and submit again at ${portalLink(env)}.`,
})

/** An order failed to reach the warehouse. Goes to the approvers, not the site. */
export const postFailed = (env: EmailEnv, o: {
  orderNumber: string; siteName: string; reason: string
}): Email => ({
  to: [],
  subject: `Order ${o.orderNumber} did not reach Mercium`,
  text:
    `${o.siteName}'s order ${o.orderNumber} was approved but could not be sent.\n\n` +
    `What happened:\n${o.reason}\n\n` +
    `The site has not been told. Check it at ${portalLink(env)}.`,
})

/** Everyone who should hear about a request waiting for sign-off. */
export async function approverEmails(db: {
  prepare(q: string): { all<T>(): Promise<{ results: T[] }> }
}): Promise<string[]> {
  const { results } = await db
    .prepare(`SELECT email FROM users WHERE role = 'approver' AND active = 1`)
    .all<{ email: string }>()
  return (results ?? []).map((r) => r.email)
}
