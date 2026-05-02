import {
  pgTable,
  bigint,
  text,
  integer,
  timestamp,
  boolean,
  primaryKey,
  serial,
} from "drizzle-orm/pg-core";

export const superAdminsTable = pgTable("super_admins", {
  userId: bigint("user_id", { mode: "number" }).primaryKey(),
  hardcoded: boolean("hardcoded").notNull().default(false),
  addedAt: timestamp("added_at", { withTimezone: true }).notNull().defaultNow(),
});

export const groupsTable = pgTable("groups", {
  groupId: bigint("group_id", { mode: "number" }).primaryKey(),
  title: text("title").notNull().default(""),
  banned: boolean("banned").notNull().default(false),
  authorized: boolean("authorized").notNull().default(false),
  authorizedKey: text("authorized_key"),
  authorizedExpiresAt: timestamp("authorized_expires_at", { withTimezone: true }),
  joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
});

export const groupSettingsTable = pgTable("group_settings", {
  groupId: bigint("group_id", { mode: "number" }).primaryKey(),
  warnLimit: integer("warn_limit").notNull().default(3),
  warnAction: text("warn_action").notNull().default("mute"),
  warnDurationSec: integer("warn_duration_sec").notNull().default(0),
  blacklistThreshold: integer("blacklist_threshold").notNull().default(3),
  blacklistAction: text("blacklist_action").notNull().default("mute"),
  blacklistDurationSec: integer("blacklist_duration_sec").notNull().default(0),
  captchaEnabled: boolean("captcha_enabled").notNull().default(false),
  captchaType: text("captcha_type").notNull().default("button"),
  captchaTimeoutSec: integer("captcha_timeout_sec").notNull().default(120),
  antibot: boolean("antibot").notNull().default(false),
  antichannel: boolean("antichannel").notNull().default(false),
  floodEnabled: boolean("flood_enabled").notNull().default(false),
  floodLimit: integer("flood_limit").notNull().default(5),
  floodWindowSec: integer("flood_window_sec").notNull().default(5),
  floodAction: text("flood_action").notNull().default("mute"),
  floodActionDurationSec: integer("flood_action_duration_sec").notNull().default(300),
  welcomeEnabled: boolean("welcome_enabled").notNull().default(false),
  welcomeMessage: text("welcome_message"),
  globalBlacklistEnabled: boolean("global_blacklist_enabled").notNull().default(false),
  lockAction: text("lock_action").notNull().default("none"),
  lockActionLimit: integer("lock_action_limit").notNull().default(3),
  lockActionDurationSec: integer("lock_action_duration_sec").notNull().default(0),
});

export const authKeysTable = pgTable("auth_keys", {
  key: text("key").primaryKey(),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  maxUses: integer("max_uses").notNull().default(1),
  usedCount: integer("used_count").notNull().default(0),
  createdBy: bigint("created_by", { mode: "number" }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const groupKeyHistoryTable = pgTable(
  "group_key_history",
  {
    groupId: bigint("group_id", { mode: "number" }).notNull(),
    key: text("key").notNull(),
    addedAt: timestamp("added_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.groupId, t.key] })],
);

export const botConfigTable = pgTable("bot_config", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

export const warningsTable = pgTable(
  "warnings",
  {
    groupId: bigint("group_id", { mode: "number" }).notNull(),
    userId: bigint("user_id", { mode: "number" }).notNull(),
    count: integer("count").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.groupId, t.userId] })],
);

export const blacklistHitsTable = pgTable(
  "blacklist_hits",
  {
    groupId: bigint("group_id", { mode: "number" }).notNull(),
    userId: bigint("user_id", { mode: "number" }).notNull(),
    count: integer("count").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.groupId, t.userId] })],
);

export const filtersTable = pgTable(
  "filters",
  {
    groupId: bigint("group_id", { mode: "number" }).notNull(),
    word: text("word").notNull(),
    reply: text("reply").notNull(),
  },
  (t) => [primaryKey({ columns: [t.groupId, t.word] })],
);

