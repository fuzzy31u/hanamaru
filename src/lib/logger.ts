type LogLevel = 'debug' | 'info' | 'warn' | 'error'

type LogPayload = Record<string, unknown>

function emit(level: LogLevel, message: string, payload?: LogPayload): void {
  const entry = {
    severity: level.toUpperCase(),
    message,
    timestamp: new Date().toISOString(),
    ...(payload ?? {}),
  }
  if (level === 'error') {
    console.error(JSON.stringify(entry))
  } else {
    console.log(JSON.stringify(entry))
  }
}

export const logger = {
  debug: (msg: string, payload?: LogPayload) => emit('debug', msg, payload),
  info: (msg: string, payload?: LogPayload) => emit('info', msg, payload),
  warn: (msg: string, payload?: LogPayload) => emit('warn', msg, payload),
  error: (msg: string, payload?: LogPayload) => emit('error', msg, payload),
}
