/**
 * MCP speaks JSON-RPC over stdout, so every log line must go to stderr.
 * Set OPENSCRAPE_DEBUG=1 for verbose output.
 */
const debugOn = process.env.OPENSCRAPE_DEBUG === '1';

function emit(level: string, msg: string, extra?: unknown) {
  const line = `[openscrape] ${level} ${msg}`;
  if (extra === undefined) process.stderr.write(line + '\n');
  else process.stderr.write(`${line} ${safe(extra)}\n`);
}

function safe(value: unknown): string {
  try {
    return typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export const log = {
  debug: (msg: string, extra?: unknown) => { if (debugOn) emit('debug', msg, extra); },
  info: (msg: string, extra?: unknown) => emit('info', msg, extra),
  warn: (msg: string, extra?: unknown) => emit('warn', msg, extra),
  error: (msg: string, extra?: unknown) => emit('error', msg, extra),
};
