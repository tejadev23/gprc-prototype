import { boolean, index, integer, jsonb, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";

export const users = pgTable("users", {
  id: uuid("id").primaryKey(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  lastProjectId: uuid("last_project_id"),
});

export const sessions = pgTable("sessions", {
  tokenHash: text("token_hash").primaryKey(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const loginAttempts = pgTable(
  "login_attempts",
  {
    id: uuid("id").primaryKey(),
    ip: text("ip").notNull(),
    email: text("email").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("login_attempts_window").on(table.ip, table.createdAt)],
);

export const projects = pgTable(
  "projects",
  {
    id: uuid("id").primaryKey(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
    schemaVersion: integer("schema_version").notNull().default(1),
    revision: integer("revision").notNull().default(1),
    activeStationId: text("active_station_id"),
    pageNumber: integer("page_number").notNull().default(1),
    documentName: text("document_name"),
    documentStored: boolean("document_stored").notNull().default(false),
    visibility: jsonb("visibility").notNull(),
    dockTab: text("dock_tab").notNull(),
    snap: boolean("snap").notNull().default(false),
    stations: jsonb("stations").notNull(),
  },
  (table) => [index("projects_owner").on(table.ownerId)],
);

export const gprcRecords = pgTable("gprc_records", {
  projectId: uuid("project_id")
    .primaryKey()
    .references(() => projects.id, { onDelete: "cascade" }),
  record: jsonb("record").notNull(),
});

export const files = pgTable(
  "files",
  {
    id: uuid("id").primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    objectKey: text("object_key").notNull(),
    mime: text("mime").notNull(),
    byteSize: integer("byte_size").notNull(),
  },
  (table) => [unique("files_project_kind").on(table.projectId, table.kind)],
);
