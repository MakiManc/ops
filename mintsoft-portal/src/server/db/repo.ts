/**
 * The only place that talks to D1.
 *
 * Everything above this layer works with typed rows and never builds SQL, which keeps
 * the site-scoping rules in one place instead of scattered through route handlers.
 * Multi-row writes that must all land or none use D1's batch(), which runs them in a
 * single transaction.
 */
import type { AuthenticatedUser, SiteRow, UserRow } from './types.ts'

export interface Database {
  prepare(query: string): D1PreparedStatement
  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>
}

export class Repository {
  constructor(private readonly db: Database) {}

  /**
   * Resolves a signed-in user by email.
   *
   * This is the allow-list. An email that is not in this table, or is here but
   * inactive, gets null and therefore gets no session — which is what lets sign-in be
   * open to any Google domain without being open to anyone.
   */
  async findActiveUserByEmail(email: string): Promise<AuthenticatedUser | null> {
    const user = await this.db
      .prepare(`SELECT id, email, name, role, active FROM users WHERE email = ? AND active = 1`)
      .bind(email.toLowerCase())
      .first<UserRow>()
    if (!user) return null
    return { ...user, siteIds: await this.siteIdsForUser(user.id) }
  }

  /** Same lookup by id, used on every request so a change of role takes effect at once. */
  async findActiveUserById(id: number): Promise<AuthenticatedUser | null> {
    const user = await this.db
      .prepare(`SELECT id, email, name, role, active FROM users WHERE id = ? AND active = 1`)
      .bind(id)
      .first<UserRow>()
    if (!user) return null
    return { ...user, siteIds: await this.siteIdsForUser(user.id) }
  }

  /**
   * The sites a GM may act for.
   *
   * Joined to `sites` on active = 1 deliberately. Without the join, closing a site
   * removes it from every list while still admitting requests for it — the guard and
   * the site list would disagree, and the guard is the one that decides. Deactivating
   * a site has to mean nobody can order for it, not merely that nobody can see it.
   */
  private async siteIdsForUser(userId: number): Promise<number[]> {
    const { results } = await this.db
      .prepare(
        `SELECT us.site_id FROM user_sites us
           JOIN sites s ON s.id = us.site_id AND s.active = 1
          WHERE us.user_id = ?`,
      )
      .bind(userId)
      .all<{ site_id: number }>()
    return (results ?? []).map((r) => r.site_id)
  }

  /** Whether a site exists and is open. Used by the site guard for unscoped roles. */
  async activeSiteExists(siteId: number): Promise<boolean> {
    const row = await this.db
      .prepare(`SELECT 1 AS ok FROM sites WHERE id = ? AND active = 1`)
      .bind(siteId)
      .first<{ ok: number }>()
    return Boolean(row)
  }

  async touchLastSeen(userId: number, at: string): Promise<void> {
    await this.db.prepare(`UPDATE users SET last_seen_at = ? WHERE id = ?`).bind(at, userId).run()
  }

  /**
   * The sites a user may act for.
   *
   * Approvers and admins see every active site. A GM sees only their linked sites —
   * and an unlinked GM sees none, which is the correct answer rather than an error.
   */
  async sitesVisibleTo(user: AuthenticatedUser): Promise<SiteRow[]> {
    if (user.role === 'gm') {
      if (user.siteIds.length === 0) return []
      const placeholders = user.siteIds.map(() => '?').join(', ')
      const { results } = await this.db
        .prepare(
          `SELECT id, code, name, type, cluster, recharge, min_days_between_orders, active
             FROM sites WHERE active = 1 AND id IN (${placeholders}) ORDER BY code`,
        )
        .bind(...user.siteIds)
        .all<SiteRow>()
      return results ?? []
    }

    const { results } = await this.db
      .prepare(
        `SELECT id, code, name, type, cluster, recharge, min_days_between_orders, active
           FROM sites WHERE active = 1 ORDER BY code`,
      )
      .all<SiteRow>()
    return results ?? []
  }
}
