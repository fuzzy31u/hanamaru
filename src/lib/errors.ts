export class AppError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause !== undefined ? { cause } : undefined)
    this.name = this.constructor.name
  }
}

export class SignatureInvalidError extends AppError {}
export class GeminiExtractionError extends AppError {}
export class CalendarWriteError extends AppError {}
export class SecretAccessError extends AppError {}
export class SchemaParseError extends AppError {}

export function isRetryable(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  const message = err.message.toLowerCase()
  if (message.includes('resource_exhausted')) return true
  if (message.includes('unavailable')) return true
  if (message.includes('deadline_exceeded')) return true
  if (err instanceof GeminiExtractionError && err.cause) return isRetryable(err.cause)
  return false
}
