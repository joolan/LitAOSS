import { useState, useRef, useEffect, useCallback } from 'react';
import {
  Upload, FolderPlus, Trash2, Download, Eye, Edit3, File, Image,
  ChevronRight, Home, MoreVertical, X, Save, Check, HardDrive, Folder,
  FileText, AlertCircle, FilePlus, Settings as SettingsIcon, Lock, History, Shield,
  FileSpreadsheet,
} from 'lucide-react';
import { api, FileRecord, fromBase64Bytes } from '../api/client';
import { getSessionPassword } from '../session';
import {
  wrapFileKeyForStorage, unwrapFileKeyFromStorage,
  encryptNameForStorage, decryptNameForStorage, isLegacyEncryptedName, rewrapLegacyFileKey,
} from '../crypto/fileKey';
import { getPreviewMode } from '../crypto/crypto';
import { resolvePreview } from '../preview';
import FilePreview from './FilePreview';
import TextEditor from './TextEditor';
import VersionHistory from './VersionHistory';
import Settings from './Settings';

interface FileExplorerProps {
  onLock: () => void;
}

type ViewMode = 'grid' | 'list';

export default function FileExplorer({ onLock }: FileExplorerProps) {
  const [files, setFiles] = useState<FileRecord[]>([]);
  const [decryptedNames, setDecryptedNames] = useState<Map<string, string>>(new Map());
  const [currentFolder, setCurrentFolder] = useState<string | null>(null);
  const [breadcrumbs, setBreadcrumbs] = useState<{ id: string | null; name: string }[]>([
    { id: null, name: '根目录' },
  ]);
  const [viewMode, setViewMode] = useState<ViewMode>('grid');
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [previewFile, setPreviewFile] = useState<FileRecord | null>(null);
  const [editingFile, setEditingFile] = useState<FileRecord | null>(null);
  const [versionFile, setVersionFile] = useState<FileRecord | null>(null);
  const [stats, setStats] = useState({ total_size: 0, file_count: 0, folder_count: 0 });
  const [contextMenu, setContextMenu] = useState<{ file: FileRecord; x: number; y: number } | null>(null);
  const [newFolderName, setNewFolderName] = useState('');
  const [showNewFolder, setShowNewFolder] = useState(false);
  const [newTextFileName, setNewTextFileName] = useState('');
  const [showNewTextFile, setShowNewTextFile] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showLockConfirm, setShowLockConfirm] = useState(false);
  const [emptyMenu, setEmptyMenu] = useState<{ x: number; y: number } | null>(null);
  const [mfaDeleteFile, setMfaDeleteFile] = useState<FileRecord | null>(null);
  const [mfaCode, setMfaCode] = useState('');
  const [mfaError, setMfaError] = useState('');
  const [mfaBusy, setMfaBusy] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [error, setError] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);

  const decryptName = useCallback(async (encryptedName: string): Promise<string> => {
    if (!getSessionPassword()) return '(未解锁)';
    const name = await decryptNameForStorage(encryptedName);
    return name ?? '(无法解密)';
  }, []);

  const encryptName = useCallback(async (name: string): Promise<string> => {
    return encryptNameForStorage(name);
  }, []);

  const loadFiles = useCallback(async (parentId: string | null, silent = false) => {
    if (!silent) setLoading(true);
    try {
      const res = await api.listFiles(parentId || undefined);
      setFiles(res.files || []);

      const names = new Map<string, string>();
      for (const f of res.files || []) {
        const name = await decryptName(f.name_encrypted);
        names.set(f.id, name);
      }
      setDecryptedNames(names);

      const s = await api.getStats();
      setStats(s);
    } catch (err) {
      console.error('load files error:', err);
    } finally {
      if (!silent) setLoading(false);
    }
  }, [decryptName]);

  useEffect(() => {
    loadFiles(currentFolder);
  }, [currentFolder, loadFiles]);

  const migrationRef = useRef(false);

  useEffect(() => {
    if (migrationRef.current) return;
    migrationRef.current = true;
    migrateLegacyData().catch((err) => console.warn('[migrate] failed:', err));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const migrateLegacyData = async () => {
    const walk = async (parentId: string | null): Promise<void> => {
      const res = await api.listFiles(parentId || undefined);
      for (const f of res.files || []) {
        try {
          if (await isLegacyEncryptedName(f.name_encrypted)) {
            const plain = await decryptNameForStorage(f.name_encrypted);
            if (plain !== null) {
              await api.renameFile(f.id, await encryptNameForStorage(plain));
              console.info('[migrate] name → Account Key:', f.id);
            }
          }
          if (!f.is_directory && f.encrypted_file_key) {
            const reWrapped = await rewrapLegacyFileKey(f.encrypted_file_key);
            if (reWrapped) {
              await api.updateFileContent(f.id, {
                file_size: f.file_size,
                file_type: f.file_type,
                encrypted_file_key: reWrapped,
                iv: f.iv || '',
                salt: f.salt || '',
                oss_key: f.oss_key,
              });
              console.info('[migrate] file key → Account Key:', f.id);
            }
          }
          if (f.is_directory) await walk(f.id);
        } catch (err) {
          console.warn('[migrate] skip', f.id, err);
        }
      }
    };
    await walk(null);
  };

  const navigateToFolder = async (folderId: string | null) => {
    setCurrentFolder(folderId);
    if (folderId === null) {
      setBreadcrumbs([{ id: null, name: '根目录' }]);
    } else {
      try {
        const file = await api.getFile(folderId);
        const name = await decryptName(file.name_encrypted);
        setBreadcrumbs(prev => {
          const existing = prev.findIndex(b => b.id === folderId);
          if (existing >= 0) return prev.slice(0, existing + 1);
          return [...prev, { id: folderId, name }];
        });
      } catch {}
    }
  };

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const fileList = e.target.files;
    if (!fileList || fileList.length === 0) return;

    setUploading(true);
    setUploadProgress(0);
    setError('');

    try {
      for (let i = 0; i < fileList.length; i++) {
        const file = fileList[i];
        setUploadProgress(Math.round(((i) / fileList.length) * 100));

        if (file.size > 200 * 1024 * 1024) {
          const sizeMb = (file.size / 1024 / 1024).toFixed(1);
          const proceed = confirm(
            `文件「${file.name}」(${sizeMb} MB) 超过 200MB，` +
            `大文件在浏览器内加密容易因内存不足而上传失败。\n\n是否仍要继续上传？`,
          );
          if (!proceed) continue;
        }

        const arrayBuffer = await file.arrayBuffer();
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const fileKey = await crypto.subtle.generateKey(
          { name: 'AES-GCM', length: 256 },
          true,
          ['encrypt', 'decrypt'],
        );

        const ciphertext = await crypto.subtle.encrypt(
          { name: 'AES-GCM', iv, tagLength: 128 },
          fileKey,
          arrayBuffer,
        );

        const fileKeyRaw = await crypto.subtle.exportKey('raw', fileKey);
        const fileKeyBase64 = btoa(String.fromCharCode(...new Uint8Array(fileKeyRaw)));

        const encryptedFileKey = await wrapFileKeyForStorage(fileKeyBase64);

        const nameEncrypted = await encryptName(file.name);

        const ossKeyRes = await api.generateOSSKey();
        const ossKey = ossKeyRes.oss_key;

        const presignRes = await api.getPresignUploadUrl(ossKey);
        await new Promise<void>((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.upload.onprogress = (ev) => {
            if (ev.lengthComputable) {
              const overall = Math.round(((i + ev.loaded / ev.total) / fileList.length) * 100);
              setUploadProgress(overall);
            }
          };
          xhr.onload = () => {
            if (xhr.status >= 200 && xhr.status < 300) resolve();
            else reject(new Error(`upload failed: ${xhr.status}`));
          };
          xhr.onerror = () => reject(new Error('network error'));
          xhr.open('PUT', presignRes.url);
          xhr.send(ciphertext);
        });

        await api.createFileRecord({
          name_encrypted: nameEncrypted,
          parent_id: currentFolder || undefined,
          file_size: ciphertext.byteLength,
          file_type: file.type,
          encrypted_file_key: encryptedFileKey,
          iv: Array.from(iv),
          salt: [],
          oss_key: ossKey,
        });
      }

      loadFiles(currentFolder, true);
    } catch (err) {
      console.error('upload error:', err);
      setError('上传失败: ' + (err as Error).message);
    } finally {
      setUploading(false);
      setUploadProgress(0);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleCreateFolder = async () => {
    if (!newFolderName.trim()) return;
    try {
      const nameEnc = await encryptName(newFolderName.trim());
      await api.createFolder(nameEnc, currentFolder || undefined);
      setNewFolderName('');
      setShowNewFolder(false);
      loadFiles(currentFolder, true);
    } catch (err) {
      setError('创建文件夹失败: ' + (err as Error).message);
    }
  };

  const handleCreateTextFile = async () => {
    const name = newTextFileName.trim() || '未命名文档';
    const fullName = name.endsWith('.txt') ? name : name + '.txt';
    try {
      const emptyContent = new TextEncoder().encode('');
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const fileKey = await crypto.subtle.generateKey(
        { name: 'AES-GCM', length: 256 },
        true,
        ['encrypt', 'decrypt'],
      );
      const ciphertext = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv, tagLength: 128 },
        fileKey,
        emptyContent,
      );
      const fileKeyRaw = await crypto.subtle.exportKey('raw', fileKey);
      const fileKeyBase64 = btoa(String.fromCharCode(...new Uint8Array(fileKeyRaw)));
      const encryptedFileKey = await wrapFileKeyForStorage(fileKeyBase64);
      const nameEncrypted = await encryptName(fullName);
      const ossKeyRes = await api.generateOSSKey();
      const ossKey = ossKeyRes.oss_key;
      const presignRes = await api.getPresignUploadUrl(ossKey);
      await new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) resolve();
          else reject(new Error(`upload failed: ${xhr.status}`));
        };
        xhr.onerror = () => reject(new Error('network error'));
        xhr.open('PUT', presignRes.url);
        xhr.send(ciphertext);
      });
      await api.createFileRecord({
        name_encrypted: nameEncrypted,
        parent_id: currentFolder || undefined,
        file_size: ciphertext.byteLength,
        file_type: 'text/plain',
        encrypted_file_key: encryptedFileKey,
        iv: Array.from(iv),
        salt: [],
        oss_key: ossKey,
      });
      setNewTextFileName('');
      setShowNewTextFile(false);
      loadFiles(currentFolder, true);
    } catch (err) {
      setError('创建文档失败: ' + (err as Error).message);
    }
  };

  const doDeleteFile = async (file: FileRecord) => {
    await api.deleteFile(file.id);
    loadFiles(currentFolder, true);
  };

  const handleDelete = async (file: FileRecord) => {
    if (!confirm(`确定删除 "${decryptedNames.get(file.id)}"？`)) return;
    try {
      await doDeleteFile(file);
    } catch (err: any) {
      if (err?.body?.mfa_required) {
        setMfaDeleteFile(file);
        setMfaCode('');
        setMfaError('');
      } else {
        setError('删除失败: ' + (err?.message || err));
      }
    }
  };

  const confirmDeleteMFA = async () => {
    if (!mfaDeleteFile) return;
    if (!/^\d{6}$/.test(mfaCode)) {
      setMfaError('请输入 6 位验证码');
      return;
    }
    setMfaBusy(true);
    setMfaError('');
    try {
      await api.verifyDeleteMFA(mfaCode);
      const file = mfaDeleteFile;
      setMfaDeleteFile(null);
      setMfaCode('');
      await doDeleteFile(file);
    } catch (err: any) {
      setMfaError(err?.message || '验证失败');
    } finally {
      setMfaBusy(false);
    }
  };

  const handleDownload = async (file: FileRecord) => {
    try {
      const blob = await downloadAndDecryptFile(file);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = decryptedNames.get(file.id) || 'download';
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError('下载失败');
    }
  };

  const downloadAndDecryptFile = async (file: FileRecord): Promise<Blob> => {
    const presignRes = await api.getPresignDownloadUrl(file.oss_key);
    const response = await fetch(presignRes.url);
    const ciphertext = await response.arrayBuffer();

    const fileKeyRaw = await unwrapFileKeyFromStorage(file.encrypted_file_key || '');
    const fileKey = await crypto.subtle.importKey(
      'raw',
      fileKeyRaw,
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
  };

  const handleContextMenu = (e: React.MouseEvent, file: FileRecord) => {
    e.preventDefault();
    e.stopPropagation();
    setEmptyMenu(null);
    const x = Math.max(8, Math.min(e.clientX, window.innerWidth - 190));
    const y = Math.max(8, Math.min(e.clientY, window.innerHeight - 260));
    setContextMenu({ file, x, y });
  };

  const handleEmptyContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    if (!contextMenu) {
      setEmptyMenu({ x: e.clientX, y: e.clientY });
    }
  };

  const startRename = (file: FileRecord) => {
    const name = decryptedNames.get(file.id) || '';
    setRenamingId(file.id);
    setRenameValue(name);
    setContextMenu(null);
    setTimeout(() => renameInputRef.current?.focus(), 0);
  };

  const submitRename = async () => {
    if (!renamingId || !renameValue.trim()) {
      setRenamingId(null);
      return;
    }
    try {
      const nameEncrypted = await encryptName(renameValue.trim());
      await api.renameFile(renamingId, nameEncrypted);
      loadFiles(currentFolder, true);
    } catch (err) {
      setError('重命名失败: ' + (err as Error).message);
    } finally {
      setRenamingId(null);
    }
  };

  const formatSize = (bytes: number): string => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  };

  const getFileIcon = (file: FileRecord) => {
    if (file.is_directory) return <Folder className="w-8 h-8 text-amber-400" />;
    const name = decryptedNames.get(file.id) || '';
    const mode = getPreviewMode(name);
    if (mode === 'image') return <Image className="w-8 h-8 text-purple-400" />;
    if (mode === 'text') return <FileText className="w-8 h-8 text-blue-400" />;
    if (mode === 'document') {
      if (resolvePreview(name)?.id === 'xlsx') {
        return <FileSpreadsheet className="w-8 h-8 text-emerald-400" />;
      }
      return <FileText className="w-8 h-8 text-sky-400" />;
    }
    return <File className="w-8 h-8 text-gray-400" />;
  };

  return (
    <div className="min-h-screen bg-gray-950 text-white">
      <header className="border-b border-gray-800 bg-gray-900/50 backdrop-blur sticky top-0 z-30">
        <div className="max-w-7xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <HardDrive className="w-5 h-5 text-emerald-400" />
            <h1 className="text-lg font-semibold">LitAOSS</h1>
          </div>
          <div className="flex items-center gap-4 text-sm text-gray-400">
            <button onClick={() => setShowSettings(true)} className="text-gray-400 hover:text-white transition-colors" title="设置">
              <SettingsIcon className="w-4 h-4" />
            </button>
            <button onClick={() => setShowLockConfirm(true)} className="text-gray-400 hover:text-white transition-colors" title="锁定">
              <Lock className="w-4 h-4" />
            </button>
          </div>
        </div>
      </header>

      <div className="max-w-7xl mx-auto px-4 py-4">

        {error && (
          <div className="mb-4 flex items-center gap-2 p-3 rounded-lg bg-red-500/10 text-red-400 text-sm">
            <AlertCircle className="w-4 h-4 flex-shrink-0" />
            {error}
            <button onClick={() => setError('')} className="ml-auto"><X className="w-4 h-4" /></button>
          </div>
        )}

        <div
          className="bg-gray-900/50 rounded-xl p-4 min-h-[60vh]"
          onContextMenu={handleEmptyContextMenu}
          onClick={() => setEmptyMenu(null)}
        >
          <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
          <div className="flex flex-wrap items-center gap-2">
            <input
              ref={fileInputRef}
              type="file"
              multiple
              onChange={handleUpload}
              className="hidden"
              id="file-upload"
            />
            <label
              htmlFor="file-upload"
              className="inline-flex items-center gap-2 px-4 py-2 bg-emerald-600 hover:bg-emerald-500 rounded-lg cursor-pointer transition-colors text-sm"
            >
              <Upload className="w-4 h-4" />
              上传文件
            </label>
            <button
              onClick={() => setShowNewFolder(true)}
              className="inline-flex items-center gap-2 px-4 py-2 bg-gray-800 hover:bg-gray-700 rounded-lg transition-colors text-sm"
            >
              <FolderPlus className="w-4 h-4" />
              <span className="hidden sm:inline">新建文件夹</span>
            </button>
            <button
              onClick={() => setShowNewTextFile(true)}
              className="inline-flex items-center gap-2 px-4 py-2 bg-gray-800 hover:bg-gray-700 rounded-lg transition-colors text-sm"
            >
              <FilePlus className="w-4 h-4" />
              <span className="hidden sm:inline">新建文档</span>
            </button>
          </div>
          <div className="flex flex-wrap items-center gap-2 ml-auto">
            <div className="flex flex-wrap items-center gap-1 min-w-0">
              {breadcrumbs.map((b, i) => (
                <span key={b.id || 'root'} className="flex items-center gap-1 flex-shrink-0 last:shrink last:min-w-0">
                  {i > 0 && <ChevronRight className="w-3 h-3 flex-shrink-0" />}
                  <button
                    onClick={() => navigateToFolder(b.id)}
                    className={`hover:text-white transition-colors text-sm text-gray-400 whitespace-nowrap overflow-hidden text-ellipsis ${
                      i === breadcrumbs.length - 1 ? 'text-white' : ''
                    }`}
                  >
                    {i === 0 ? <Home className="w-4 h-4" /> : b.name}
                  </button>
                </span>
              ))}
            </div>
            <div className="flex items-center gap-1 flex-shrink-0">
              <button
                onClick={() => setViewMode('grid')}
                className={`p-2 rounded ${viewMode === 'grid' ? 'bg-gray-700' : 'hover:bg-gray-800'}`}
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zm10 0a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zm10 0a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z" />
                </svg>
              </button>
              <button
                onClick={() => setViewMode('list')}
                className={`p-2 rounded ${viewMode === 'list' ? 'bg-gray-700' : 'hover:bg-gray-800'}`}
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
                </svg>
              </button>
            </div>
          </div>
        </div>

        {uploading && (
          <div className="mb-4 p-3 bg-emerald-500/10 rounded-lg">
            <div className="flex items-center justify-between text-sm text-emerald-400 mb-2">
              <span>加密上传中...</span>
              <span>{uploadProgress}%</span>
            </div>
            <div className="w-full bg-gray-800 rounded-full h-2">
              <div
                className="bg-emerald-500 h-2 rounded-full transition-all"
                style={{ width: `${uploadProgress}%` }}
              />
            </div>
          </div>
        )}

        {showNewFolder && (
          <div className="mb-4 flex items-center gap-2">
            <input
              type="text"
              value={newFolderName}
              onChange={(e) => setNewFolderName(e.target.value)}
              placeholder="文件夹名称"
              className="px-3 py-1.5 bg-gray-800 border border-gray-700 rounded text-white text-sm focus:outline-none focus:border-emerald-500"
              autoFocus
              onKeyDown={(e) => e.key === 'Enter' && handleCreateFolder()}
            />
            <button
              onClick={handleCreateFolder}
              className="p-1.5 bg-emerald-600 hover:bg-emerald-500 rounded text-white"
            >
              <Check className="w-4 h-4" />
            </button>
            <button
              onClick={() => { setShowNewFolder(false); setNewFolderName(''); }}
              className="p-1.5 bg-gray-700 hover:bg-gray-600 rounded text-white"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        )}

        {showNewTextFile && (
          <div className="mb-4 flex items-center gap-2">
            <input
              type="text"
              value={newTextFileName}
              onChange={(e) => setNewTextFileName(e.target.value)}
              placeholder="文档名称 (可选)"
              className="px-3 py-1.5 bg-gray-800 border border-gray-700 rounded text-white text-sm focus:outline-none focus:border-emerald-500"
              autoFocus
              onKeyDown={(e) => e.key === 'Enter' && handleCreateTextFile()}
            />
            <button
              onClick={handleCreateTextFile}
              className="p-1.5 bg-emerald-600 hover:bg-emerald-500 rounded text-white"
            >
              <Check className="w-4 h-4" />
            </button>
            <button
              onClick={() => { setShowNewTextFile(false); setNewTextFileName(''); }}
              className="p-1.5 bg-gray-700 hover:bg-gray-600 rounded text-white"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        )}

        {loading ? (
          <div className="text-center py-20 text-gray-400">加载中...</div>
        ) : files.length === 0 ? (
          <div className="text-center py-20 text-gray-400">
            <Folder className="w-16 h-16 mx-auto mb-4 text-gray-600" />
            <p>空空如也，上传一些文件吧</p>
          </div>
        ) : viewMode === 'grid' ? (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3">
            {files.map((file) => (
              <div
                key={file.id}
                className="group p-4 bg-gray-900 rounded-xl hover:bg-gray-800 transition-colors cursor-pointer relative"
                onClick={(e) => {
                  if (file.is_directory) {
                    navigateToFolder(file.id);
                  } else {
                    handleContextMenu(e, file);
                  }
                }}
                onContextMenu={(e) => handleContextMenu(e, file)}
              >
                <div className="flex flex-col items-center text-center">
                  <div className="mb-3">{getFileIcon(file)}</div>
                  {renamingId === file.id ? (
                    <input
                      ref={renameInputRef}
                      type="text"
                      value={renameValue}
                      onChange={(e) => setRenameValue(e.target.value)}
                      onClick={(e) => e.stopPropagation()}
                      onBlur={submitRename}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') submitRename();
                        if (e.key === 'Escape') setRenamingId(null);
                      }}
                      className="w-full px-1 py-0.5 bg-gray-800 border border-emerald-500 rounded text-sm text-white text-center focus:outline-none"
                    />
                  ) : (
                    <p className="text-sm text-white truncate w-full" title={decryptedNames.get(file.id)}>
                      {decryptedNames.get(file.id) || '...'}
                    </p>
                  )}
                  {!file.is_directory && (
                    <p className="text-xs text-gray-500 mt-1">{formatSize(file.file_size)}</p>
                  )}
                </div>
                <div className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity">
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      handleContextMenu(e, file);
                    }}
                    className="p-1 rounded bg-gray-700/80 hover:bg-gray-600"
                  >
                    <MoreVertical className="w-3 h-3" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="bg-gray-900 rounded-xl overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-800 text-gray-400 text-left">
                  <th className="px-4 py-3 font-medium">名称</th>
                  <th className="px-4 py-3 font-medium w-24 hidden sm:table-cell">大小</th>
                  <th className="px-4 py-3 font-medium w-32 hidden md:table-cell">修改时间</th>
                  <th className="px-4 py-3 font-medium w-24">操作</th>
                </tr>
              </thead>
              <tbody>
                {files.map((file) => (
                  <tr
                    key={file.id}
                    className="border-b border-gray-800/50 hover:bg-gray-800/50 cursor-pointer"
                    onClick={(e) => {
                      if (file.is_directory) navigateToFolder(file.id);
                      else handleContextMenu(e, file);
                    }}
                  >
                    <td className="px-4 py-3 flex items-center gap-3">
                      {getFileIcon(file)}
                      {renamingId === file.id ? (
                        <input
                          ref={renameInputRef}
                          type="text"
                          value={renameValue}
                          onChange={(e) => setRenameValue(e.target.value)}
                          onClick={(e) => e.stopPropagation()}
                          onBlur={submitRename}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') submitRename();
                            if (e.key === 'Escape') setRenamingId(null);
                          }}
                          className="flex-1 min-w-0 px-1 py-0.5 bg-gray-800 border border-emerald-500 rounded text-sm text-white focus:outline-none"
                        />
                      ) : (
                        <span className="truncate min-w-0 flex-1">{decryptedNames.get(file.id) || '...'}</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-gray-400 hidden sm:table-cell">
                      {file.is_directory ? '-' : formatSize(file.file_size)}
                    </td>
                    <td className="px-4 py-3 text-gray-400 hidden md:table-cell">
                      {new Date(file.updated_at).toLocaleDateString('zh-CN')}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1">
                        {!file.is_directory && (
                          <>
                            <button
                              onClick={(e) => { e.stopPropagation(); handleDownload(file); }}
                              className="p-1.5 hover:bg-gray-700 rounded transition-colors"
                              title="下载"
                            >
                              <Download className="w-4 h-4 text-gray-400" />
                            </button>
                            <button
                              onClick={(e) => { e.stopPropagation(); setVersionFile(file); }}
                              className="p-1.5 hover:bg-gray-700 rounded transition-colors"
                              title="历史版本"
                            >
                              <History className="w-4 h-4 text-gray-400" />
                            </button>
                            {getPreviewMode(decryptedNames.get(file.id) || '') === 'text' && (
                              <button
                                onClick={(e) => { e.stopPropagation(); setEditingFile(file); }}
                                className="p-1.5 hover:bg-gray-700 rounded transition-colors"
                                title="编辑"
                              >
                                <Edit3 className="w-4 h-4 text-gray-400" />
                              </button>
                            )}
                          </>
                        )}
                        <button
                          onClick={(e) => { e.stopPropagation(); handleDelete(file); }}
                          className="p-1.5 hover:bg-red-500/20 rounded transition-colors"
                          title="删除"
                        >
                          <Trash2 className="w-4 h-4 text-gray-400" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        </div>
      </div>

      {contextMenu && (
        <>
          <div
            className="fixed inset-0 z-40"
            onClick={() => setContextMenu(null)}
          />
          <div
            className="fixed z-50 bg-gray-800 border border-gray-700 rounded-lg shadow-xl py-1 min-w-[160px]"
            style={{ left: contextMenu.x, top: contextMenu.y }}
          >
            {contextMenu.file.is_directory ? (
              <>
                <button
                  className="w-full px-3 py-2 text-left text-sm hover:bg-gray-700 flex items-center gap-2"
                  onClick={() => {
                    navigateToFolder(contextMenu.file.id);
                    setContextMenu(null);
                  }}
                >
                  <Folder className="w-4 h-4" /> 打开
                </button>
                <button
                  className="w-full px-3 py-2 text-left text-sm hover:bg-gray-700 flex items-center gap-2"
                  onClick={() => {
                    startRename(contextMenu.file);
                  }}
                >
                  <Edit3 className="w-4 h-4" /> 重命名
                </button>
              </>
            ) : (
              <>
                {getPreviewMode(decryptedNames.get(contextMenu.file.id) || '') !== 'unsupported' && (
                  <button
                    className="w-full px-3 py-2 text-left text-sm hover:bg-gray-700 flex items-center gap-2"
                    onClick={() => {
                      setPreviewFile(contextMenu.file);
                      setContextMenu(null);
                    }}
                  >
                    <Eye className="w-4 h-4" /> 预览
                  </button>
                )}
                <button
                  className="w-full px-3 py-2 text-left text-sm hover:bg-gray-700 flex items-center gap-2"
                  onClick={() => {
                    handleDownload(contextMenu.file);
                    setContextMenu(null);
                  }}
                >
                  <Download className="w-4 h-4" /> 下载
                </button>
                <button
                  className="w-full px-3 py-2 text-left text-sm hover:bg-gray-700 flex items-center gap-2"
                  onClick={() => {
                    setVersionFile(contextMenu.file);
                    setContextMenu(null);
                  }}
                >
                  <History className="w-4 h-4" /> 历史版本
                </button>
                <button
                  className="w-full px-3 py-2 text-left text-sm hover:bg-gray-700 flex items-center gap-2"
                  onClick={() => {
                    startRename(contextMenu.file);
                  }}
                >
                  <Edit3 className="w-4 h-4" /> 重命名
                </button>
                {getPreviewMode(decryptedNames.get(contextMenu.file.id) || '') === 'text' && (
                  <button
                    className="w-full px-3 py-2 text-left text-sm hover:bg-gray-700 flex items-center gap-2"
                    onClick={() => {
                      setEditingFile(contextMenu.file);
                      setContextMenu(null);
                    }}
                  >
                    <Edit3 className="w-4 h-4" /> 编辑
                  </button>
                )}
              </>
            )}
            <button
              className="w-full px-3 py-2 text-left text-sm hover:bg-red-500/20 text-red-400 flex items-center gap-2"
              onClick={() => {
                handleDelete(contextMenu.file);
                setContextMenu(null);
              }}
            >
              <Trash2 className="w-4 h-4" /> 删除
            </button>
          </div>
        </>
      )}

      {emptyMenu && (
        <div
          className="fixed z-50 bg-gray-800 border border-gray-700 rounded-lg shadow-xl py-1 min-w-[160px]"
          style={{ left: emptyMenu.x, top: emptyMenu.y }}
          onClick={() => setEmptyMenu(null)}
        >
          {currentFolder && (
            <button
              className="w-full px-3 py-2 text-left text-sm hover:bg-gray-700 flex items-center gap-2"
              onClick={() => {
                navigateToFolder(
                  breadcrumbs.length > 1 ? breadcrumbs[breadcrumbs.length - 2].id : null
                );
              }}
            >
              <ChevronRight className="w-4 h-4 rotate-180" /> 返回上一级
            </button>
          )}
          <button
            className="w-full px-3 py-2 text-left text-sm hover:bg-gray-700 flex items-center gap-2"
            onClick={() => {
              setShowNewFolder(true);
              setEmptyMenu(null);
            }}
          >
            <FolderPlus className="w-4 h-4" /> 新建文件夹
          </button>
          <button
            className="w-full px-3 py-2 text-left text-sm hover:bg-gray-700 flex items-center gap-2"
            onClick={() => {
              setShowNewTextFile(true);
              setEmptyMenu(null);
            }}
          >
            <FilePlus className="w-4 h-4" /> 新建文档
          </button>
        </div>
      )}

      {previewFile && (
        <FilePreview
          file={previewFile}
          fileName={decryptedNames.get(previewFile.id) || ''}
          onClose={() => setPreviewFile(null)}
        />
      )}

      {editingFile && (
        <TextEditor
          file={editingFile}
          fileName={decryptedNames.get(editingFile.id) || ''}
          onClose={() => { setEditingFile(null); loadFiles(currentFolder, true); }}
        />
      )}

      {versionFile && (
        <VersionHistory
          file={versionFile}
          fileName={decryptedNames.get(versionFile.id) || ''}
          onClose={() => setVersionFile(null)}
          onChanged={() => loadFiles(currentFolder, true)}
        />
      )}

      {showSettings && <Settings onClose={() => setShowSettings(false)} />}

      {mfaDeleteFile && (
        <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4" onClick={() => setMfaDeleteFile(null)}>
          <div
            className="bg-gray-900 rounded-2xl p-6 w-full max-w-sm"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-3 mb-4">
              <div className="p-2 bg-emerald-500/10 rounded-lg">
                <Shield className="w-5 h-5 text-emerald-400" />
              </div>
              <h3 className="text-lg font-semibold text-white">删除需要验证</h3>
            </div>
            <p className="text-gray-400 text-sm mb-4">
              删除前请输入 TOTP 验证码（同一会话仅首次删除需要验证）。
            </p>
            <input
              type="text"
              inputMode="numeric"
              maxLength={6}
              value={mfaCode}
              autoFocus
              onChange={(e) => setMfaCode(e.target.value.replace(/\D/g, ''))}
              onKeyDown={(e) => { if (e.key === 'Enter') confirmDeleteMFA(); }}
              placeholder="6 位验证码"
              className="w-full px-4 py-2.5 bg-gray-800 border border-gray-700 rounded-lg text-white text-center tracking-widest placeholder-gray-500 focus:outline-none focus:border-emerald-500 mb-3"
            />
            {mfaError && (
              <div className="flex items-center gap-2 p-2.5 rounded-lg bg-red-500/10 text-red-400 text-sm mb-3">
                <AlertCircle className="w-4 h-4 flex-shrink-0" />
                {mfaError}
              </div>
            )}
            <div className="flex gap-3">
              <button
                onClick={() => setMfaDeleteFile(null)}
                className="flex-1 py-2.5 bg-gray-800 hover:bg-gray-700 text-white rounded-lg font-medium transition-colors"
              >
                取消
              </button>
              <button
                onClick={confirmDeleteMFA}
                disabled={mfaBusy}
                className="flex-1 py-2.5 bg-emerald-600 hover:bg-emerald-500 disabled:bg-gray-700 disabled:text-gray-500 text-white rounded-lg font-medium transition-colors"
              >
                {mfaBusy ? '验证中...' : '验证并删除'}
              </button>
            </div>
          </div>
        </div>
      )}

      {showLockConfirm && (
        <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4" onClick={() => setShowLockConfirm(false)}>
          <div
            className="bg-gray-900 rounded-2xl p-6 w-full max-w-sm"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-3 mb-4">
              <div className="p-2 bg-amber-500/10 rounded-lg">
                <Lock className="w-5 h-5 text-amber-400" />
              </div>
              <h3 className="text-lg font-semibold text-white">确认锁定</h3>
            </div>
            <p className="text-gray-400 text-sm mb-6">
              锁定后需要重新输入密码才能访问文件。确定要锁定吗？
            </p>
            <div className="flex gap-3">
              <button
                onClick={() => setShowLockConfirm(false)}
                className="flex-1 py-2.5 bg-gray-800 hover:bg-gray-700 text-white rounded-lg font-medium transition-colors"
              >
                取消
              </button>
              <button
                onClick={() => { setShowLockConfirm(false); onLock(); }}
                className="flex-1 py-2.5 bg-amber-600 hover:bg-amber-500 text-white rounded-lg font-medium transition-colors"
              >
                锁定
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
