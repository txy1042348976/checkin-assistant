export class HttpError extends Error {
  status: number;
  fields?: string[];
  headers?: Record<string, string>;

  constructor(status: number, detail: string, options: { fields?: string[]; headers?: Record<string, string> } = {}) {
    super(detail);
    this.name = 'HttpError';
    this.status = status;
    this.fields = options.fields;
    this.headers = options.headers;
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function requireRecord(value: unknown, detail = '请求信息不完整或格式无效。'): Record<string, unknown> {
  if (!isRecord(value)) throw new HttpError(422, detail);
  return value;
}

export function boundedString(value: unknown, min: number, max: number, trim = true): string {
  if (typeof value !== 'string') throw new HttpError(422, '请求信息不完整或格式无效。');
  const result = trim ? value.trim() : value;
  if (result.length < min || result.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(result)) {
    throw new HttpError(422, '请求信息不完整或格式无效。');
  }
  return result;
}

export function integer(value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new HttpError(422, '请求信息不完整或格式无效。');
  }
  return value;
}

export function positiveId(value: unknown): number {
  if (typeof value === 'string' && /^[1-9][0-9]*$/.test(value)) value = Number(value);
  return integer(value, 1, Number.MAX_SAFE_INTEGER);
}
