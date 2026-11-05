export class HttpError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
export function requireValue(condition: unknown, status: number, code: string, message: string): asserts condition {
  if (!condition) throw new HttpError(status, code, message);
}
