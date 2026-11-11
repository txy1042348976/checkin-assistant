/** Python cryptography.Fernet-compatible authenticated AES-CBC envelopes. */
import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export class FernetError extends Error {
  constructor() {
    super('凭据格式或加密密钥无效。');
    this.name = 'FernetError';
  }
}

function encode(value: Buffer): string {
  return value.toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
}

function decode(value: string): Buffer {
  const input = value.trim();
  if (!/^[A-Za-z0-9_+/-]+={0,2}$/.test(input) || input.length % 4 === 1) throw new FernetError();
  const decoded = Buffer.from(input, 'base64');
  const normalized = input.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  if (decoded.toString('base64url') !== normalized) throw new FernetError();
  return decoded;
}

function seconds(value: number): bigint {
  if (!Number.isSafeInteger(value) || value < 0) throw new FernetError();
  return BigInt(value);
}

export function generateFernetKey(): string {
  return encode(randomBytes(32));
}

export class Fernet {
  private readonly signingKey: Buffer;
  private readonly encryptionKey: Buffer;

  constructor(key: string | Buffer) {
    if (typeof key !== 'string' && !Buffer.isBuffer(key)) throw new FernetError();
    const decoded = decode(typeof key === 'string' ? key : key.toString('ascii'));
    if (decoded.length !== 32) throw new FernetError();
    this.signingKey = Buffer.from(decoded.subarray(0, 16));
    this.encryptionKey = Buffer.from(decoded.subarray(16));
  }

  encrypt(plaintext: string | Buffer, options: { timestamp?: number; iv?: Buffer } = {}): string {
    if (typeof plaintext !== 'string' && !Buffer.isBuffer(plaintext)) throw new FernetError();
    const timestamp = seconds(options.timestamp ?? Math.floor(Date.now() / 1000));
    const iv = options.iv === undefined ? randomBytes(16) : Buffer.from(options.iv);
    if (iv.length !== 16) throw new FernetError();
    try {
      const header = Buffer.alloc(9);
      header[0] = 0x80;
      header.writeBigUInt64BE(timestamp, 1);
      const cipher = createCipheriv('aes-128-cbc', this.encryptionKey, iv);
      const data = Buffer.concat([header, iv, cipher.update(plaintext), cipher.final()]);
      const signature = createHmac('sha256', this.signingKey).update(data).digest();
      return encode(Buffer.concat([data, signature]));
    } catch {
      throw new FernetError();
    }
  }

  decrypt(token: string, options: { ttl?: number; now?: number } = {}): Buffer {
    if (typeof token !== 'string') throw new FernetError();
    try {
      const data = decode(token);
      if (data.length < 73 || data[0] !== 0x80 || (data.length - 57) % 16 !== 0) throw new FernetError();
      const signed = data.subarray(0, -32);
      const expected = createHmac('sha256', this.signingKey).update(signed).digest();
      if (!timingSafeEqual(expected, data.subarray(-32))) throw new FernetError();
      if (options.ttl !== undefined) {
        const ttl = seconds(options.ttl);
        const now = seconds(options.now ?? Math.floor(Date.now() / 1000));
        const timestamp = data.readBigUInt64BE(1);
        if (timestamp + ttl < now || now + 60n < timestamp) throw new FernetError();
      }
      const decipher = createDecipheriv('aes-128-cbc', this.encryptionKey, data.subarray(9, 25));
      return Buffer.concat([decipher.update(data.subarray(25, -32)), decipher.final()]);
    } catch {
      // Never return OpenSSL/base64 errors that could include submitted secrets.
      throw new FernetError();
    }
  }
}
