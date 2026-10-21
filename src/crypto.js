// AES-256-GCM for secrets at rest. Stored format: "v1:" + base64(iv ‖ ciphertext ‖ tag).
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const PREFIX = 'v1:';

export function parseKey(base64) {
  const key = Buffer.from(base64.trim(), 'base64');
  if (key.length !== 32) throw new Error('key must be 32 bytes');
  return key;
}

export function encrypt(plaintext, key) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return PREFIX + Buffer.concat([iv, data, cipher.getAuthTag()]).toString('base64');
}

export function decrypt(stored, key) {
  if (!stored.startsWith(PREFIX)) throw new Error('unknown secret format');
  const raw = Buffer.from(stored.slice(PREFIX.length), 'base64');
  if (raw.length < 28) throw new Error('secret too short');
  const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(raw.length - 16));
  return Buffer.concat([decipher.update(raw.subarray(12, raw.length - 16)), decipher.final()]).toString('utf8');
}
