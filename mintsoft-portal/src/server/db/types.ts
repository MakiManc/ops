/** Row shapes as the database returns them. SQLite gives booleans back as 0 or 1. */

export type Role = 'gm' | 'approver' | 'admin'
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
