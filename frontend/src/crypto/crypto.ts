const PBKDF2_ITERATIONS = 500000;
const SALT_LENGTH = 16;
const IV_LENGTH = 12;
const AES_KEY_LENGTH = 256;

function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function fromBase64(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

function concatBuffers(...buffers: ArrayBuffer[]): ArrayBuffer {
  const totalLength = buffers.reduce((acc, buf) => acc + buf.byteLength, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const buf of buffers) {
    result.set(new Uint8Array(buf), offset);
    offset += buf.byteLength;
  }
  return result.buffer;
}

function getRandomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}

function deriveKeyParams(password: string, salt?: Uint8Array): { key: CryptoKey; salt: Uint8Array } {
  const usedSalt = salt || getRandomBytes(SALT_LENGTH);

  const passwordBuffer = new TextEncoder().encode(password);

  return crypto.subtle.importKey(
    'raw',
    passwordBuffer,
    'PBKDF2',
    false,
    ['deriveKey'],
  ).then(masterKey =>
    crypto.subtle.deriveKey(
      {
        name: 'PBKDF2',
        salt: usedSalt,
        iterations: PBKDF2_ITERATIONS,
        hash: 'SHA-256',
      },
      masterKey,
      { name: 'AES-KW', length: AES_KEY_LENGTH },
      false,
      ['wrapKey', 'unwrapKey'],
    ).then(key => ({ key, salt: usedSalt }))
  );
}

export interface KeyMaterial {
  masterKey: CryptoKey;
  authHash: string;
  salt: string;
}

export async function deriveMasterKey(password: string, existingSalt?: Uint8Array): Promise<KeyMaterial> {
  const salt = existingSalt || getRandomBytes(SALT_LENGTH);
  const passwordBuffer = new TextEncoder().encode(password);

  const passwordKey = await crypto.subtle.importKey(
    'raw',
    passwordBuffer,
    'PBKDF2',
    false,
    ['deriveBits'],
  );

  const authBits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: salt,
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256',
    },
    passwordKey,
    256,
  );

  const masterKey = await crypto.subtle.importKey(
    'raw',
    await crypto.subtle.deriveBits(
      {
        name: 'PBKDF2',
        salt: concatBuffers(salt, new TextEncoder().encode('account-key')),
        iterations: PBKDF2_ITERATIONS,
        hash: 'SHA-256',
      },
      passwordKey,
      256,
    ),
    { name: 'AES-KW' },
    false,
    ['wrapKey', 'unwrapKey'],
  );

  return {
    masterKey,
    authHash: toBase64(authBits),
    salt: toBase64(salt.buffer),
  };
}

export async function verifyPassword(password: string, saltBase64: string, expectedAuthHash: string): Promise<boolean> {
  const salt = new Uint8Array(fromBase64(saltBase64));
  const passwordBuffer = new TextEncoder().encode(password);

  const passwordKey = await crypto.subtle.importKey(
    'raw',
    passwordBuffer,
    'PBKDF2',
    false,
    ['deriveBits'],
  );

  const authBits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: salt,
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256',
    },
    passwordKey,
    256,
  );

  return toBase64(authBits) === expectedAuthHash;
}

export async function wrapAccountKey(masterKey: CryptoKey, accountKey: CryptoKey): Promise<string> {
  const raw = await crypto.subtle.exportKey('raw', accountKey);
  const wrapped = await crypto.subtle.wrapKey('raw', accountKey, masterKey, 'AES-KW');
  return toBase64(wrapped);
}

export async function unwrapAccountKey(masterKey: CryptoKey, wrappedKeyBase64: string): Promise<CryptoKey> {
  const wrappedKey = fromBase64(wrappedKeyBase64);
  return crypto.subtle.unwrapKey(
    'raw',
    wrappedKey,
    masterKey,
    'AES-KW',
    { name: 'AES-KW', length: AES_KEY_LENGTH },
    true,
    ['wrapKey', 'unwrapKey'],
  );
}

