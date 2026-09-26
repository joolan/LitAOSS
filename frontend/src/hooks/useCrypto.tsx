import { useState, useEffect, useCallback, createContext, useContext, ReactNode } from 'react';
import {
  deriveMasterKey,
  unwrapAccountKey,
  generateAccountKey,
  encryptFileKey,
  decryptFileKey,
  encryptContent,
  decryptContent,
  KeyMaterial,
  EncryptedContent,
} from '../crypto/crypto';
import { api, FileRecord, setSessionToken, fromBase64Bytes } from '../api/client';

interface CryptoState {
  unlocked: boolean;
  masterKey: CryptoKey | null;
  accountKey: CryptoKey | null;
}

interface CryptoContextType extends CryptoState {
  setup: (password: string) => Promise<void>;
  unlock: (password: string) => Promise<boolean>;
  lock: () => void;
  encryptAndUpload: (file: File, parentId?: string, onProgress?: (p: number) => void) => Promise<FileRecord>;
  downloadAndDecrypt: (file: FileRecord) => Promise<Blob>;
  decryptFileName: (encryptedName: string) => Promise<string>;
  encryptFileName: (name: string) => Promise<string>;
}

const CryptoContext = createContext<CryptoContextType | null>(null);

export function useCrypto() {
  const ctx = useContext(CryptoContext);
  if (!ctx) throw new Error('useCrypto must be used within CryptoProvider');
  return ctx;
}

