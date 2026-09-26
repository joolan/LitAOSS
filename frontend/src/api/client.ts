const API_BASE = '/api';

let sessionToken: string | null = null;
localStorage.removeItem('session_token');

export function setSessionToken(token: string | null) {
  sessionToken = token;
}

export function getSessionToken(): string | null {
  return sessionToken;
}

export function fromBase64Bytes(b64: string | null | undefined): Uint8Array {
  if (!b64) return new Uint8Array(0);
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (sessionToken) {
    headers['X-Session-Token'] = sessionToken;
  }

  const res = await fetch(`${API_BASE}${path}`, {
    headers,
    ...options,
  });

  const body = await res.json().catch(() => ({} as any));

  if (res.status === 401) {
    const msg = body.error || '';
    if (msg === 'invalid or expired session' || msg === 'unauthorized' || msg === '') {
      setSessionToken(null);
      window.location.reload();
      throw new Error('Session expired');
    }
  }

  if (!res.ok) {
    const e: any = new Error(body.error || body.message || `HTTP ${res.status}`);
    e.body = body;
    throw e;
  }

  return body as T;
}

export interface SetupStatus {
  setup_complete: boolean;
}

export interface LoginResponse {
  ok: boolean;
  encrypted_account_key?: string;
  salt?: string;
  session_token?: string;
  mfa_required?: boolean;
  version?: string;
  error?: string;
}

// 后端版本号：仅来自登录成功响应（服务端禁止匿名获取），页面内存暂存
let serverVersion: string | null = null;
export const getServerVersion = (): string | null => serverVersion;

export interface FileRecord {
  id: string;
  name_encrypted: string;
  parent_id: string | null;
  is_directory: boolean;
  file_size: number;
  file_type: string;
  oss_key: string;
  encrypted_file_key: string | null;
  iv: string | null;
  salt: string | null;
  created_at: string;
  updated_at: string;
}

export interface FileVersion {
  id: number;
  file_id: string;
  version: number;
  oss_key: string;
  encrypted_file_key: string | null;
  iv: string | null;
  salt: string | null;
  file_size: number;
  created_at: string;
}

export interface FileListResponse {
  files: FileRecord[];
}

