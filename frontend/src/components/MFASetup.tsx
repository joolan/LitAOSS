import { useState, useEffect, useRef } from 'react';
import { Shield, AlertCircle, Check, X, QrCode, Copy, KeyRound, Download, RefreshCw } from 'lucide-react';
import QRCode from 'qrcode';
import { api } from '../api/client';
import { getSessionPassword, getSessionSalt } from '../session';

// 由主密码推导 auth_hash（与登录一致的 PBKDF2-500k），用于 mfaSetup/mfaDisable 的服务端口令验证
async function deriveAuthHash(password: string): Promise<string | null> {
  const storedSalt = getSessionSalt();
  if (!storedSalt) return null;
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']
  );
  const saltBytes = Uint8Array.from(atob(storedSalt), c => c.charCodeAt(0));
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: saltBytes, iterations: 500000, hash: 'SHA-256' },
    keyMaterial, 256
  );
  return btoa(String.fromCharCode(...new Uint8Array(bits)));
}

interface MFASetupProps {
  onClose: () => void;
}

export default function MFASetup({ onClose }: MFASetupProps) {
  const [mode, setMode] = useState<'bind' | 'manage'>('bind');
  const [loading, setLoading] = useState(true);
  const [secret, setSecret] = useState('');
  const [uri, setUri] = useState('');
  const [qrDataUrl, setQrDataUrl] = useState('');
  const [totpCode, setTotpCode] = useState('');
  const [disablePassword, setDisablePassword] = useState('');
  const [actionLoading, setActionLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [mfaEnabled, setMfaEnabled] = useState(false);
  const [copied, setCopied] = useState(false);
  const [recoveryTotal, setRecoveryTotal] = useState(0);
  const [recoveryRemaining, setRecoveryRemaining] = useState(0);
  const [freshCodes, setFreshCodes] = useState<string[] | null>(null);
  const [codesCopied, setCodesCopied] = useState(false);

  useEffect(() => {
    checkMfaStatus();
  }, []);

  useEffect(() => {
    if (uri) {
      QRCode.toDataURL(uri, {
        width: 200,
        margin: 2,
        color: { dark: '#000000', light: '#ffffff' },
      }).then(setQrDataUrl).catch(console.error);
    }
  }, [uri]);

  const checkMfaStatus = async () => {
    try {
      const res = await api.mfaStatus();
      setMfaEnabled(res.enabled);
      setRecoveryTotal(res.recovery_total || 0);
      setRecoveryRemaining(res.recovery_remaining || 0);
      setMode(res.enabled ? 'manage' : 'bind');
      if (!res.enabled && !res.setup) {
        const pw = getSessionPassword();
        const authHash = pw ? await deriveAuthHash(pw) : null;
        if (!authHash) {
          setError('会话已过期，请重新登录');
          return;
        }
        const setupRes = await api.mfaSetup({ password_hash: authHash });
        setSecret(setupRes.secret);
        setUri(setupRes.uri);
      }
    } catch (err: any) {
      setError(err.message || '获取 MFA 状态失败');
    } finally {
      setLoading(false);
    }
  };

  const handleEnable = async () => {
    if (totpCode.length !== 6) {
      setError('请输入 6 位 TOTP 验证码');
      return;
    }
    setActionLoading(true);
    setError('');
    try {
      const res = await api.mfaEnable({ code: totpCode });
      if (res.ok) {
        setSuccess('MFA 已启用');
        setMfaEnabled(true);
        setMode('manage');
        setTotpCode('');
      } else {
        setError(res.error || '启用失败，请检查验证码');
      }
    } catch (err: any) {
      setError(err.message || '启用 MFA 失败');
    } finally {
      setActionLoading(false);
    }
  };

  const handleDisable = async () => {
    if (totpCode.length !== 6) {
      setError('请输入 6 位 TOTP 验证码');
      return;
    }
    if (!disablePassword) {
      setError('请输入密码以确认禁用 MFA');
      return;
    }
    setActionLoading(true);
    setError('');
    try {
      const authHash = await deriveAuthHash(disablePassword);
      if (!authHash) {
        setError('会话已过期，请重新登录');
        return;
      }

      const res = await api.mfaDisable({ code: totpCode, password_hash: authHash });
      if (res.ok) {
        setSuccess('MFA 已禁用');
        setMfaEnabled(false);
        setMode('bind');
        setTotpCode('');
        setDisablePassword('');
        setRecoveryTotal(0);
        setRecoveryRemaining(0);
        setFreshCodes(null);
        const setupRes = await api.mfaSetup({ password_hash: authHash });
        setSecret(setupRes.secret);
        setUri(setupRes.uri);
      } else {
        setError(res.error || '禁用失败，请检查验证码和密码');
      }
    } catch (err: any) {
      setError(err.message || '禁用 MFA 失败');
    } finally {
      setActionLoading(false);
    }
  };

  const copySecret = () => {
    navigator.clipboard.writeText(secret);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleGenerateRecovery = async () => {
    setActionLoading(true);
    setError('');
    try {
      const pw = getSessionPassword();
      const authHash = pw ? await deriveAuthHash(pw) : null;
      if (!authHash) {
        setError('会话已过期，请重新登录');
        return;
      }
      const res = await api.generateRecoveryCodes({ password_hash: authHash });
      if (res.ok) {
        setFreshCodes(res.codes);
        setRecoveryTotal(res.total);
        setRecoveryRemaining(res.total);
        setCodesCopied(false);
        setSuccess('');
      } else {
        setError('生成恢复码失败');
      }
    } catch (err: any) {
      setError(err.message || '生成恢复码失败');
    } finally {
      setActionLoading(false);
    }
  };

  const copyCodes = () => {
    if (!freshCodes) return;
    navigator.clipboard.writeText(freshCodes.join('\n'));
    setCodesCopied(true);
    setTimeout(() => setCodesCopied(false), 2000);
  };

  const downloadCodes = () => {
    if (!freshCodes) return;
    const text =
      `LitAOSS MFA 恢复码（生成于 ${new Date().toLocaleString('zh-CN')}）\n` +
      '每个恢复码仅可使用一次，请离线保存（密码管理器/打印件）。\n' +
      '丢失认证器时，在 MFA 验证页选择「使用恢复码」登录。\n\n' +
      freshCodes.join('\n') +
      '\n';
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'lit-aoss-recovery-codes.txt';
    a.click();
    URL.revokeObjectURL(url);
  };

  if (loading) {
    return (
      <div className="space-y-4">
        <div className="text-center py-8 text-gray-400">加载中...</div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {error && (
        <div className="flex items-center gap-2 p-3 rounded-lg bg-red-500/10 text-red-400 text-sm">
          <AlertCircle className="w-4 h-4 flex-shrink-0" />
          {error}
          <button onClick={() => setError('')} className="ml-auto"><X className="w-4 h-4" /></button>
        </div>
      )}
      {success && (
        <div className="flex items-center gap-2 p-3 rounded-lg bg-emerald-500/10 text-emerald-400 text-sm">
          <Check className="w-4 h-4 flex-shrink-0" />
          {success}
        </div>
      )}

      {mode === 'bind' ? (
        <div className="space-y-4">
          <p className="text-sm text-gray-400">
            启用 MFA 后，每次登录需要输入动态验证码。
          </p>

          {qrDataUrl && (
            <div className="flex flex-col items-center p-4 rounded-lg bg-gray-800 border border-gray-700">
              <div className="bg-white p-3 rounded-lg mb-3">
                <img src={qrDataUrl} alt="TOTP QR Code" className="w-[200px] h-[200px]" />
              </div>
              <p className="text-xs text-gray-400 text-center">使用 Google Authenticator / Authy 扫码</p>
            </div>
          )}

          {secret && (
            <div className="p-3 rounded-lg bg-gray-800 border border-gray-700">
              <div className="flex items-center justify-between mb-2">
                <p className="text-xs text-gray-400">TOTP 密钥（手动输入）：</p>
                <button onClick={copySecret} className="flex items-center gap-1 text-xs text-emerald-400 hover:text-emerald-300">
                  {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                  {copied ? '已复制' : '复制'}
                </button>
              </div>
              <code className="block text-sm text-emerald-400 font-mono break-all">{secret}</code>
            </div>
          )}

          <div>
            <label className="block text-sm font-medium text-gray-300 mb-1.5">验证码</label>
            <input
              type="text"
              value={totpCode}
              onChange={(e) => setTotpCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              placeholder="6 位验证码"
              className="w-full px-4 py-2.5 bg-gray-800 border border-gray-700 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:border-emerald-500 transition-colors font-mono text-center text-lg tracking-[0.5em]"
              maxLength={6}
            />
          </div>
          <button
            onClick={handleEnable}
            disabled={actionLoading || totpCode.length !== 6}
            className="w-full py-2.5 bg-emerald-600 hover:bg-emerald-500 disabled:bg-gray-700 disabled:text-gray-500 text-white rounded-lg font-medium transition-colors"
          >
            {actionLoading ? '验证中...' : '启用 MFA'}
          </button>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="flex items-center gap-2 p-3 rounded-lg bg-emerald-500/10 text-emerald-400 text-sm">
            <Shield className="w-4 h-4 flex-shrink-0" />
            MFA 已启用
          </div>

          <div className="p-4 rounded-lg bg-gray-800 border border-gray-700 space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-sm text-gray-300">
                <KeyRound className="w-4 h-4 text-emerald-400" />
                登录恢复码
              </div>
              {freshCodes ? (
                <span className="text-xs text-amber-400">仅此一次显示</span>
              ) : recoveryRemaining > 0 ? (
                <span className="text-xs text-emerald-400">已生成 · 剩余 {recoveryRemaining}/{recoveryTotal}</span>
              ) : (
                <span className="text-xs text-red-400">未生成</span>
              )}
            </div>

            {freshCodes ? (
              <>
                <p className="text-xs text-amber-400">
                  请立即复制或下载并离线保存——离开此页后无法再次查看。每个码仅可使用一次。
                </p>
                <div className="grid grid-cols-2 gap-2">
                  {freshCodes.map((code) => (
                    <code key={code} className="block text-sm font-mono text-emerald-400 bg-gray-900 rounded px-2 py-1.5 text-center tracking-wider">
                      {code}
                    </code>
                  ))}
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={copyCodes}
                    className="flex-1 flex items-center justify-center gap-1.5 py-2 bg-gray-700 hover:bg-gray-600 text-white text-sm rounded-lg transition-colors"
                  >
                    {codesCopied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                    {codesCopied ? '已复制' : '复制全部'}
                  </button>
                  <button
                    onClick={downloadCodes}
                    className="flex-1 flex items-center justify-center gap-1.5 py-2 bg-gray-700 hover:bg-gray-600 text-white text-sm rounded-lg transition-colors"
                  >
                    <Download className="w-3.5 h-3.5" />
                    下载 txt
                  </button>
                </div>
                <button
                  onClick={() => setFreshCodes(null)}
                  className="w-full py-2 bg-emerald-600 hover:bg-emerald-500 text-white text-sm rounded-lg transition-colors"
                >
                  我已安全保存
                </button>
              </>
            ) : (
              <>
                <p className="text-xs text-gray-400">
                  {recoveryRemaining > 0
                    ? '丢失认证器时可用恢复码登录；重新生成会使以下旧码全部失效。'
                    : '未生成恢复码：一旦丢失认证器将无法登录。建议启用后立即生成并离线保存。'}
                </p>
                <button
                  onClick={handleGenerateRecovery}
                  disabled={actionLoading}
                  className="w-full flex items-center justify-center gap-1.5 py-2 bg-gray-700 hover:bg-gray-600 disabled:opacity-50 text-white text-sm rounded-lg transition-colors"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${actionLoading ? 'animate-spin' : ''}`} />
                  {recoveryRemaining > 0 ? '重新生成（旧码全部失效）' : '生成 10 个恢复码'}
                </button>
              </>
            )}
          </div>

          <p className="text-sm text-gray-400">
            禁用 MFA 需要输入密码和当前验证码进行确认。
          </p>
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-1.5">密码</label>
            <input
              type="password"
              value={disablePassword}
              onChange={(e) => setDisablePassword(e.target.value)}
              placeholder="输入账户密码"
              className="w-full px-4 py-2.5 bg-gray-800 border border-gray-700 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:border-emerald-500 transition-colors"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-1.5">验证码</label>
            <input
              type="text"
              value={totpCode}
              onChange={(e) => setTotpCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              placeholder="6 位验证码"
              className="w-full px-4 py-2.5 bg-gray-800 border border-gray-700 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:border-emerald-500 transition-colors font-mono text-center text-lg tracking-[0.5em]"
              maxLength={6}
            />
          </div>
          <button
            onClick={handleDisable}
            disabled={actionLoading || totpCode.length !== 6 || !disablePassword}
            className="w-full py-2.5 bg-red-600 hover:bg-red-500 disabled:bg-gray-700 disabled:text-gray-500 text-white rounded-lg font-medium transition-colors"
          >
            {actionLoading ? '处理中...' : '禁用 MFA'}
          </button>
        </div>
      )}
    </div>
  );
}