export function CryptoProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<CryptoState>({
    unlocked: false,
    masterKey: null,
    accountKey: null,
  });

  const setup = useCallback(async (password: string) => {
    const keyMaterial = await deriveMasterKey(password);
    const accountKey = await generateAccountKey();
    const wrappedAccountKey = await encryptFileKeyDirect(keyMaterial.masterKey, accountKey);

    const status = await api.getSetupStatus();
    if (status.setup_complete) {
      throw new Error('already setup');
    }

    await api.setup({
      password_hash: keyMaterial.authHash,
      salt: keyMaterial.salt,
      encrypted_account_key: wrappedAccountKey,
    });

    setState({
      unlocked: true,
      masterKey: keyMaterial.masterKey,
      accountKey: accountKey,
    });
  }, []);

  const unlock = useCallback(async (password: string): Promise<boolean> => {
    try {
      const status = await api.getSetupStatus();
      if (!status.setup_complete) {
        throw new Error('not setup');
      }

      const saltRes = await api.login({ auth_hash: '', salt: '' });
      let storedSalt = '';
      if (saltRes.ok && saltRes.salt) {
        storedSalt = saltRes.salt;
      }

      const keyMaterial = await deriveMasterKey(password, storedSalt || undefined);

      const loginRes = await api.login({
        auth_hash: keyMaterial.authHash,
        salt: storedSalt || keyMaterial.salt,
      });

      if (!loginRes.ok) {
        throw new Error(loginRes.error || 'login failed');
      }

      if (loginRes.session_token) {
        setSessionToken(loginRes.session_token);
      }

      let accountKey: CryptoKey | null = null;
      if (loginRes.encrypted_account_key) {
        accountKey = await unwrapAccountKey(keyMaterial.masterKey, loginRes.encrypted_account_key);
      }

      setState({
        unlocked: true,
        masterKey: keyMaterial.masterKey,
        accountKey,
      });

      return true;
    } catch (err) {
      console.error('unlock failed:', err);
      return false;
    }
  }, []);

  const lock = useCallback(() => {
    setSessionToken(null);
    setState({ unlocked: false, masterKey: null, accountKey: null });
  }, []);

  const encryptAndUpload = useCallback(async (
    file: File,
    parentId?: string,
    onProgress?: (p: number) => void,
  ): Promise<FileRecord> => {
    if (!state.accountKey) throw new Error('not unlocked');

    const fileKey = await crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt', 'decrypt'],
    );

    const arrayBuffer = await file.arrayBuffer();
    const iv = crypto.getRandomValues(new Uint8Array(12));

    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, tagLength: 128 },
      fileKey,
      arrayBuffer,
    );

    const fileKeyRaw = await crypto.subtle.exportKey('raw', fileKey);
    const fileKeyBase64 = btoa(String.fromCharCode(...new Uint8Array(fileKeyRaw)));

    const encryptedFileKey = await encryptFileKey(state.accountKey, fileKeyBase64);

    const ossKeyRes = await api.generateOSSKey();
    const ossKey = ossKeyRes.oss_key;

    const presignRes = await api.getPresignUploadUrl(ossKey);
    const uploadUrl = presignRes.url;

    const progress = onProgress || (() => {});

    await new Promise<void>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) {
          progress(Math.round((e.loaded / e.total) * 100));
        }
      };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve();
        } else {
          reject(new Error(`upload failed: ${xhr.status}`));
        }
      };
      xhr.onerror = () => reject(new Error('upload network error'));
      xhr.open('PUT', uploadUrl);
      xhr.send(ciphertext);
    });

    const fileRecord = await api.createFileRecord({
      name_encrypted: '',
      parent_id: parentId,
      file_size: ciphertext.byteLength,
      file_type: file.type,
      encrypted_file_key: encryptedFileKey,
      iv: Array.from(iv),
      salt: [],
      oss_key: ossKey,
    });

    progress(100);

    return fileRecord;
  }, [state.accountKey]);

  const downloadAndDecrypt = useCallback(async (file: FileRecord): Promise<Blob> => {
    if (!state.accountKey) throw new Error('not unlocked');

    const presignRes = await api.getPresignDownloadUrl(file.oss_key);
    const response = await fetch(presignRes.url);
    const ciphertext = await response.arrayBuffer();

    const fileKeyBase64 = await decryptFileKey(state.accountKey, file.encrypted_file_key);
    const fileKeyBuffer = Uint8Array.from(atob(fileKeyBase64), c => c.charCodeAt(0));
    const fileKey = await crypto.subtle.importKey(
      'raw',
      fileKeyBuffer,
      { name: 'AES-GCM', length: 256 },
      false,
      ['decrypt'],
    );

    const iv = fromBase64Bytes(file.iv);
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv, tagLength: 128 },
      fileKey,
      ciphertext,
    );

    return new Blob([plaintext], { type: file.file_type || 'application/octet-stream' });
  }, [state.accountKey]);

  const encryptFileName = useCallback(async (name: string): Promise<string> => {
    if (!state.accountKey) throw new Error('not unlocked');
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = new TextEncoder().encode(name);
    const encrypted = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      state.accountKey,
      data,
    );
    const combined = new Uint8Array(iv.length + encrypted.byteLength);
    combined.set(iv, 0);
    combined.set(new Uint8Array(encrypted), iv.length);
    return btoa(String.fromCharCode(...combined));
  }, [state.accountKey]);

  const decryptFileName = useCallback(async (encryptedName: string): Promise<string> => {
    if (!state.accountKey) throw new Error('not unlocked');
    try {
      const combined = Uint8Array.from(atob(encryptedName), c => c.charCodeAt(0));
      const iv = combined.slice(0, 12);
      const data = combined.slice(12);
      const decrypted = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv },
        state.accountKey,
        data,
      );
      return new TextDecoder().decode(decrypted);
    } catch {
      return '(无法解密)';
    }
  }, [state.accountKey]);

  return (
    <CryptoContext.Provider
      value={{
        ...state,
        setup,
        unlock,
        lock,
        encryptAndUpload,
        downloadAndDecrypt,
        decryptFileName,
        encryptFileName,
      }}
    >
      {children}
    </CryptoContext.Provider>
  );
}

async function encryptFileKeyDirect(masterKey: CryptoKey, accountKey: CryptoKey): Promise<string> {
  const raw = await crypto.subtle.exportKey('raw', accountKey);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const wrapped = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    masterKey,
    raw,
  );
  const combined = new Uint8Array(iv.length + wrapped.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(wrapped), iv.length);
  return btoa(String.fromCharCode(...combined));
}
