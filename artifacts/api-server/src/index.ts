import app from "./app";
import { logger } from "./lib/logger";
import { startBot } from "./bot";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");

  // ── Keep-alive self-ping (prevents free-tier hosts from sleeping) ────────
  const replitDomains = process.env["REPLIT_DOMAINS"];
  const renderHostname = process.env["RENDER_EXTERNAL_HOSTNAME"];
  const customPingUrl = process.env["PING_URL"];

  const pingUrl = customPingUrl
    ?? (renderHostname ? `https://${renderHostname}/api/healthz` : null)
    ?? (replitDomains ? `https://${replitDomains.split(",")[0]!.trim()}/api/healthz` : null)
    ?? `http://localhost:${port}/api/healthz`;

  logger.info({ pingUrl }, "Keep-alive pinger started (every 4 min)");

  setInterval(async () => {
    try {
      const res = await fetch(pingUrl);
      if (!res.ok) logger.warn({ status: res.status }, "Keep-alive ping returned non-OK");
    } catch (err) {
      logger.warn({ err }, "Keep-alive ping failed");
    }
  }, 4 * 60 * 1000);
});

startBot().catch((err) => {
  logger.error({ err }, "Failed to start Telegram bot");
  process.exit(1);
});
