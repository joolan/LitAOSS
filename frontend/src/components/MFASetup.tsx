import { useState, useEffect, useRef } from 'react';
import { Shield, AlertCircle, Check, X, QrCode, Copy } from 'lucide-react';
import QRCode from 'qrcode';
import { api } from '../api/client';
import { getSessionSalt } from '../session';

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
      setMode(res.enabled ? 'manage' : 'bind');
      if (!res.enabled && !res.setup) {
        const setupRes = await api.mfaSetup();
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
      const storedSalt = getSessionSalt();
      if (!storedSalt) {
        setError('会话已过期，请重新登录');
        return;
      }
      const enc = new TextEncoder();
      const keyMaterial = await crypto.subtle.importKey(
        'raw', enc.encode(disablePassword), 'PBKDF2', false, ['deriveBits']
      );
      const saltBytes = Uint8Array.from(atob(storedSalt), c => c.charCodeAt(0));
      const bits = await crypto.subtle.deriveBits(
        { name: 'PBKDF2', salt: saltBytes, iterations: 500000, hash: 'SHA-256' },
        keyMaterial, 256
      );
      const authHash = btoa(String.fromCharCode(...new Uint8Array(bits)));

      const res = await api.mfaDisable({ code: totpCode, password_hash: authHash });
      if (res.ok) {
        setSuccess('MFA 已禁用');
        setMfaEnabled(false);
        setMode('bind');
        setTotpCode('');
        setDisablePassword('');
        const setupRes = await api.mfaSetup();
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
