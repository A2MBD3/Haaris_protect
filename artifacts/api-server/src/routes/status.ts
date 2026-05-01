import { Router } from "express";
import { bot } from "../bot";

const router = Router();

const startTime = Date.now();

router.get("/status", async (_req, res) => {
  let botName = "haarish_helpbot";
  let botActive = false;
  try {
    const me = await bot.api.getMe();
    botName = me.username || botName;
    botActive = true;
  } catch {
    botActive = false;
  }

  const uptimeSec = Math.floor((Date.now() - startTime) / 1000);
  const hours = Math.floor(uptimeSec / 3600);
  const minutes = Math.floor((uptimeSec % 3600) / 60);
  const seconds = uptimeSec % 60;
  const uptimeStr = `${hours}h ${minutes}m ${seconds}s`;

  res.json({
    status: botActive ? "ok" : "offline",
    botName,
    uptime: uptimeSec,
    uptimeFormatted: uptimeStr,
    startedAt: new Date(startTime).toISOString(),
    timestamp: new Date().toISOString(),
  });
});

export default router;
