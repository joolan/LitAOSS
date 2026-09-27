import { useState, useRef, useEffect, useCallback } from 'react';
import {
  Upload, FolderPlus, Trash2, Download, Eye, Edit3, File, Image,
  ChevronRight, Home, MoreVertical, X, Save, Check, HardDrive, Folder,
  FileText, AlertCircle, FilePlus, Settings as SettingsIcon, Lock, History, Shield,
  FileSpreadsheet, CheckSquare, Square, Move,
} from 'lucide-react';
import { api, FileRecord, fromBase64Bytes } from '../api/client';
import { getSessionPassword } from '../session';
import {
  wrapFileKeyForStorage, unwrapFileKeyFromStorage,
  encryptNameForStorage, decryptNameForStorage, isLegacyEncryptedName, rewrapLegacyFileKey,
} from '../crypto/fileKey';
import { getPreviewMode } from '../crypto/crypto';
import { getThumb, thumbKey } from '../preview';
import { canDragOut, peekPlain, prefetchPlain, dragOutPref, setDragOutPref } from '../plainCache';
import { contentHash } from '../contentHash';
import { resolvePreview } from '../preview';
import { collectDroppedFiles, collectPickedFiles } from '../upload/walkEntries';
import { PendingUpload } from '../upload/types';
import FilePreview from './FilePreview';
import TextEditor from './TextEditor';
import VersionHistory from './VersionHistory';
import Settings from './Settings';
import UploadQueueDialog from './UploadQueueDialog';
import FolderPicker from './FolderPicker';
import { getCachedSnapshot, putCachedSnapshot, invalidateListCache } from '../fileListCache';

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
  const [uploadQueue, setUploadQueue] = useState<PendingUpload[] | null>(null);
  const [dragActive, setDragActive] = useState(false);
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
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [showMovePicker, setShowMovePicker] = useState(false);
  const [dragConsent, setDragConsent] = useState<FileRecord | null>(null);
  const [batchBusy, setBatchBusy] = useState(false);
  const [mfaDelete, setMfaDelete] = useState<{ ids: string[]; batch: boolean } | null>(null);
  const [mfaCode, setMfaCode] = useState('');
  const [mfaError, setMfaError] = useState('');
  const [mfaBusy, setMfaBusy] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [thumbs, setThumbs] = useState<Map<string, string>>(new Map());
  const [thumbsRev, setThumbsRev] = useState(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const dragDepthRef = useRef(0);
  const loadSeqRef = useRef(0);

  const decryptName = useCallback(async (encryptedName: string): Promise<string> => {
    if (!getSessionPassword()) return '(未解锁)';
    const name = await decryptNameForStorage(encryptedName);
    return name ?? '(无法解密)';
  }, []);

  const encryptName = useCallback(async (name: string): Promise<string> => {
    return encryptNameForStorage(name);
  }, []);

  const loadFiles = useCallback(async (parentId: string | null, silent = false) => {
    // 序号守卫：只展示最后一次发起的加载，避免快速进退目录时旧响应覆盖新视图
    const seq = ++loadSeqRef.current;
    if (!silent) setLoading(true);

    // 导航（非静默）优先命中快照缓存：零请求、零解密；
    // 静默调用 = 数据变更后的强制重取，取回后回写缓存
    if (!silent) {
      const hit = getCachedSnapshot(parentId);
      if (hit) {
        setFiles(hit.files);
        setDecryptedNames(hit.decryptedNames);
        setStats(hit.stats);
        setLoading(false);
        return;
      }
    }

    try {
      const [res, s] = await Promise.all([
        api.listFiles(parentId || undefined),
        api.getStats(),
      ]);
      if (seq !== loadSeqRef.current) return;
      const files = res.files || [];
      const entries = await Promise.all(
        files.map(async (f) => [f.id, await decryptName(f.name_encrypted)] as const),
      );
      if (seq !== loadSeqRef.current) return;
      const names = new Map(entries);
      setFiles(files);
      setDecryptedNames(names);
      setStats(s);
      putCachedSnapshot(parentId, { files, decryptedNames: names, stats: s });
    } catch (err) {
      console.error('load files error:', err);
    } finally {
      if (!silent && seq === loadSeqRef.current) setLoading(false);
    }
  }, [decryptName]);

  useEffect(() => {
    loadFiles(currentFolder);
  }, [currentFolder, loadFiles]);

  // 网格缩略图：只读「预览时已生成」的缓存，不为展示解密图片
  const thumbUrlsRef = useRef<Map<string, string>>(new Map());
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const imageFiles = files.filter(
        (f) => !f.is_directory && getPreviewMode(decryptedNames.get(f.id) || '') === 'image',
      );
      const next = new Map<string, string>();
      for (const f of imageFiles) {
        const blob = await getThumb(thumbKey(f));
        if (cancelled) {
          for (const u of next.values()) URL.revokeObjectURL(u);
          return;
        }
        if (blob) next.set(f.id, URL.createObjectURL(blob));
      }
      if (cancelled) return;
      for (const u of thumbUrlsRef.current.values()) URL.revokeObjectURL(u);
      thumbUrlsRef.current = next;
      setThumbs(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [files, decryptedNames, thumbsRev]);

  useEffect(
    () => () => {
      for (const u of thumbUrlsRef.current.values()) URL.revokeObjectURL(u);
      // 缓存含明文文件名，锁定/卸载时清除
      invalidateListCache();
    },
    [],
  );

  const migrationRef = useRef(false);
  const MIGRATION_FLAG = 'lit-aoss-names-rewrapped-v2';

  // 旧版密钥域（主密码派生）→ Account Key 的一次性回填。
  // 完整成功后写入 localStorage，此后每次打开不再全树遍历；
  // 有失败项则下次启动继续（幂等，重复执行只命中已迁移项）。
  useEffect(() => {
    if (migrationRef.current) return;
    migrationRef.current = true;
    if (localStorage.getItem(MIGRATION_FLAG)) return;
    migrateLegacyData()
      .then((hadError) => {
        if (!hadError) {
          try {
            localStorage.setItem(MIGRATION_FLAG, '1');
          } catch {}
          invalidateListCache();
        }
      })
      .catch((err) => console.warn('[migrate] failed:', err));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const migrateLegacyData = async (): Promise<boolean> => {
    let hadError = false;
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
                content_hash: '',
              });
              console.info('[migrate] file key → Account Key:', f.id);
            }
          }
          if (f.is_directory) await walk(f.id);
        } catch (err) {
          hadError = true;
          console.warn('[migrate] skip', f.id, err);
        }
      }
    };
    await walk(null);
    return hadError;
  };

  const navigateToFolder = async (folderId: string | null) => {
    setCurrentFolder(folderId);
    setSelected(new Set());
    setInfo('');
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

  const handlePickFiles = (e: React.ChangeEvent<HTMLInputElement>) => {
    const fileList = e.target.files;
    if (!fileList || fileList.length === 0) {
      e.target.value = '';
      return;
    }
    const items = collectPickedFiles(fileList);
    e.target.value = '';
    setUploadQueue(items);
  };

  const hasFiles = (e: React.DragEvent) =>
    Array.from(e.dataTransfer?.types || []).includes('Files');

  const handleDragEnter = (e: React.DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepthRef.current += 1;
    setDragActive(true);
  };

  const handleDragOver = (e: React.DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  };

  const handleDragLeave = (e: React.DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setDragActive(false);
  };

  const handleDrop = async (e: React.DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepthRef.current = 0;
    setDragActive(false);
    try {
      const items = await collectDroppedFiles(e.dataTransfer);
      if (items.length > 0) {
        setUploadQueue(items);
      } else {
        setError('无法读取拖入的文件');
      }
    } catch (err) {
      console.error('drop error:', err);
      setError('读取拖入的文件失败: ' + (err as Error).message);
    }
  };

  useEffect(() => {
    const prevent = (e: DragEvent) => e.preventDefault();
    window.addEventListener('dragover', prevent);
    window.addEventListener('drop', prevent);
    return () => {
      window.removeEventListener('dragover', prevent);
      window.removeEventListener('drop', prevent);
    };
  }, []);

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
        content_hash: await contentHash(emptyContent).catch(() => ''),
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
        setMfaDelete({ ids: [file.id], batch: false });
        setMfaCode('');
        setMfaError('');
      } else {
        setError('删除失败: ' + (err?.message || err));
      }
    }
  };

  const confirmDeleteMFA = async () => {
    if (!mfaDelete) return;
    if (!/^\d{6}$/.test(mfaCode)) {
      setMfaError('请输入 6 位验证码');
      return;
    }
    setMfaBusy(true);
    setMfaError('');
    try {
      await api.verifyDeleteMFA(mfaCode);
      const pending = mfaDelete;
      setMfaDelete(null);
      setMfaCode('');
      if (pending.batch) {
        await api.batchDelete(pending.ids);
        setSelected(new Set());
        setSelectMode(false);
      } else {
        await api.deleteFile(pending.ids[0]);
      }
      loadFiles(currentFolder, true);
    } catch (err: any) {
      setMfaError(err?.message || '验证失败');
    } finally {
      setMfaBusy(false);
    }
  };

  const toggleSelect = (id: string) => {
    setInfo('');
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // 拖出下载：仅在用户同意（localStorage 持久化）后，才在按下鼠标时预取明文
  const startPlainPrefetch = (file: FileRecord) => {
    if (selectMode || dragOutPref() !== 'on') return;
    prefetchPlain(file)?.catch(() => {});
  };

  const confirmDragConsent = (enabled: boolean) => {
    setDragOutPref(enabled);
    const file = dragConsent;
    setDragConsent(null);
    if (enabled && file) prefetchPlain(file)?.catch(() => {});
  };

  const handleItemDragStart = (e: React.DragEvent, file: FileRecord) => {
    if (selectMode || !canDragOut(file)) return;
    const pref = dragOutPref();
    if (pref === 'unset') {
      // 首次拖拽：取消本次拖拽并弹出授权说明，之后不再询问
      e.preventDefault();
      setDragConsent(file);
      return;
    }
    if (pref === 'off') {
      e.preventDefault();
      return;
    }
    const name = decryptedNames.get(file.id) || '下载文件';
    const entry = peekPlain(file);
    if (!entry) {
      // 明文尚未解密完成：取消本次拖拽（否则拖出窗口会显示禁止光标），
      // 预取继续进行，稍后重新按住拖出即可命中缓存
      e.preventDefault();
      prefetchPlain(file)?.catch(() => {});
      setInfo(`「${name}」解密中，稍候重新按住拖出即可`);
      return;
    }
    setInfo('');
    e.dataTransfer.setData('text/plain', name);
    const mime = file.file_type || 'application/octet-stream';
    if (entry.dataUrl) {
      // data:URL 自包含：dragstart 同步设置，落盘不依赖 blob URL 拉取时序
      e.dataTransfer.setData('DownloadURL', `${mime}:${name}:${entry.dataUrl}`);
      e.dataTransfer.effectAllowed = 'copy';
    } else if (entry.blob) {
      const url = URL.createObjectURL(entry.blob);
      e.dataTransfer.setData('DownloadURL', `${mime}:${name}:${url}`);
      e.dataTransfer.effectAllowed = 'copy';
      // 浏览器在 dragend 之后才实际拉取 blob URL 完成落盘，
      // 立即 revoke 会导致「有下载提示但记录为空」；延迟释放
      window.addEventListener(
        'dragend',
        () => {
          window.setTimeout(() => URL.revokeObjectURL(url), 120_000);
        },
        { once: true },
      );
    }
  };

  const exitSelectMode = () => {
    setSelectMode(false);
    setSelected(new Set());
    setInfo('');
  };

  const allSelected = files.length > 0 && files.every(f => selected.has(f.id));
  const selectedFileCount = files.filter(f => selected.has(f.id) && !f.is_directory).length;
  const selectedFolderCount = files.filter(f => selected.has(f.id) && f.is_directory).length;

  const toggleSelectAll = () => {
    setInfo('');
    setSelected(allSelected ? new Set() : new Set(files.map(f => f.id)));
  };

  const handleBatchDelete = async () => {
    const ids = [...selected];
    if (ids.length === 0 || batchBusy) return;
    if (!confirm(`确定删除选中的 ${ids.length} 项？`)) return;
    setBatchBusy(true);
    try {
      await api.batchDelete(ids);
      setSelected(new Set());
      setSelectMode(false);
      loadFiles(currentFolder, true);
    } catch (err: any) {
      if (err?.body?.mfa_required) {
        setMfaDelete({ ids, batch: true });
        setMfaCode('');
        setMfaError('');
      } else {
        setError('批量删除失败: ' + (err?.message || err));
      }
    } finally {
      setBatchBusy(false);
    }
  };

  const handleBatchDownload = async () => {
    if (batchBusy) return;
    const targets = files.filter(f => selected.has(f.id) && !f.is_directory);
    const skippedFolders = selected.size - targets.length;
    if (skippedFolders > 0) {
      setInfo(
        targets.length > 0
          ? `文件夹不支持下载：已跳过 ${skippedFolders} 个文件夹，将下载 ${targets.length} 个文件`
          : '文件夹不支持下载，请仅选择文件进行下载',
      );
    } else {
      setInfo('');
    }
    if (targets.length === 0) return;
    setBatchBusy(true);
    let failed = 0;
    for (const f of targets) {
      try {
        const blob = await downloadAndDecryptFile(f);
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = decryptedNames.get(f.id) || 'download';
        a.click();
        URL.revokeObjectURL(url);
        await new Promise(r => setTimeout(r, 200));
      } catch {
        failed++;
      }
    }
    setBatchBusy(false);
    if (failed > 0) {
      setError(`下载完成：${failed}/${targets.length} 个文件失败`);
    }
  };

  const handleBatchMovePick = async (targetId: string | null) => {
    setShowMovePicker(false);
    const ids = [...selected];
    if (ids.length === 0 || batchBusy) return;
    setBatchBusy(true);
    const messages = new Set<string>();
    for (const id of ids) {
      try {
        await api.moveFile(id, targetId);
      } catch (err: any) {
        messages.add(err?.message || '移动失败');
      }
    }
    setBatchBusy(false);
    if (messages.size > 0) {
      setError(`移动失败 ${messages.size}/${ids.length} 项：${[...messages].join('；')}`);
    } else {
      setSelected(new Set());
      setSelectMode(false);
    }
    loadFiles(currentFolder, true);
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

        {info && (
          <div className="mb-4 flex items-center gap-2 p-3 rounded-lg bg-sky-500/10 text-sky-300 text-sm">
            <AlertCircle className="w-4 h-4 flex-shrink-0" />
            {info}
            <button onClick={() => setInfo('')} className="ml-auto" title="关闭"><X className="w-4 h-4" /></button>
          </div>
        )}

        <div
          className="relative bg-gray-900/50 rounded-xl p-4 min-h-[60vh]"
          onContextMenu={handleEmptyContextMenu}
          onClick={() => setEmptyMenu(null)}
          onDragEnter={handleDragEnter}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          {dragActive && (
            <div className="absolute inset-0 z-20 rounded-xl border-2 border-dashed border-emerald-400 bg-emerald-500/10 flex flex-col items-center justify-center gap-3 pointer-events-none">
              <Upload className="w-10 h-10 text-emerald-400" />
              <p className="text-sm font-medium text-emerald-300">松开鼠标，添加到上传队列</p>
              <p className="text-xs text-emerald-400/70">支持文件与文件夹，文件夹将保持原有层级</p>
            </div>
          )}
          <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
          <div className="flex flex-wrap items-center gap-2">
            <input
              ref={fileInputRef}
              type="file"
              multiple
              onChange={handlePickFiles}
              className="hidden"
              id="file-upload"
            />
            <input
              ref={folderInputRef}
              type="file"
              multiple
              onChange={handlePickFiles}
              className="hidden"
              id="folder-upload"
              {...({ webkitdirectory: '', directory: '' } as Record<string, string>)}
            />
            <label
              htmlFor="file-upload"
              className="inline-flex items-center gap-2 px-4 py-2 bg-emerald-600 hover:bg-emerald-500 rounded-lg cursor-pointer transition-colors text-sm"
            >
              <Upload className="w-4 h-4" />
              上传文件
            </label>
            <label
              htmlFor="folder-upload"
              className="inline-flex items-center gap-2 px-4 py-2 bg-emerald-600/80 hover:bg-emerald-500 rounded-lg cursor-pointer transition-colors text-sm"
            >
              <Folder className="w-4 h-4" />
              上传文件夹
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
            <button
              onClick={() => (selectMode ? exitSelectMode() : setSelectMode(true))}
              className={`inline-flex items-center gap-2 px-4 py-2 rounded-lg transition-colors text-sm ${
                selectMode
                  ? 'bg-emerald-600/20 text-emerald-300 border border-emerald-500/50'
                  : 'bg-gray-800 hover:bg-gray-700'
              }`}
              title="多选批量操作"
            >
              {selectMode ? <CheckSquare className="w-4 h-4" /> : <Square className="w-4 h-4" />}
              <span className="hidden sm:inline">{selectMode ? '退出选择' : '选择'}</span>
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

        {selectMode && (
          <div className="mb-4 flex flex-wrap items-center gap-2 p-3 bg-emerald-500/10 border border-emerald-500/30 rounded-xl text-sm">
            <span className="text-emerald-300 font-medium">已选 {selected.size} 项</span>
            <button
              onClick={toggleSelectAll}
              className="px-3 py-1.5 bg-gray-800 hover:bg-gray-700 rounded-lg transition-colors"
            >
              {allSelected ? '取消全选' : '全选'}
            </button>
            <button
              onClick={() => { setSelected(new Set()); setInfo(''); }}
              disabled={selected.size === 0}
              className="px-3 py-1.5 bg-gray-800 hover:bg-gray-700 disabled:opacity-40 rounded-lg transition-colors"
            >
              清空
            </button>
            <div className="ml-auto flex flex-wrap items-center gap-2">
              <button
                onClick={handleBatchDownload}
                disabled={batchBusy || selected.size === 0}
                title={
                  selectedFolderCount > 0
                    ? `文件夹不支持下载（${selectedFolderCount} 个将被跳过）`
                    : '下载选中的文件'
                }
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg transition-colors disabled:opacity-40 ${
                  selectedFolderCount > 0 && selectedFileCount === 0
                    ? 'bg-gray-800 text-gray-500'
                    : 'bg-gray-800 hover:bg-gray-700'
                }`}
              >
                <Download className="w-4 h-4" />
                下载{selectedFileCount > 0 ? ` (${selectedFileCount})` : ''}
              </button>
              <button
                onClick={() => setShowMovePicker(true)}
                disabled={batchBusy || selected.size === 0}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-gray-800 hover:bg-gray-700 disabled:opacity-40 rounded-lg transition-colors"
              >
                <Move className="w-4 h-4" /> 移动
              </button>
              <button
                onClick={handleBatchDelete}
                disabled={batchBusy || selected.size === 0}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-red-600/80 hover:bg-red-500 disabled:opacity-40 text-white rounded-lg transition-colors"
              >
                <Trash2 className="w-4 h-4" /> 删除
              </button>
              <button
                onClick={exitSelectMode}
                className="p-1.5 bg-gray-800 hover:bg-gray-700 rounded-lg transition-colors"
                title="退出选择"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            {batchBusy && <span className="text-gray-400 text-xs">处理中...</span>}
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
                className={`group p-4 bg-gray-900 rounded-xl hover:bg-gray-800 transition-colors cursor-pointer relative ${
                  selectMode && selected.has(file.id)
                    ? 'ring-2 ring-emerald-500 bg-emerald-500/10'
                    : ''
                }`}
                onClick={(e) => {
                  if (selectMode) {
                    toggleSelect(file.id);
                    return;
                  }
                  if (file.is_directory) {
                    navigateToFolder(file.id);
                  } else {
                    handleContextMenu(e, file);
                  }
                }}
                onContextMenu={(e) => handleContextMenu(e, file)}
                draggable={canDragOut(file) && !selectMode}
                onDragStart={(e) => handleItemDragStart(e, file)}
                onMouseDown={() => startPlainPrefetch(file)}
              >
                {selectMode && (
                  <div className="absolute top-2 left-2" onClick={(e) => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      checked={selected.has(file.id)}
                      onChange={() => toggleSelect(file.id)}
                      className="w-4 h-4 accent-emerald-500 cursor-pointer"
                    />
                  </div>
                )}                <div className="flex flex-col items-center text-center">
                  <div className="mb-3">
                    {thumbs.get(file.id) ? (
                      <img
                        src={thumbs.get(file.id)}
                        alt=""
                        draggable={false}
                        className="w-12 h-12 object-contain mx-auto"
                      />
                    ) : (
                      getFileIcon(file)
                    )}
                  </div>
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
                    <p
                      className="text-sm text-white truncate w-full"
                      title={
                        canDragOut(file)
                          ? `${decryptedNames.get(file.id) || ''}（按住可拖出到桌面/资源管理器直接保存）`
                          : decryptedNames.get(file.id)
                      }
                    >
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
                  {selectMode && <th className="px-3 py-3 w-10" />}
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
                    className={`border-b border-gray-800/50 hover:bg-gray-800/50 cursor-pointer ${
                      selectMode && selected.has(file.id) ? 'bg-emerald-500/10' : ''
                    }`}
                    onClick={(e) => {
                      if (selectMode) {
                        toggleSelect(file.id);
                        return;
                      }
                      if (file.is_directory) navigateToFolder(file.id);
                      else handleContextMenu(e, file);
                    }}
                    draggable={canDragOut(file) && !selectMode}
                    onDragStart={(e) => handleItemDragStart(e, file)}
                    onMouseDown={() => startPlainPrefetch(file)}
                  >
                    {selectMode && (
                      <td className="px-3 py-3" onClick={(e) => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          checked={selected.has(file.id)}
                          onChange={() => toggleSelect(file.id)}
                          className="w-4 h-4 accent-emerald-500 cursor-pointer"
                        />
                      </td>
                    )}
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
          onClose={() => {
            setPreviewFile(null);
            setThumbsRev((v) => v + 1);
          }}
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

      {mfaDelete && (
        <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4">
          <div
            className="bg-gray-900 rounded-2xl p-6 w-full max-w-sm"
          >
            <div className="flex items-center gap-3 mb-4">
              <div className="p-2 bg-emerald-500/10 rounded-lg">
                <Shield className="w-5 h-5 text-emerald-400" />
              </div>
              <h3 className="text-lg font-semibold text-white">
                {mfaDelete.batch
                  ? `批量删除需要验证（${mfaDelete.ids.length} 项）`
                  : '删除需要验证'}
              </h3>
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
                onClick={() => setMfaDelete(null)}
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

      {dragConsent && (
        <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4">
          <div className="bg-gray-900 rounded-2xl p-6 w-full max-w-sm">
            <div className="flex items-center gap-3 mb-4">
              <div className="p-2 bg-emerald-500/10 rounded-lg">
                <Download className="w-5 h-5 text-emerald-400" />
              </div>
              <h3 className="text-lg font-semibold text-white">开启拖出下载？</h3>
            </div>
            <p className="text-gray-400 text-sm mb-2">
              开启后，按住文件拖动会提前从 OSS 下载并解密该文件（仅存于本机内存，不落盘），
              会产生额外的流量与解密开销，建议仅对小文件使用。
            </p>
            <p className="text-gray-500 text-xs mb-4">
              选择会保存在本机浏览器，之后不再询问。
            </p>
            <div className="flex gap-3">
              <button
                onClick={() => confirmDragConsent(false)}
                className="flex-1 py-2.5 bg-gray-800 hover:bg-gray-700 text-white rounded-lg font-medium transition-colors"
              >
                暂不开启
              </button>
              <button
                onClick={() => confirmDragConsent(true)}
                className="flex-1 py-2.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg font-medium transition-colors"
              >
                开启
              </button>
              </div>
          </div>
        </div>
      )}

      {showLockConfirm && (
        <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4">
          <div
            className="bg-gray-900 rounded-2xl p-6 w-full max-w-sm"
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

      {uploadQueue && (
        <UploadQueueDialog
          items={uploadQueue}
          targetFolderId={currentFolder}
          targetLabel={breadcrumbs.map((b) => b.name).join(' / ')}
          onClose={() => setUploadQueue(null)}
          onUploaded={() => loadFiles(currentFolder, true)}
        />
      )}

      {showMovePicker && (
        <FolderPicker
          onPick={handleBatchMovePick}
          onClose={() => setShowMovePicker(false)}
        />
      )}
    </div>
  );
}
