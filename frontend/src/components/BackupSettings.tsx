import { useState, useEffect } from 'react';
import { Database, Clock, RefreshCw, AlertCircle, Check, Download, Trash2, Shield, Cloud } from 'lucide-react';
import { api, BackupConfig, BackupEntry, OSSBackupEntry, OSSBackupSummary, DrillReport } from '../api/client';

interface BackupSettingsProps {
  onError: (msg: string) => void;
  onSuccess: (msg: string) => void;
}

type PendingRestore =
  | { kind: 'local'; name: string }
  | { kind: 'oss'; ossKey: string };

function formatSize(bytes: number): string {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

export default function BackupSettings({ onError, onSuccess }: BackupSettingsProps) {
  const [config, setConfig] = useState<BackupConfig>({
    auto_backup: false,
    backup_time: '03:00',
    on_file_change: false,
    min_interval: 300,
    max_backups: 10,
    auto_backup_upload_oss: false,
    on_file_change_upload_oss: false,
  });
  const [backups, setBackups] = useState<BackupEntry[]>([]);
  const [ossBackups, setOssBackups] = useState<OSSBackupEntry[]>([]);
  const [ossSummary, setOssSummary] = useState<OSSBackupSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [restoring, setRestoring] = useState<string | null>(null);
  const [restoringOss, setRestoringOss] = useState<string | null>(null);
  const [showBackupChoice, setShowBackupChoice] = useState(false);
  const [mfaRestore, setMfaRestore] = useState<PendingRestore | null>(null);
  const [mfaCode, setMfaCode] = useState('');
  const [mfaError, setMfaError] = useState('');
  const [mfaBusy, setMfaBusy] = useState(false);
  const [drilling, setDrilling] = useState<string | null>(null);
  const [drillResult, setDrillResult] = useState<DrillReport | null>(null);

  useEffect(() => {
    loadConfig();
    loadBackups();
  }, []);

  const loadConfig = async () => {
    try {
      const res = await api.getBackupConfig();
      if (res.ok) {
        setConfig(res.config);
        setOssSummary(res.oss_backup ?? null);
      }
    } catch {}
  };

  const loadBackups = async () => {
    try {
      const res = await api.listBackups();
      if (res.ok) {
        setBackups(res.backups || []);
        setOssBackups(res.oss_backups || []);
      }
    } catch {}
  };

  const handleSave = async () => {
    setLoading(true);
    onError('');
    try {
      await api.updateBackupConfig(config);
      onSuccess('备份配置已保存');
    } catch (err: any) {
      onError(err.message || '保存失败');
    } finally {
      setLoading(false);
    }
  };

  const handleBackupNow = () => {
    setShowBackupChoice(true);
  };

  const doBackup = async (uploadOss: boolean) => {
    setShowBackupChoice(false);
    setLoading(true);
    onError('');
    try {
      const res = await api.manualBackup(uploadOss);
      if (!res.ok) {
        onError(res.error || '备份失败');
        return;
      }
      if (res.oss === 'uploaded') {
        onSuccess('数据库已备份并上传 OSS');
      } else if (res.oss === 'skipped') {
        onSuccess('数据库已备份；内容与上次 OSS 上传一致，跳过上传');
      } else if (res.oss === 'failed') {
        onError(`OSS 上传失败（本地备份已保存）: ${res.oss_error || '未知错误'}`);
      } else {
        onSuccess('数据库已备份');
      }
      loadBackups();
      loadConfig();
    } catch (err: any) {
      onError(err.message || '备份失败');
    } finally {
      setLoading(false);
    }
  };

  const doRestore = async (name: string) => {
    setRestoring(name);
    onError('');
    try {
      const res = await api.restoreBackup(name);
      if (res.ok) {
        onSuccess('恢复已暂存，重启服务端后生效');
      } else {
        onError(res.error || '恢复失败');
      }
    } catch (err: any) {
      if (err?.body?.mfa_required) {
        setMfaRestore({ kind: 'local', name });
        setMfaCode('');
        setMfaError('');
      } else {
        onError(err.message || '恢复失败');
      }
    } finally {
      setRestoring(null);
    }
  };

  const doRestoreOSS = async (ossKey: string) => {
    setRestoringOss(ossKey);
    onError('');
    try {
      const res = await api.restoreBackupOSS(ossKey);
      if (res.ok) {
        onSuccess('OSS 恢复已暂存，重启服务端后生效');
      } else {
        onError(res.error || '恢复失败');
      }
    } catch (err: any) {
      if (err?.body?.mfa_required) {
        setMfaRestore({ kind: 'oss', ossKey });
        setMfaCode('');
        setMfaError('');
      } else {
        onError(err.message || '恢复失败');
      }
    } finally {
      setRestoringOss(null);
    }
  };

  const doDrill = async (name?: string) => {
    setDrilling(name ?? 'latest');
    setDrillResult(null);
    onError('');
    try {
      const res = await api.backupDrill(name);
      if (res.report) {
        setDrillResult(res.report);
        if (res.ok) {
          onSuccess(`恢复演练通过：${res.report.name}`);
        } else {
          onError(`恢复演练失败：${res.report.error || '未知错误'}`);
        }
      } else if (!res.ok) {
        onError(res.error || '恢复演练失败');
      }
    } catch (err: any) {
      onError(err.message || '恢复演练失败');
    } finally {
      setDrilling(null);
    }
  };

  const confirmRestoreMFA = async () => {
    if (!mfaRestore) return;
    if (!/^\d{6}$/.test(mfaCode)) {
      setMfaError('请输入 6 位验证码');
      return;
    }
    setMfaBusy(true);
    setMfaError('');
    try {
      await api.verifyDeleteMFA(mfaCode);
      const pending = mfaRestore;
      setMfaRestore(null);
      setMfaCode('');
      if (pending.kind === 'local') {
        await doRestore(pending.name);
      } else {
        await doRestoreOSS(pending.ossKey);
      }
    } catch (err: any) {
      setMfaError(err?.message || '验证失败');
    } finally {
      setMfaBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2 mb-4">
        <Database className="w-5 h-5 text-emerald-400" />
        <h3 className="text-lg font-semibold text-white">数据库备份</h3>
      </div>

      {/* 定时自动备份 */}
          <div className="p-3 bg-gray-800 rounded-lg space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Clock className="w-4 h-4 text-emerald-400" />
                <p className="text-sm font-medium text-white">定时自动备份</p>
              </div>
              <button
                onClick={() => setConfig({ ...config, auto_backup: !config.auto_backup })}
                className={`w-11 h-6 rounded-full transition-colors ${config.auto_backup ? 'bg-emerald-600' : 'bg-gray-600'}`}
              >
                <div className={`w-5 h-5 rounded-full bg-white transform transition-transform ${config.auto_backup ? 'translate-x-5' : 'translate-x-0.5'}`} />
              </button>
            </div>
            {config.auto_backup && (
              <div className="space-y-3 pl-3 border-l-2 border-gray-700">
                <div className="flex items-center gap-3">
                  <label className="text-xs text-gray-400">每天执行时间：</label>
                  <input
                    type="time"
                    value={config.backup_time}
                    onChange={(e) => setConfig({ ...config, backup_time: e.target.value })}
                    className="px-3 py-1.5 bg-gray-700 border border-gray-600 rounded text-white text-sm focus:outline-none focus:border-emerald-500"
                  />
                </div>
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-xs font-medium text-gray-300">同时备份到 OSS</p>
                    <p className="text-xs text-gray-500">上传 AES-256-GCM 加密副本（需已配置数据库口令）</p>
                  </div>
                  <button
                    onClick={() => setConfig({ ...config, auto_backup_upload_oss: !config.auto_backup_upload_oss })}
                    className={`w-9 h-5 rounded-full transition-colors ${config.auto_backup_upload_oss ? 'bg-emerald-600' : 'bg-gray-600'}`}
                  >
                    <div className={`w-4 h-4 rounded-full bg-white transform transition-transform ${config.auto_backup_upload_oss ? 'translate-x-4' : 'translate-x-0.5'}`} />
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* 文件操作后自动备份 */}
          <div className="p-3 bg-gray-800 rounded-lg space-y-3">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-white">文件操作后自动备份</p>
                <p className="text-xs text-gray-400">每次新增/编辑/上传文件后触发备份</p>
              </div>
              <button
                onClick={() => setConfig({ ...config, on_file_change: !config.on_file_change })}
                className={`w-11 h-6 rounded-full transition-colors ${config.on_file_change ? 'bg-emerald-600' : 'bg-gray-600'}`}
              >
                <div className={`w-5 h-5 rounded-full bg-white transform transition-transform ${config.on_file_change ? 'translate-x-5' : 'translate-x-0.5'}`} />
              </button>
            </div>
            {config.on_file_change && (
              <div className="space-y-3 pl-3 border-l-2 border-gray-700">
                <div className="flex items-center gap-3">
                  <label className="text-xs text-gray-400">最小间隔(秒)：</label>
                  <input
                    type="number"
                    min={60}
                    max={3600}
                    value={config.min_interval}
                    onChange={(e) => setConfig({ ...config, min_interval: parseInt(e.target.value) || 300 })}
                    className="w-20 px-3 py-1.5 bg-gray-700 border border-gray-600 rounded text-white text-sm focus:outline-none focus:border-emerald-500"
                  />
                  <span className="text-xs text-gray-500">防止频繁备份(最少60秒)</span>
                </div>
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-xs font-medium text-gray-300">同时备份到 OSS</p>
                    <p className="text-xs text-gray-500">上传 AES-256-GCM 加密副本（需已配置数据库口令）</p>
                  </div>
                  <button
                    onClick={() => setConfig({ ...config, on_file_change_upload_oss: !config.on_file_change_upload_oss })}
                    className={`w-9 h-5 rounded-full transition-colors ${config.on_file_change_upload_oss ? 'bg-emerald-600' : 'bg-gray-600'}`}
                  >
                    <div className={`w-4 h-4 rounded-full bg-white transform transition-transform ${config.on_file_change_upload_oss ? 'translate-x-4' : 'translate-x-0.5'}`} />
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* 最大保留份数 */}
          <div className="p-3 bg-gray-800 rounded-lg">
            <div className="flex items-center gap-3">
              <label className="text-sm text-gray-300">最大保留份数：</label>
              <input
                type="number"
                min={1}
                max={100}
                value={config.max_backups}
                onChange={(e) => setConfig({ ...config, max_backups: parseInt(e.target.value) || 10 })}
                className="w-20 px-3 py-1.5 bg-gray-700 border border-gray-600 rounded text-white text-sm focus:outline-none focus:border-emerald-500"
              />
              <span className="text-xs text-gray-500">超出自动删除最旧的</span>
            </div>
          </div>

          {/* 保存 + 手动备份 */}
          <div className="flex gap-3">
            <button
              onClick={handleSave}
              disabled={loading}
              className="flex-1 py-2.5 bg-emerald-600 hover:bg-emerald-500 disabled:bg-gray-700 disabled:text-gray-500 text-white rounded-lg font-medium transition-colors"
            >
              {loading ? '保存中...' : '保存配置'}
            </button>
            <button
              onClick={handleBackupNow}
              disabled={loading}
              className="flex-1 py-2.5 bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700 disabled:text-gray-500 text-white rounded-lg font-medium transition-colors"
            >
              <Database className="w-4 h-4 inline mr-1" />
              {loading ? '备份中...' : '立即备份'}
            </button>
          </div>

          {/* 备份列表 */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <h4 className="text-sm font-medium text-gray-300">历史备份 ({backups.length})</h4>
              <button
                onClick={() => doDrill()}
                disabled={drilling !== null}
                className="px-2 py-1 bg-blue-600/20 hover:bg-blue-600/40 text-blue-300 text-xs rounded transition-colors disabled:opacity-50"
              >
                {drilling === 'latest' ? '演练中...' : '恢复演练（最新）'}
              </button>
            </div>
            {backups.length === 0 ? (
              <p className="text-xs text-gray-500">暂无备份</p>
            ) : (
              <div className="space-y-1.5 max-h-48 overflow-auto">
                {backups.map((b) => (
                  <div key={b.name} className="flex items-center justify-between p-2 bg-gray-800 rounded text-sm">
                    <div className="flex-1 min-w-0">
                      <p className="text-gray-300 font-mono text-xs truncate">{b.name}</p>
                      <p className="text-gray-500 text-xs">
                        {formatSize(b.size)} · {new Date(b.created_at).toLocaleString()}
                      </p>
                    </div>
                    <button
                      onClick={() => doDrill(b.name)}
                      disabled={drilling !== null}
                      className="ml-2 px-2 py-1 bg-gray-600/20 hover:bg-gray-600/40 text-gray-300 text-xs rounded transition-colors disabled:opacity-50"
                    >
                      {drilling === b.name ? '演练中...' : '演练'}
                    </button>
                    <button
                      onClick={() => doRestore(b.name)}
                      disabled={restoring === b.name}
                      className="ml-2 px-2 py-1 bg-amber-600/20 hover:bg-amber-600/40 text-amber-400 text-xs rounded transition-colors disabled:opacity-50"
                    >
                      {restoring === b.name ? '恢复中...' : '恢复'}
                    </button>
                  </div>
                ))}
              </div>
            )}
            {/* 恢复演练报告 */}
            {drillResult && (
              <div
                className={`mt-3 p-3 rounded-lg border ${
                  drillResult.ok
                    ? 'bg-emerald-500/5 border-emerald-500/30'
                    : 'bg-red-500/5 border-red-500/30'
                }`}
              >
                <div className="flex items-center justify-between mb-2">
                  <span
                    className={`text-sm font-medium flex items-center gap-1.5 ${
                      drillResult.ok ? 'text-emerald-400' : 'text-red-400'
                    }`}
                  >
                    <Check className="w-3.5 h-3.5" />
                    {drillResult.ok ? '恢复演练通过' : '恢复演练失败'}
                  </span>
                  <div className="flex items-center gap-2 text-xs text-gray-500">
                    <span>
                      {drillResult.name} · {drillResult.duration_ms} ms
                      {drillResult.ok &&
                        ` · ${drillResult.file_count} 个文件 / ${drillResult.folder_count} 个目录`}
                    </span>
                    <button
                      onClick={() => setDrillResult(null)}
                      className="text-gray-500 hover:text-gray-300"
                      aria-label="关闭演练报告"
                    >
                      ✕
                    </button>
                  </div>
                </div>
                <div className="space-y-1">
                  {drillResult.checks.map((ck) => (
                    <div key={ck.name} className="flex items-start gap-2 text-xs">
                      <span className={ck.ok ? 'text-emerald-400' : 'text-red-400'}>
                        {ck.ok ? '✓' : '✗'}
                      </span>
                      <span className="text-gray-300 w-24 shrink-0">{ck.name}</span>
                      <span className="text-gray-500 flex-1">{ck.detail}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
          {/* OSS 加密备份列表 */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <Cloud className="w-4 h-4 text-blue-400" />
                <h4 className="text-sm font-medium text-gray-300">OSS 加密备份 ({ossBackups.length})</h4>
              </div>
              {ossSummary && (
                <span className="text-xs text-gray-500">
                  上次上传: {new Date(ossSummary.uploaded_at).toLocaleString()} · md5 {ossSummary.md5.slice(0, 8)}
                </span>
              )}
            </div>
            {ossBackups.length === 0 ? (
              <p className="text-xs text-gray-500">暂无 OSS 备份，选择“备份并上传 OSS”后显示</p>
            ) : (
              <div className="space-y-1.5 max-h-48 overflow-auto">
                {ossBackups.map((b) => (
                  <div key={b.id} className="flex items-center justify-between p-2 bg-gray-800 rounded text-sm">
                    <div className="flex-1 min-w-0">
                      <p className="text-gray-300 font-mono text-xs truncate">{b.name}</p>
                      <p className="text-gray-500 text-xs">
                        {formatSize(b.file_size)} · {new Date(b.uploaded_at).toLocaleString()} · md5 {b.md5.slice(0, 8)}
                      </p>
                    </div>
                    <button
                      onClick={() => doRestoreOSS(b.oss_key)}
                      disabled={restoringOss === b.oss_key}
                      className="ml-2 px-2 py-1 bg-amber-600/20 hover:bg-amber-600/40 text-amber-400 text-xs rounded transition-colors disabled:opacity-50"
                    >
                      {restoringOss === b.oss_key ? '恢复中...' : '恢复'}
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

      {/* 备份方式二选一 */}
      {showBackupChoice && (
        <div className="fixed inset-0 z-[60] bg-black/80 flex items-center justify-center p-4">
          <div
            className="bg-gray-900 rounded-2xl p-6 w-full max-w-sm"
          >
            <div className="flex items-center gap-3 mb-4">
              <div className="p-2 bg-blue-500/10 rounded-lg">
                <Database className="w-5 h-5 text-blue-400" />
              </div>
              <h3 className="text-lg font-semibold text-white">选择备份方式</h3>
            </div>
            <p className="text-gray-400 text-sm mb-4">
              两种方式都会先在本地生成数据库备份文件。上传 OSS 的副本已用数据库口令加密。
            </p>
            <div className="space-y-2.5">
              <button
                onClick={() => doBackup(false)}
                disabled={loading}
                className="w-full py-2.5 bg-gray-800 hover:bg-gray-700 disabled:bg-gray-800 disabled:text-gray-500 text-white rounded-lg font-medium transition-colors"
              >
                仅备份数据库（本地）
              </button>
              <button
                onClick={() => doBackup(true)}
                disabled={loading}
                className="w-full py-2.5 bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700 disabled:text-gray-500 text-white rounded-lg font-medium transition-colors"
              >
                <Cloud className="w-4 h-4 inline mr-1" />
                备份并上传 OSS（加密）
              </button>
              <button
                onClick={() => setShowBackupChoice(false)}
                className="w-full py-2 bg-transparent hover:bg-gray-800 text-gray-400 rounded-lg text-sm transition-colors"
              >
                取消
              </button>
            </div>
          </div>
        </div>
      )}

      {mfaRestore && (
        <div className="fixed inset-0 z-[60] bg-black/80 flex items-center justify-center p-4">
          <div
            className="bg-gray-900 rounded-2xl p-6 w-full max-w-sm"
          >
            <div className="flex items-center gap-3 mb-4">
              <div className="p-2 bg-emerald-500/10 rounded-lg">
                <Shield className="w-5 h-5 text-emerald-400" />
              </div>
              <h3 className="text-lg font-semibold text-white">恢复需要验证</h3>
            </div>
            <p className="text-gray-400 text-sm mb-4">
              恢复数据库会覆盖当前数据（含 MFA 记录），请输入 TOTP 验证码确认。
            </p>
            <input
              type="text"
              inputMode="numeric"
              maxLength={6}
              value={mfaCode}
              autoFocus
              onChange={(e) => setMfaCode(e.target.value.replace(/\D/g, ''))}
              onKeyDown={(e) => { if (e.key === 'Enter') confirmRestoreMFA(); }}
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
                onClick={() => setMfaRestore(null)}
                className="flex-1 py-2.5 bg-gray-800 hover:bg-gray-700 text-white rounded-lg font-medium transition-colors"
              >
                取消
              </button>
              <button
                onClick={confirmRestoreMFA}
                disabled={mfaBusy}
                className="flex-1 py-2.5 bg-amber-600 hover:bg-amber-500 disabled:bg-gray-700 disabled:text-gray-500 text-white rounded-lg font-medium transition-colors"
              >
                {mfaBusy ? '验证中...' : '验证并恢复'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
