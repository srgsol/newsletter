type Level = 'debug' | 'info' | 'warn' | 'error';

let verbose = false;

export function setVerbose(v: boolean): void {
  verbose = v;
}

function log(level: Level, msg: string): void {
  if (level === 'debug' && !verbose) return;
  const ts = new Date().toISOString().slice(11, 19);
  const tag = level === 'info' ? 'ℹ' : level === 'warn' ? '⚠' : level === 'error' ? '✖' : '·';
  const line = `[${ts}] ${tag} ${msg}`;
  // All logs go to stderr so stdout carries only command data
  // (e.g. the channel id printed by `resolve-channel`).
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.error(line);
}

export const logger = {
  debug: (m: string) => log('debug', m),
  info: (m: string) => log('info', m),
  warn: (m: string) => log('warn', m),
  error: (m: string) => log('error', m),
};
