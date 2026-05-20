import pino from "pino";

/**
 * Read the log level from env, falling back to 'info' for production-friendly
 * defaults. DEBUG / trace logs are useful during development but too noisy
 * in production. Pino's level hierarchy: trace < debug < info < warn < error < fatal.
 */
function resolveLogLevel(): pino.Level {
  const raw = process.env.LOG_LEVEL?.toLowerCase();
  const valid: pino.Level[] = ["trace", "debug", "info", "warn", "error", "fatal"];
  if (raw && valid.includes(raw as pino.Level)) return raw as pino.Level;
  return "info";
}

/**
 * Centralized structured logger. Use this instead of console.log/error for
 * all application logging — it provides timestamps, levels, and JSON output
 * that plays nicely with log aggregators.
 *
 * Default output is JSON (zero-dep, safe in the production container).
 * Set LOG_FORMAT=pretty during local development to get colorized,
 * human-readable lines via pino-pretty. pino-pretty is a devDependency
 * and is intentionally NOT bundled into the prod image — defaulting to
 * pretty in production would crash on startup with "unable to determine
 * transport target for pino-pretty".
 *
 * Example:
 *   logger.info({ sessionId: "abc", userId: 123 }, "Session initialized");
 *   logger.error({ err, endpoint: "/mcp" }, "HTTP transport error");
 */
export const logger = pino({
  level: resolveLogLevel(),
  transport:
    process.env.LOG_FORMAT === "pretty"
      ? {
          target: "pino-pretty",
          options: {
            colorize: true,
            translateTime: "SYS:standard",
            ignore: "pid,hostname",
          },
        }
      : undefined,
});

/**
 * Generate a short correlation ID (8 hex chars) for tracing a single request
 * through the stack (HTTP handler → tool call → API request). Attach it to
 * logger child contexts so every log line from that request shares the ID.
 */
export function generateCorrelationId(): string {
  return Math.random().toString(16).slice(2, 10);
}