export function generateAccountKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey(
    { name: 'AES-KW', length: AES_KEY_LENGTH },
    true,
    ['wrapKey', 'unwrapKey'],
  );
}

export interface EncryptedContent {
  ciphertext: ArrayBuffer;
  iv: Uint8Array;
  salt: Uint8Array;
}

export async function encryptContent(data: ArrayBuffer, fileKey?: CryptoKey): Promise<EncryptedContent & { fileKeyRaw: string }> {
  const key = fileKey || await crypto.subtle.generateKey(
    { name: 'AES-GCM', length: AES_KEY_LENGTH },
    true,
    ['encrypt', 'decrypt'],
  );

  const iv = getRandomBytes(IV_LENGTH);
  const salt = getRandomBytes(SALT_LENGTH);

  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, tagLength: 128 },
    key,
    data,
  );

  const rawKey = await crypto.subtle.exportKey('raw', key);

  return {
    ciphertext,
    iv,
    salt,
    fileKeyRaw: toBase64(rawKey),
  };
}

export async function decryptContent(
  ciphertext: ArrayBuffer,
  iv: Uint8Array,
  fileKeyRaw: string,
): Promise<ArrayBuffer> {
  const keyMaterial = fromBase64(fileKeyRaw);
  const key = await crypto.subtle.importKey(
    'raw',
    keyMaterial,
    { name: 'AES-GCM', length: AES_KEY_LENGTH },
    false,
    ['decrypt'],
  );

  return crypto.subtle.decrypt(
    { name: 'AES-GCM', iv, tagLength: 128 },
    key,
    ciphertext,
  );
}

export async function encryptFileKey(accountKey: CryptoKey, fileKeyRaw: string): Promise<string> {
  const fileKeyBuffer = fromBase64(fileKeyRaw);
  const fileKey = await crypto.subtle.importKey(
    'raw',
    fileKeyBuffer,
    { name: 'AES-GCM' },
    true,
    ['encrypt', 'decrypt'],
  );

  const wrapped = await crypto.subtle.wrapKey(
    'raw',
    fileKey,
    accountKey,
    'AES-KW',
  );

  return toBase64(wrapped);
}

export async function decryptFileKey(accountKey: CryptoKey, encryptedKeyBase64: string): Promise<string> {
  const wrappedKey = fromBase64(encryptedKeyBase64);

  const fileKey = await crypto.subtle.unwrapKey(
    'raw',
    wrappedKey,
    accountKey,
    'AES-KW',
    { name: 'AES-GCM', length: AES_KEY_LENGTH },
    false,
    ['encrypt', 'decrypt'],
  );

  const rawKey = await crypto.subtle.exportKey('raw', fileKey);
  return toBase64(rawKey);
}

export const PREVIEW_MAX_SIZE = 200 * 1024 * 1024;

export function getPreviewMode(filename: string): 'image' | 'text' | 'unsupported' {
  const ext = filename.split('.').pop()?.toLowerCase() || '';

  const imageExts = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'ico', 'tiff', 'tif'];
  if (imageExts.includes(ext)) return 'image';

  const textExts = [
    'txt', 'json', 'xml', 'csv', 'log', 'md', 'yaml', 'yml', 'toml', 'ini', 'conf',
    'js', 'ts', 'jsx', 'tsx', 'py', 'go', 'java', 'c', 'cpp', 'h', 'hpp', 'rb', 'rs',
    'sh', 'bash', 'zsh', 'sql', 'html', 'htm', 'css', 'scss', 'less', 'vue', 'svelte',
    'env', 'gitignore', 'dockerignore', 'makefile', 'cmake', 'gradle', 'properties',
    'proto', 'graphql', 'tf', 'hcl', 'nginx', 'apache',
  ];
  if (textExts.includes(ext)) return 'text';

  return 'unsupported';
}

export function isTextFile(filename: string): boolean {
  return getPreviewMode(filename) !== 'unsupported';
}
