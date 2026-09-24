/** Structured JSON logger. Never pass tokens or keys as fields. */
export interface Logger {
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

export const jsonLogger = (service = 'degent-x-bot'): Logger => {
  const line = (level: string) => (msg: string, fields: Record<string, unknown> = {}) =>
    process.stdout.write(`${JSON.stringify({ time: new Date().toISOString(), level, service, msg, ...fields })}\n`);
  return { info: line('info'), warn: line('warn'), error: line('error') };
};

export const silentLogger: Logger = { info: () => {}, warn: () => {}, error: () => {} };
