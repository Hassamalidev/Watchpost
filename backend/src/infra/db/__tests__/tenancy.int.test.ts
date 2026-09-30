/*
 * Scope enforcement against real Postgres: a repository built on the tenancy helpers can never read,
 * change or create rows in another workspace, and refuses to run without a WorkspaceScope.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import { pgTable, text, uuid } from "drizzle-orm/pg-core";
import {
  createDb,
  createDbPool,
  createTenantRepository,
  tenantWhere,
  withWorkspace,
} from "../index.js";
import type { Db, DbPool } from "../index.js";
import {
  MissingScopeError,
  createWorkspaceScope,
  type WorkspaceScope,
} from "../../../core/workspace-scope.js";
import { newId } from "../../ids.js";
import { TEST_DATABASE_URL } from "../../../__tests__/helpers/test-env.js";

const tableName = `tenancy_test_${randomBytes(4).toString("hex")}`;
const items = pgTable(tableName, {
  id: uuid("id").primaryKey(),
  workspaceId: uuid("workspace_id").notNull(),
  name: text("name").notNull(),
});
const repo = createTenantRepository(items);

let pool: DbPool;
let db: Db;
const acme = createWorkspaceScope({ workspaceId: newId(), role: "admin" });
const globex = createWorkspaceScope({ workspaceId: newId(), role: "admin" });

beforeAll(async () => {
  pool = createDbPool(TEST_DATABASE_URL, { max: 2 });
  db = createDb(pool);
  await db.execute(
    sql.raw(
      `create table ${tableName} (id uuid primary key, workspace_id uuid not null, name text not null)`,
    ),
  );
});

afterAll(async () => {
  await db.execute(sql.raw(`drop table if exists ${tableName}`));
  await pool.end();
});

describe("WorkspaceScope", () => {
  it("is created only for valid workspace IDs and is frozen", () => {
    expect(() => createWorkspaceScope({ workspaceId: "acme" })).toThrow(MissingScopeError);
    expect(Object.isFrozen(acme)).toBe(true);
    expect(acme.role).toBe("admin");
  });
});

describe("tenant repository", () => {
  it("inserts with the scope's workspace, ignoring any workspaceId the caller passes", async () => {
    const row = await repo.insert(db, acme, {
      id: newId(),
      name: "API",
      ...({ workspaceId: globex.workspaceId } as object),
    });
    expect(row.workspaceId).toBe(acme.workspaceId);
  });

  it("never returns another workspace's rows", async () => {
    const mine = await repo.insert(db, acme, { id: newId(), name: "Website" });
    const theirs = await repo.insert(db, globex, { id: newId(), name: "Globex API" });

    expect(await repo.findById(db, acme, mine.id)).toMatchObject({ name: "Website" });
    expect(await repo.findById(db, acme, theirs.id)).toBeUndefined();

    const listed = await repo.list(db, acme);
    expect(listed.every((r) => r.workspaceId === acme.workspaceId)).toBe(true);
    expect(listed.map((r) => r.id)).not.toContain(theirs.id);
  });

  it("cannot update or delete another workspace's rows", async () => {
    const theirs = await repo.insert(db, globex, { id: newId(), name: "Globex DB" });

    expect(await repo.update(db, acme, theirs.id, { name: "hijacked" })).toBeUndefined();
    expect(await repo.delete(db, acme, theirs.id)).toBe(false);
    expect(await repo.findById(db, globex, theirs.id)).toMatchObject({ name: "Globex DB" });
  });

  it("cannot move a row to another workspace through update", async () => {
    const mine = await repo.insert(db, acme, { id: newId(), name: "Cron" });
    const updated = await repo.update(db, acme, mine.id, {
      name: "Cron job",
      ...({ workspaceId: globex.workspaceId } as object),
    });
    expect(updated).toMatchObject({ name: "Cron job", workspaceId: acme.workspaceId });
  });

  it("updates and deletes within the scope", async () => {
    const mine = await repo.insert(db, acme, { id: newId(), name: "Old" });
    expect(await repo.update(db, acme, mine.id, { name: "New" })).toMatchObject({ name: "New" });
    expect(await repo.delete(db, acme, mine.id)).toBe(true);
    expect(await repo.findById(db, acme, mine.id)).toBeUndefined();
  });

  it("refuses to run without a real scope", async () => {
    const fake = { workspaceId: acme.workspaceId } as unknown as WorkspaceScope;
    await expect(repo.list(db, fake)).rejects.toThrow(MissingScopeError);
    await expect(repo.list(db, undefined as unknown as WorkspaceScope)).rejects.toThrow(
      MissingScopeError,
    );
    expect(() => tenantWhere(null as unknown as WorkspaceScope, items)).toThrow(MissingScopeError);
    expect(() => withWorkspace({} as WorkspaceScope, { name: "x" })).toThrow(MissingScopeError);
  });

  it("works inside a transaction and rolls back with it", async () => {
    const id = newId();
    await expect(
      db.transaction(async (tx) => {
        await repo.insert(tx, acme, { id, name: "Tx row" });
        expect(await repo.findById(tx, acme, id)).toBeDefined();
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    expect(await repo.findById(db, acme, id)).toBeUndefined();
  });
});