export const api = {
  getSetupStatus: () => request<SetupStatus>('/setup/status'),

  setup: (data: {
    password_hash: string;
    salt: string;
    encrypted_account_key: string;
  }) => request<{ ok: boolean; error?: string }>('/setup', {
    method: 'POST',
    body: JSON.stringify(data),
  }),

  login: async (data: { auth_hash: string; salt: string }) => {
    const res = await request<LoginResponse>('/auth/login', {
      method: 'POST',
      body: JSON.stringify(data),
    });
    if (res.ok && res.version) {
      serverVersion = res.version;
    }
    return res;
  },

  listFiles: (parentId?: string) => {
    const params = parentId ? `?parent_id=${parentId}` : '';
    return request<FileListResponse>(`/files${params}`);
  },

  getFile: (id: string) => request<FileRecord>(`/files/${id}`),

  getFileInfo: (id: string) => request<any>(`/files/${id}/info`),

  getFileVersions: (id: string) => request<{ versions: FileVersion[] }>(`/files/${id}/versions`),

  createFileVersion: (fileId: string, data: {
    oss_key: string;
    encrypted_file_key: string;
    iv: string;
    salt: string;
    file_size: number;
  }) => request<{ ok: boolean }>(`/files/${fileId}/versions`, {
    method: 'POST',
    body: JSON.stringify(data),
  }),

  createFileRecord: (data: {
    name_encrypted: string;
    parent_id?: string;
    file_size: number;
    file_type: string;
    encrypted_file_key: string;
    iv: number[] | string;
    salt: number[] | string;
    oss_key: string;
  }) => request<FileRecord>('/files', {
    method: 'POST',
    body: JSON.stringify(data),
  }),

  updateFileContent: (id: string, data: {
    file_size: number;
    file_type: string;
    encrypted_file_key: string;
    iv: number[] | string;
    salt: number[] | string;
    oss_key: string;
  }) => request<{ ok: boolean }>(`/files/${id}/content`, {
    method: 'PUT',
    body: JSON.stringify(data),
  }),

  renameFile: (id: string, nameEncrypted: string) =>
    request<{ ok: boolean }>('/files/' + id + '/rename', {
      method: 'PUT',
      body: JSON.stringify({ id, name_encrypted: nameEncrypted }),
    }),

  deleteFile: (id: string) =>
    request<{ ok: boolean }>('/files/' + id, {
      method: 'DELETE',
      body: JSON.stringify({ id }),
    }),

  batchDelete: (ids: string[]) =>
    request<{ ok: boolean }>('/files/batch-delete', {
      method: 'POST',
      body: JSON.stringify({ ids }),
    }),

  createFolder: (nameEncrypted: string, parentId?: string) =>
    request<FileRecord>('/folders', {
      method: 'POST',
      body: JSON.stringify({ name_encrypted: nameEncrypted, parent_id: parentId }),
    }),

  getPresignUploadUrl: (ossKey: string, expires = 3600) =>
    request<{ url: string }>('/presign/upload', {
      method: 'POST',
      body: JSON.stringify({ oss_key: ossKey, expires }),
    }),

  getPresignDownloadUrl: (ossKey: string, expires = 3600) =>
    request<{ url: string }>('/presign/download', {
      method: 'POST',
      body: JSON.stringify({ oss_key: ossKey, expires }),
    }),

  generateOSSKey: (folder = 'files') =>
    request<{ oss_key: string }>(`/oss/key?folder=${folder}`, { method: 'POST' }),

  getStats: () => request<{ total_size: number; file_count: number; folder_count: number }>('/stats'),

  updateKey: (data: { encrypted_account_key: string; password_hash: string }) =>
    request<{ ok: boolean }>('/auth/update-key', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  updatePassword: (data: { encrypted_account_key: string; password_hash: string }) =>
    request<{ ok: boolean }>('/auth/update-key', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  changePassword: (data: { old_password_hash: string; new_password_hash: string; new_encrypted_account_key: string }) =>
    request<{ ok: boolean; error?: string }>('/auth/change-password', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  mfaStatus: () => request<{ enabled: boolean; setup: boolean }>('/mfa/status'),

  mfaSetup: () => request<{ secret: string; uri: string }>('/mfa/setup', { method: 'POST' }),

  mfaEnable: (data: { code: string }) =>
    request<{ ok: boolean; error?: string }>('/mfa/enable', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  mfaDisable: (data: { code: string; password_hash: string }) =>
    request<{ ok: boolean; error?: string }>('/mfa/disable', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  logout: () =>
    request<{ ok: boolean }>('/auth/logout', { method: 'POST' }),

  verifyTotp: (data: { code: string; session_token: string }) =>
    request<{ ok: boolean; session_token?: string; error?: string }>('/auth/verify-totp', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  verifyDeleteMFA: (code: string) =>
    request<{ ok: boolean }>('/auth/verify-totp-delete', {
      method: 'POST',
      body: JSON.stringify({ code }),
    }),

  getBackupConfig: () =>
    request<{ ok: boolean; config: BackupConfig; oss_backup?: OSSBackupSummary | null }>('/backup/config'),

  updateBackupConfig: (data: Partial<BackupConfig>) =>
    request<{ ok: boolean }>('/backup/config', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  manualBackup: (uploadOss = false) =>
    request<{
      ok: boolean;
      path?: string;
      oss?: 'uploaded' | 'skipped' | 'failed' | 'not_requested';
      oss_error?: string;
      error?: string;
    }>('/backup/now', {
      method: 'POST',
      body: JSON.stringify({ upload_oss: uploadOss }),
    }),

  listBackups: () =>
    request<{ ok: boolean; backups: BackupEntry[]; oss_backups?: OSSBackupEntry[] }>('/backup/list'),

  restoreBackup: (name: string) =>
    request<{ ok: boolean; message?: string; error?: string }>('/backup/restore', {
      method: 'POST',
      body: JSON.stringify({ name }),
    }),

  restoreBackupOSS: (ossKey: string) =>
    request<{ ok: boolean; message?: string; error?: string }>('/backup/restore-oss', {
      method: 'POST',
      body: JSON.stringify({ oss_key: ossKey }),
    }),

  encryptSecret: (data: { plaintext: string; passphrase: string }) =>
    request<{ encrypted: string }>('/secret/encrypt', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  decryptSecret: (data: { encrypted: string; passphrase: string }) =>
    request<{ plaintext: string }>('/secret/decrypt', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
};

export interface BackupConfig {
  auto_backup: boolean;
  backup_time: string;
  on_file_change: boolean;
  min_interval: number;
  max_backups: number;
  auto_backup_upload_oss: boolean;
  on_file_change_upload_oss: boolean;
}

export interface BackupEntry {
  name: string;
  size: number;
  created_at: string;
}

export interface OSSBackupEntry {
  id: number;
  name: string;
  oss_key: string;
  md5: string;
  file_size: number;
  uploaded_at: string;
}

export interface OSSBackupSummary {
  name: string;
  md5: string;
  file_size: number;
  uploaded_at: string;
}
