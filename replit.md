# Workspace

## Overview

pnpm workspace monorepo using TypeScript. Each package manages its own dependencies.

Currently hosts a **Telegram Group Management Bot** (grammY) inside the `@workspace/api-server` artifact. The bot runs alongside the Express server using long polling. It supports moderation, content control, blacklist, captcha verification, and super-admin private commands. Hardcoded super admins: `8074495633`, `5883825451`. Token in `TELEGRAM_BOT_TOKEN` secret. State persisted via Drizzle in PostgreSQL (tables: `super_admins`, `groups`, `group_settings`, `warnings`, `blacklist`, `blacklist_hits`, `filters`, `locks`, `captcha_sessions`, `global_bans`, `scheduled_tasks`).

Bot source lives in `artifacts/api-server/src/bot/`. Schema lives in `lib/db/src/schema/bot.ts`. `grammy` and `@grammyjs/auto-retry` are externalized in `build.mjs` because grammY uses native dynamic platform imports.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (CJS bundle)

## Key Commands

- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/api-server run dev` — run API server locally

See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details.
