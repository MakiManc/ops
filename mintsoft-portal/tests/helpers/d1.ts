/**
 * A small D1 stand-in backed by node:sqlite.
 *
 * D1 is SQLite with a particular async wrapper around it, so running the real
 * migration and the real queries against real SQLite exercises the actual constraints
 * and the actual SQL. Mocking the database instead would test our mocks.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { DatabaseSync, type StatementSync } from 'node:sqlite'

/**
 * Every migration, in the order wrangler would apply them. Reading the directory rather
 * than naming files means a new migration is covered by the tests the day it is written,
 * instead of the day someone remembers to add it here.
 */
const MIGRATIONS_DIR = new URL('../../migrations/', import.meta.url)
const MIGRATION = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((f) => readFileSync(new URL(f, MIGRATIONS_DIR), 'utf8'))
  .join('\n')

// Uint8Array is here for photo bytes: D1 stores them as a BLOB, and node:sqlite binds
// and returns them as Uint8Array, so the stand-in has to carry them through unchanged.
type Value = string | number | null | Uint8Array

class FakeStatement {
  private bound: Value[] = []
  constructor(private readonly stmt: StatementSync) {}

  bind(...values: unknown[]) {
    this.bound = values as Value[]
    return this
  }

  async first<T>(): Promise<T | null> {
    return (this.stmt.get(...(this.bound as never[])) as T) ?? null
  }

  async all<T>(): Promise<{ results: T[]; success: true }> {
    return { results: this.stmt.all(...(this.bound as never[])) as T[], success: true }
  }

  async run() {
    // changes is what an atomic claim turns on: a conditional UPDATE that matches no row
    // is how the loser of a race learns it lost. Returning a fixed shape without it made
    // every claim look successful, so the stand-in has to carry it.
    const result = this.stmt.run(...(this.bound as never[]))
    return {
      success: true as const,
      results: [],
      meta: { changes: Number(result.changes ?? 0) },
    }
  }
}

export class FakeD1 {
  readonly sqlite: DatabaseSync

  constructor() {
    this.sqlite = new DatabaseSync(':memory:')
    this.sqlite.exec('PRAGMA foreign_keys = ON')
    this.sqlite.exec(MIGRATION)
  }

  prepare(query: string) {
    return new FakeStatement(this.sqlite.prepare(query))
  }

  /** D1 runs a batch as one transaction; so does this. */
  async batch<T = unknown>(statements: { run(): Promise<unknown> }[]) {
    this.sqlite.exec('BEGIN')
    try {
      const out = []
      for (const s of statements) out.push(await s.run())
      this.sqlite.exec('COMMIT')
      return out as T[]
    } catch (err) {
      this.sqlite.exec('ROLLBACK')
      throw err
    }
  }

  exec(sql: string) { this.sqlite.exec(sql) }
}

/** Seeds the three roles Phase 1 has to prove, plus two sites. */
export function seedRoles(db: FakeD1) {
  db.exec(`
    INSERT INTO sites (id, code, name, type) VALUES
      (1, 'M9', 'Leith Walk', 'restaurant'),
      (2, 'M19', 'Fountainbridge', 'restaurant');
    INSERT INTO sites (id, code, name, type, recharge) VALUES
      (3, 'MAF1', 'Franchise One', 'franchise', 1);

    INSERT INTO users (id, email, name, role) VALUES
      (1, 'gm.m9@example.com', 'GM at M9', 'gm'),
      (2, 'approver@example.com', 'Francheska', 'approver'),
      (3, 'admin@example.com', 'Ross', 'admin'),
      (4, 'unlinked.gm@example.com', 'GM with no sites', 'gm'),
      (5, 'former.gm@example.com', 'Left the company', 'gm');

    UPDATE users SET active = 0 WHERE id = 5;

    INSERT INTO user_sites (user_id, site_id) VALUES (1, 1), (5, 1);
  `)
}
