import { useState } from 'react';
import { Eye, EyeOff, AlertCircle, Check } from 'lucide-react';
import { api, setSessionToken } from '../api/client';
import { deriveMasterKey, unwrapAccountKey, wrapAccountKey } from '../crypto/crypto';
import { getSessionEncryptedAccountKey, clearUnlockMaterial } from '../session';

interface ChangePasswordProps {
  onClose: () => void;
}

export default function ChangePassword({ onClose }: ChangePasswordProps) {
  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showOld, setShowOld] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setSuccess('');

    if (newPassword.length < 12) {
      setError('新密码至少需要 12 个字符');
      return;
    }
    if (newPassword !== confirmPassword) {
      setError('两次输入的新密码不一致');
      return;
    }

    setLoading(true);
    try {
      setStatus('获取盐值...');
      const saltRes = await fetch('/api/auth/salt');
      const saltData = await saltRes.json();
      if (!saltData.salt) {
        setError('无法获取盐值');
        return;
      }

      const saltBytes = Uint8Array.from(atob(saltData.salt), c => c.charCodeAt(0));

      const storedEncKey = getSessionEncryptedAccountKey();
      if (!storedEncKey) {
        setError('本地会话数据缺失，请退出并重新登录后再试');
        return;
      }

      setStatus('派生旧密钥(约1秒)...');
      const oldKeyMaterial = await deriveMasterKey(oldPassword, saltBytes);

      setStatus('校验旧密码...');
      let accountKey;
      try {
        accountKey = await unwrapAccountKey(oldKeyMaterial.masterKey, storedEncKey);
      } catch {
        setError('当前密码错误，或本地会话数据已损坏，请重新登录后再试');
        return;
      }

      setStatus('派生新密钥(约1秒)...');
      const newKeyMaterial = await deriveMasterKey(newPassword, saltBytes);

      setStatus('重新封装密钥...');
      const reWrappedKey = await wrapAccountKey(newKeyMaterial.masterKey, accountKey);

      setStatus('提交修改...');
      const res = await api.changePassword({
        old_password_hash: oldKeyMaterial.authHash,
        new_password_hash: newKeyMaterial.authHash,
        new_encrypted_account_key: reWrappedKey,
      });

      if (!res.ok) {
        setError(res.error || '修改密码失败');
        return;
      }

      setSuccess('密码修改成功，正在跳转登录...');
      clearUnlockMaterial();
      setSessionToken(null);
      setTimeout(() => window.location.reload(), 1200);
    } catch (err: any) {
      setError(err.message || '修改密码失败');
    } finally {
      setLoading(false);
      setStatus('');
    }
  };

  return (
    <div className="space-y-4">
      {error && (
        <div className="flex items-center gap-2 p-3 rounded-lg bg-red-500/10 text-red-400 text-sm">
          <AlertCircle className="w-4 h-4 flex-shrink-0" />
          {error}
        </div>
      )}
      {success && (
        <div className="flex items-center gap-2 p-3 rounded-lg bg-emerald-500/10 text-emerald-400 text-sm">
          <Check className="w-4 h-4 flex-shrink-0" />
          {success}
        </div>
      )}
      {loading && status && (
        <div className="p-3 rounded-lg bg-blue-500/10 text-blue-400 text-sm">
          {status}
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-gray-300 mb-1.5">当前密码</label>
          <div className="relative">
            <input
              type={showOld ? 'text' : 'password'}
              value={oldPassword}
              onChange={(e) => setOldPassword(e.target.value)}
              placeholder="输入当前密码"
              className="w-full px-4 py-2.5 bg-gray-800 border border-gray-700 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:border-emerald-500 transition-colors pr-10"
            />
            <button type="button" onClick={() => setShowOld(!showOld)} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-300">
              {showOld ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
            </button>
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-300 mb-1.5">新密码</label>
          <div className="relative">
            <input
              type={showNew ? 'text' : 'password'}
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder="至少 12 个字符"
              className="w-full px-4 py-2.5 bg-gray-800 border border-gray-700 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:border-emerald-500 transition-colors pr-10"
            />
            <button type="button" onClick={() => setShowNew(!showNew)} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-300">
              {showNew ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
            </button>
          </div>
          {newPassword && newPassword.length < 12 && (
            <p className="text-xs text-amber-400 mt-1">密码太短，至少需要 12 个字符</p>
          )}
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-300 mb-1.5">确认新密码</label>
          <input
            type={showNew ? 'text' : 'password'}
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            placeholder="再次输入新密码"
            className="w-full px-4 py-2.5 bg-gray-800 border border-gray-700 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:border-emerald-500 transition-colors"
          />
        </div>

        <div className="flex gap-3 pt-2">
          <button type="button" onClick={onClose} className="flex-1 py-2.5 bg-gray-700 hover:bg-gray-600 text-white rounded-lg font-medium transition-colors">
            取消
          </button>
          <button
            type="submit"
            disabled={loading || !oldPassword || !newPassword || newPassword.length < 12 || newPassword !== confirmPassword}
            className="flex-1 py-2.5 bg-emerald-600 hover:bg-emerald-500 disabled:bg-gray-700 disabled:text-gray-500 text-white rounded-lg font-medium transition-colors"
          >
            {loading ? '处理中...' : '修改密码'}
          </button>
        </div>
      </form>
    </div>
  );
}
