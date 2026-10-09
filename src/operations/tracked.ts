import { eq, getTableColumns, getTableName, sql, type InferInsertModel, type InferSelectModel } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import type { RowChange } from "@/db/schema";
import type { Db } from "@/db/types";

// Tracked writes: the only way an operation changes data. Each one
// snapshots the affected row before and after (as Postgres's own to_jsonb),
// and the runtime stores those snapshots in the command log. Undo is then
// generic — restore `before` for every change — so no operation has to
// write, or can forget to write, its own undo.
//
// Only tables with a single `id` primary key can be tracked. Database-side
// side effects (ON DELETE CASCADE / SET NULL, triggers) are NOT captured: an
// operation that would trigger one must make those changes itself, through
// these helpers, before the delete.

type TrackedTable = PgTable & { id: PgColumn };
type Row = Record<string, unknown>;

export class NotFoundError extends Error {}

async function snapshot(db: Db, table: TrackedTable, id: string): Promise<Row | null> {
  // `to_jsonb("table")` is a whole-row reference: the full row as JSON in
  // Postgres's own representation, exactly what jsonb_populate_record takes
  // back on undo.
  const [found] = await db
    .select({ row: sql<Row>`to_jsonb(${table})` })
    .from(table)
    .where(eq(table.id, id))
    .limit(1);
  return found?.row ?? null;
}

export class WriteContext {
  readonly changes: RowChange[] = [];

  // `db` is the open transaction. Operations use it for reads; the lint rule
  // in eslint.config.mjs keeps writes on the tracked methods below.
  constructor(readonly db: Db) {}

  async insert<T extends TrackedTable>(table: T, values: InferInsertModel<T>): Promise<InferSelectModel<T>> {
    const [row] = (await this.db.insert(table).values(values as never).returning()) as InferSelectModel<T>[];
    const id = (row as { id: string }).id;
    this.changes.push({ table: getTableName(table), id, before: null, after: await snapshot(this.db, table, id) });
    return row;
  }

  async update<T extends TrackedTable>(
    table: T,
    id: string,
    set: Partial<InferInsertModel<T>>,
  ): Promise<InferSelectModel<T>> {
    const before = await snapshot(this.db, table, id);
    if (!before) throw new NotFoundError(`${getTableName(table)} ${id} not found`);
    const [row] = (await this.db.update(table).set(set as never).where(eq(table.id, id)).returning()) as InferSelectModel<T>[];
    this.changes.push({ table: getTableName(table), id, before, after: await snapshot(this.db, table, id) });
    return row;
  }

  async remove(table: TrackedTable, id: string): Promise<void> {
    const before = await snapshot(this.db, table, id);
    if (!before) throw new NotFoundError(`${getTableName(table)} ${id} not found`);
    await this.db.delete(table).where(eq(table.id, id));
    this.changes.push({ table: getTableName(table), id, before, after: null });
  }
}

// ---------------------------------------------------------------------------
// Undo support, used by the runtime.
// ---------------------------------------------------------------------------

export async function currentRow(db: Db, table: TrackedTable, id: string): Promise<Row | null> {
  return snapshot(db, table, id);
}

/** Puts a row back to `target` (null = absent), whatever its current state. */
export async function restoreRow(db: Db, table: TrackedTable, id: string, target: Row | null): Promise<void> {
  const exists = (await snapshot(db, table, id)) !== null;
  if (target === null) {
    if (exists) await db.delete(table).where(eq(table.id, id));
    return;
  }
  const record = sql`jsonb_populate_record(null::${table}, ${JSON.stringify(target)}::jsonb)`;
  if (!exists) {
    await db.execute(sql`insert into ${table} select * from ${record}`);
    return;
  }
  const columns = Object.values(getTableColumns(table))
    .map((c) => c.name)
    .filter((name) => name !== "id");
  const list = sql.join(
    columns.map((c) => sql.identifier(c)),
    sql`, `,
  );
  await db.execute(sql`update ${table} set (${list}) = (select ${list} from ${record}) where ${table.id} = ${id}`);
}

/** Order-insensitive comparison of two row snapshots. */
export function sameRow(a: Row | null, b: Row | null): boolean {
  return stable(a) === stable(b);
}

function stable(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  const entries = Object.entries(value as Row).sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(",")}}`;
}
