/** Row shapes as the database returns them. SQLite gives booleans back as 0 or 1. */

export type Role = 'gm' | 'approver' | 'admin'

/**
 * Who may sign an order off.
 *
 * Roles deliberately do not nest in general — an approver is not an admin, and cannot
 * reach the admin screens. This is the one deliberate exception: an administrator can
 * do everything an approver can, because in practice Ross is the fallback when
 * Francheska is away and an order sitting unapproved costs a site its stock.
 *
 * Kept as one exported predicate rather than repeated `role === 'approver'` checks, so
 * the set of people who can commit stock is a single thing to read and to change. The
 * audit trail still records WHICH role signed each order off, so "an admin approved it"
 * stays visible afterwards rather than being flattened into "approved".
 */
export const APPROVING_ROLES = ['approver', 'admin'] as const

export const canApprove = (role: Role | null): boolean =>
  role !== null && (APPROVING_ROLES as readonly string[]).includes(role)
export type SiteType = 'restaurant' | 'factory' | 'franchise'
export type StockType = 'internal' | 'expansion'
export type OrderType = 'replenishment' | 'expansion'

/** No 'delivered': Mintsoft's order record cannot confirm an arrival. */
export type OrderStatus =
  | 'draft' | 'submitted' | 'approved' | 'posted' | 'despatched'
  | 'rejected' | 'cancelled' | 'post_failed'

export interface UserRow {
  id: number
  email: string
  name: string
  role: Role
  active: number
}

export interface SiteRow {
  id: number
  code: string
  name: string
  type: SiteType
  cluster: string | null
  recharge: number
  min_days_between_orders: number | null
  active: number
}

/** A signed-in user, with the sites they may act for already resolved. */
export interface AuthenticatedUser {
  id: number
  email: string
  name: string
  role: Role
  /** Site ids a GM is linked to. Empty for approvers and admins, who are not scoped. */
  siteIds: number[]
}
