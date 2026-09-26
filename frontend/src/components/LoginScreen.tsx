import { useState, useEffect } from 'react';
import { Lock, Eye, EyeOff, AlertCircle } from 'lucide-react';
import { api } from '../api/client';

interface LoginScreenProps {
  onUnlock: (password: string) => Promise<boolean>;
}

export default function LoginScreen({ onUnlock }: LoginScreenProps) {
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [isSetup, setIsSetup] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [cryptoError, setCryptoError] = useState('');

  useEffect(() => {
    api.getSetupStatus().then(res => setIsSetup(res.setup_complete));
    // 非安全上下文（HTTP + 非 localhost）下浏览器禁用 crypto.subtle，所有加密操作会直接抛错
    if (typeof crypto === 'undefined' || !crypto.subtle) {
      setCryptoError(
        '当前页面不是安全上下文（HTTP），浏览器已禁用 Web Crypto 加密 API，无法完成设置/解锁。' +
        '请通过 HTTPS 访问（部署见 docs/deployment.md §3.4），本地开发请使用 localhost。'
      );
    }
  }, []);

  const passwordValid = password.length >= 12;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (cryptoError) {
      return;
    }

    if (!passwordValid) {
      setError('主密码至少需要 12 个字符');
      return;
    }

    if (isSetup === false && password !== confirmPassword) {
      setError('两次输入的密码不一致');
      return;
    }

    setLoading(true);
    try {
      const ok = await onUnlock(password);
      if (!ok) {
        setError('密码错误');
      }
    } catch (err: any) {
      setError(err.message || '操作失败');
    } finally {
      setLoading(false);
    }
  };

  if (isSetup === null) {
    return (
      <div className="min-h-screen bg-gray-950 flex items-center justify-center">
        <div className="text-gray-400">加载中...</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-950 flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-emerald-500/10 mb-4">
            <Lock className="w-8 h-8 text-emerald-400" />
          </div>
          <h1 className="text-2xl font-bold text-white">LitAOSS</h1>
          <p className="text-gray-400 mt-1">
            {isSetup ? '输入主密码解锁' : '设置主密码以开始使用'}
          </p>
        </div>

        <form onSubmit={handleSubmit} className="bg-gray-900 rounded-2xl p-6 space-y-4">
          {cryptoError && (
            <div className="flex items-start gap-2 p-3 rounded-lg bg-red-500/10 text-red-400 text-sm">
              <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
              {cryptoError}
            </div>
          )}

          {error && (
            <div className="flex items-center gap-2 p-3 rounded-lg bg-red-500/10 text-red-400 text-sm">
              <AlertCircle className="w-4 h-4 flex-shrink-0" />
              {error}
            </div>
          )}

          <div>
            <label className="block text-sm font-medium text-gray-300 mb-1.5">主密码</label>
            <div className="relative">
              <input
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="至少 12 个字符"
                className="w-full px-4 py-2.5 bg-gray-800 border border-gray-700 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:border-emerald-500 transition-colors pr-10"
                autoFocus
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-300"
              >
                {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
            {password && !passwordValid && (
              <p className="text-xs text-amber-400 mt-1">密码太短，至少需要 12 个字符</p>
            )}
          </div>

          {!isSetup && (
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-1.5">确认密码</label>
              <input
                type={showPassword ? 'text' : 'password'}
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder="再次输入密码"
                className="w-full px-4 py-2.5 bg-gray-800 border border-gray-700 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:border-emerald-500 transition-colors"
              />
            </div>
          )}

          {!isSetup && (
            <div className="p-3 rounded-lg bg-amber-500/10 text-amber-400 text-xs">
              主密码是访问您所有文件的唯一凭证。忘记密码将导致数据永久丢失，请务必妥善保管。
            </div>
          )}

          <button
            type="submit"
            disabled={loading || !passwordValid || !!cryptoError}
            className="w-full py-2.5 bg-emerald-600 hover:bg-emerald-500 disabled:bg-gray-700 disabled:text-gray-500 text-white rounded-lg font-medium transition-colors"
          >
            {loading ? '处理中...' : isSetup ? '解锁' : '创建主密码'}
          </button>
        </form>
      </div>
    </div>
  );
}
