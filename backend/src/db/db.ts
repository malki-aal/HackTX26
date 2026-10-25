// SQLite persistence using Node's built-in node:sqlite driver (no native build step).
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { MIGRATIONS } from "./migrations.js";

export type Db = DatabaseSync;

export function openDatabase(path: string): Db {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
  migrate(db);
  return db;
}

export function migrate(db: Db): void {
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
  const applied = new Set((db.prepare("SELECT version FROM schema_migrations").all() as Array<{ version: number }>).map((r) => r.version));
  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue;
    tx(db, () => {
      db.exec(m.sql);
      db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(m.version, new Date().toISOString());
    });
  }
}

/**
 * Run fn inside an IMMEDIATE transaction (takes the write lock up front so concurrent
 * reservations serialize). Never call network code inside fn.
 */
export function tx<T>(db: Db, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const r = fn();
    db.exec("COMMIT");
    return r;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

export const nowIso = () => new Date().toISOString();

export function json<T>(s: unknown): T {
  return JSON.parse(String(s)) as T;
}