export const blacklistTable = pgTable(
  "blacklist",
  {
    groupId: bigint("group_id", { mode: "number" }).notNull(),
    word: text("word").notNull(),
  },
  (t) => [primaryKey({ columns: [t.groupId, t.word] })],
);

export const locksTable = pgTable(
  "locks",
  {
    groupId: bigint("group_id", { mode: "number" }).notNull(),
    type: text("type").notNull(),
  },
  (t) => [primaryKey({ columns: [t.groupId, t.type] })],
);

export const captchaSessionsTable = pgTable("captcha_sessions", {
  id: serial("id").primaryKey(),
  groupId: bigint("group_id", { mode: "number" }).notNull(),
  userId: bigint("user_id", { mode: "number" }).notNull(),
  answer: text("answer").notNull(),
  privateMessageId: integer("private_message_id"),
  groupMessageId: integer("group_message_id"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  solved: boolean("solved").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const globalBansTable = pgTable("global_bans", {
  userId: bigint("user_id", { mode: "number" }).primaryKey(),
  until: timestamp("until", { withTimezone: true }),
  reason: text("reason").notNull().default(""),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const globalMutesTable = pgTable("global_mutes", {
  userId: bigint("user_id", { mode: "number" }).primaryKey(),
  until: timestamp("until", { withTimezone: true }),
  reason: text("reason").notNull().default(""),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const scheduledTasksTable = pgTable("scheduled_tasks", {
  id: serial("id").primaryKey(),
  kind: text("kind").notNull(),
  groupId: bigint("group_id", { mode: "number" }),
  userId: bigint("user_id", { mode: "number" }),
  runAt: timestamp("run_at", { withTimezone: true }).notNull(),
  done: boolean("done").notNull().default(false),
});

export const notesTable = pgTable(
  "notes",
  {
    groupId: bigint("group_id", { mode: "number" }).notNull(),
    name: text("name").notNull(),
    content: text("content").notNull(),
    createdBy: bigint("created_by", { mode: "number" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.groupId, t.name] })],
);

export const approvalsTable = pgTable(
  "approvals",
  {
    groupId: bigint("group_id", { mode: "number" }).notNull(),
    userId: bigint("user_id", { mode: "number" }).notNull(),
    approvedBy: bigint("approved_by", { mode: "number" }).notNull(),
    approvedAt: timestamp("approved_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.groupId, t.userId] })],
);

export const tagsTable = pgTable(
  "tags",
  {
    userId: bigint("user_id", { mode: "number" }).notNull(),
    tag: text("tag").notNull(),
    addedBy: bigint("added_by", { mode: "number" }).notNull(),
    addedAt: timestamp("added_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.tag] })],
);

export const restrictionsTable = pgTable(
  "restrictions",
  {
    groupId: bigint("group_id", { mode: "number" }).notNull(),
    userId: bigint("user_id", { mode: "number" }).notNull(),
    type: text("type").notNull(),
    until: timestamp("until", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.groupId, t.userId, t.type] })],
);

export const userSeenTable = pgTable(
  "user_seen",
  {
    userId: bigint("user_id", { mode: "number" }).notNull(),
    groupId: bigint("group_id", { mode: "number" }).notNull(),
    firstName: text("first_name").notNull().default(""),
    lastName: text("last_name").notNull().default(""),
    username: text("username"),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.groupId] })],
);

export const joinMustTable = pgTable(
  "join_must",
  {
    groupId: bigint("group_id", { mode: "number" }).notNull(),
    targetId: bigint("target_id", { mode: "number" }).notNull(),
    targetUsername: text("target_username"),
    addedAt: timestamp("added_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.groupId, t.targetId] })],
);

export const globalBlacklistTable = pgTable("global_blacklist", {
  word: text("word").primaryKey(),
  addedBy: bigint("added_by", { mode: "number" }).notNull(),
  addedAt: timestamp("added_at", { withTimezone: true }).notNull().defaultNow(),
});
