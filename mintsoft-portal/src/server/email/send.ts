/**
 * Email, through Resend.
 *
 * Notifications here are best-effort and never block the thing they are telling people
 * about. An order that was approved has been approved whether or not the email left the
 * building, and throwing would roll back work that genuinely happened. Those failures are
 * recorded and shown on the sync health screen instead.
 *
 * ONE email is not a notification: `warehouseOrder` IS how an email-route order reaches
 * the people who pick it, the same way a Mintsoft order reaches Mercium. There,
 * `sent: false` has to stop the order being marked fulfilled, and orders/send.ts treats
 * it that way. Nothing in this file decides which kind a caller is making -- read the
 * caller.
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

export interface EmailResult {
  sent: boolean
  detail?: string
  /**
   * Whether we KNOW what happened, which only matters where the email is the order
   * rather than a note about one.
   *
   * 'sent'     -- Resend accepted it.
   * 'refused'  -- Resend answered and said no, or we never tried. Nothing went out, so a
   *               retry cannot duplicate anything.
   * 'unknown'  -- the request left but no answer came back. It may have been accepted.
   *               A retry here could put a second pick list in front of a picker, which
   *               is how a site gets twice the stock, so callers for whom this email IS
   *               the order must not treat it as a plain failure.
   */
  outcome: 'sent' | 'refused' | 'unknown'
}

export async function sendEmail(env: EmailEnv, email: Email): Promise<EmailResult> {
  if (!env.RESEND_API_KEY) {
    // Not an error: in development and before the key is set, the portal simply does
    // not email. Saying so is more useful than failing.
    return { sent: false, outcome: 'refused', detail: 'No RESEND_API_KEY set, so no email was sent.' }
  }
  const recipients = email.to.filter((t) => t.includes('@'))
  if (recipients.length === 0) return { sent: false, outcome: 'refused', detail: 'No valid recipients.' }

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
      //
      // A 5xx is Resend answering, so nothing was queued and a retry is safe -- the one
      // exception is 429, where the request was understood and shed rather than refused,
      // but Resend does not queue a rate-limited send either. Both are 'refused'.
      return { sent: false, outcome: 'refused', detail: `Resend returned HTTP ${res.status}.` }
    }
    return { sent: true, outcome: 'sent' }
  } catch (err) {
    // No answer came back. The request may well have been accepted before the connection
    // died, so this is deliberately not reported as a failure.
    return {
      sent: false,
      outcome: 'unknown',
      detail: `Could not reach Resend: ${err instanceof Error ? err.message : 'unknown'}`,
    }
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
  /**
   * The order this request was folded into, when the site already had one signed off and
   * waiting. Naming it matters: approving can combine the two, and an email about an
   * order number that no longer exists is worse than no email.
   */
  combinedInto?: string | null
}): Email => ({
  to: [],
  subject: o.combinedInto
    ? `Your stock request has been approved (${o.combinedInto})`
    : `Your stock request has been approved (${o.orderNumber})`,
  text: [
    `Your request for ${o.siteName} has been approved and is on its way to the warehouse.`,
    o.combinedInto
      ? `\nIt has been combined with ${o.siteName}'s other request that was waiting, so `
        + `everything comes in one delivery as order ${o.combinedInto}. Nothing was dropped.`
      : '',
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

/**
 * The pick list for an order the other warehouse fulfils.
 *
 * Not a notification. This email is the order: there is no WMS at that end, so if it
 * does not arrive, nothing is picked and nothing ships, however the portal looks. That
 * is why it states the quantities plainly, leads with what has to be picked, and carries
 * the order number the portal will use when anyone asks about it later.
 */
export const warehouseOrder = (env: EmailEnv, o: {
  orderNumber: string; siteName: string; siteCode: string
  requiredDate: string | null
  requesterName: string | null
  approvedBy: string | null
  notes: string | null
  deliveryAddress: string[]
  lines: { productName: string; qty: number; unit: string | null }[]
}): Email => {
  // null is "leave this line out"; '' is a deliberate blank line. Filtering on a plain
  // falsy test would collapse the blanks and run the address into the item list.
  const body: (string | null)[] = [
    `${o.siteName} (${o.siteCode}) needs the following picked and sent.`,
    'This stock is not held at Mercium, so there is no Mintsoft order for it — this email is the order.',
    '',
    'ITEMS',
    ...o.lines.map((l) => `  ${l.qty} x ${l.productName}${l.unit ? ` (${l.unit})` : ''}`),
    '',
    `Order number: ${o.orderNumber}`,
    `Needed by: ${o.requiredDate ?? 'not specified'}`,
    o.requesterName ? `Requested by: ${o.requesterName}` : null,
    o.approvedBy ? `Approved by: ${o.approvedBy}` : null,
    '',
    'DELIVER TO',
    ...(o.deliveryAddress.length > 0
      ? o.deliveryAddress.map((l) => `  ${l}`)
      : ['  No address on file for this site — check the portal before sending.']),
    o.notes ? '' : null,
    o.notes ? `Notes from the site:\n"${o.notes}"` : null,
    '',
    `The order is on the portal at ${portalLink(env)}.`,
  ]
  return {
    to: [],
    subject: `Stock order for ${o.siteName} — ${o.orderNumber}`,
    text: body.filter((l): l is string => l !== null).join('\n'),
  }
}

/** Everyone who should hear about a request waiting for sign-off. */
export async function approverEmails(db: {
  prepare(q: string): { all<T>(): Promise<{ results: T[] }> }
}): Promise<string[]> {
  const { results } = await db
    .prepare(`SELECT email FROM users WHERE role = 'approver' AND active = 1`)
    .all<{ email: string }>()
  return (results ?? []).map((r) => r.email)
}
