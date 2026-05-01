import { Bot } from "grammy";
import { db, scheduledTasksTable } from "@workspace/db";
import { and, eq, lte } from "drizzle-orm";
import { logger } from "../lib/logger";

export async function scheduleTask(
  kind: "unmute" | "unban",
  groupId: number,
  userId: number,
  delaySec: number,
): Promise<void> {
  if (delaySec <= 0) return;
  const runAt = new Date(Date.now() + delaySec * 1000);
  await db.insert(scheduledTasksTable).values({
    kind,
    groupId,
    userId,
    runAt,
  });
}

export function startScheduler(bot: Bot): void {
  const tick = async () => {
    try {
      const now = new Date();
      const due = await db
        .select()
        .from(scheduledTasksTable)
        .where(
          and(
            eq(scheduledTasksTable.done, false),
            lte(scheduledTasksTable.runAt, now),
          ),
        )
        .limit(50);
      for (const task of due) {
        try {
          if (task.kind === "unmute" && task.groupId && task.userId) {
            await bot.api.restrictChatMember(
              Number(task.groupId),
              Number(task.userId),
              {
                can_send_messages: true,
                can_send_audios: true,
                can_send_documents: true,
                can_send_photos: true,
                can_send_videos: true,
                can_send_video_notes: true,
                can_send_voice_notes: true,
                can_send_polls: true,
                can_send_other_messages: true,
                can_add_web_page_previews: true,
              },
            );
          } else if (task.kind === "unban" && task.groupId && task.userId) {
            await bot.api.unbanChatMember(
              Number(task.groupId),
              Number(task.userId),
              { only_if_banned: true },
            );
          }
        } catch (err) {
          logger.warn({ err, task }, "Scheduled task failed");
        }
        await db
          .update(scheduledTasksTable)
          .set({ done: true })
          .where(eq(scheduledTasksTable.id, task.id));
      }
    } catch (err) {
      logger.error({ err }, "Scheduler tick error");
    }
  };
  setInterval(tick, 5000);
  void tick();
}
