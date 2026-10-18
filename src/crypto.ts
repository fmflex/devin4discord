import {
  createCipheriv,
  createDecipheriv,
  createHash,
  hkdfSync,
  randomBytes,
  timingSafeEqual
} from 'node:crypto';

const SALT = 'devin4discord';
const VERSION = 'v1';

function derive(masterKey: string, info: string): Buffer {
  return Buffer.from(hkdfSync('sha256', masterKey, SALT, info, 32));
}

/**
 * Keys derived from `MASTER_KEY`: AES-256-GCM for per-server secrets and an
 * HMAC secret for cookies. `aad` binds a ciphertext to its row (the guild ID),
 * so it can't be copied to another server.
 */
export class Secrets {
  readonly #encryptionKey: Buffer;
  readonly cookieSecret: string;

  constructor(masterKey: string) {
    if (masterKey.length < 32) throw new Error('MASTER_KEY must be at least 32 characters.');
    this.#encryptionKey = derive(masterKey, 'secrets/aes-256-gcm/v1');
    this.cookieSecret = derive(masterKey, 'cookies/hmac/v1').toString('base64url');
  }

  encrypt(plaintext: string, aad: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.#encryptionKey, iv);
    cipher.setAAD(Buffer.from(aad));
    const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return [VERSION, iv, cipher.getAuthTag(), body]
      .map((part) => (typeof part === 'string' ? part : part.toString('base64url')))
      .join(':');
  }

  /** Throws if the key, `aad` or ciphertext don't match. */
  decrypt(blob: string, aad: string): string {
    const [version, iv, tag, body] = blob.split(':');
    if (version !== VERSION || !iv || !tag || body === undefined) {
      throw new Error('Unrecognised ciphertext.');
    }
    const decipher = createDecipheriv(
      'aes-256-gcm',
      this.#encryptionKey,
      Buffer.from(iv, 'base64url')
    );
    decipher.setAAD(Buffer.from(aad));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(body, 'base64url')),
      decipher.final()
    ]).toString('utf8');
  }
}

export function randomToken(bytes = 32) {
  return randomBytes(bytes).toString('base64url');
}

export function sha256(value: string) {
  return createHash('sha256').update(value).digest('base64url');
}

/** Constant-time string comparison. */
export function safeEqual(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
