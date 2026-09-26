import { useState } from 'react';
import { Shield, AlertCircle, X } from 'lucide-react';
import { api } from '../api/client';

interface TOTPVerifyProps {
  sessionToken: string;
  onSuccess: (newToken: string) => void;
  onCancel: () => void;
}

export default function TOTPVerify({ sessionToken, onSuccess, onCancel }: TOTPVerifyProps) {
  const [code, setCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (code.length !== 6) return;

    setLoading(true);
    setError('');
    try {
      const res = await api.verifyTotp({ code, session_token: sessionToken });
      if (res.ok) {
        onSuccess(sessionToken);
      } else {
        setError(res.error || '验证码错误');
      }
    } catch (err: any) {
      setError(err.message || '验证失败');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-950 flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-emerald-500/10 mb-4">
            <Shield className="w-8 h-8 text-emerald-400" />
          </div>
          <h1 className="text-2xl font-bold text-white">MFA 验证</h1>
          <p className="text-gray-400 mt-1">请输入认证器中的 6 位验证码</p>
        </div>

        <form onSubmit={handleSubmit} className="bg-gray-900 rounded-2xl p-6 space-y-4">
          {error && (
            <div className="flex items-center gap-2 p-3 rounded-lg bg-red-500/10 text-red-400 text-sm">
              <AlertCircle className="w-4 h-4 flex-shrink-0" />
              {error}
              <button onClick={() => setError('')} className="ml-auto"><X className="w-4 h-4" /></button>
            </div>
          )}

          <div>
            <label className="block text-sm font-medium text-gray-300 mb-1.5">验证码</label>
            <input
              type="text"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              placeholder="6 位验证码"
              className="w-full px-4 py-2.5 bg-gray-800 border border-gray-700 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:border-emerald-500 transition-colors font-mono text-center text-lg tracking-[0.5em]"
              maxLength={6}
              autoFocus
            />
          </div>

          <button
            type="submit"
            disabled={loading || code.length !== 6}
            className="w-full py-2.5 bg-emerald-600 hover:bg-emerald-500 disabled:bg-gray-700 disabled:text-gray-500 text-white rounded-lg font-medium transition-colors"
          >
            {loading ? '验证中...' : '验证'}
          </button>

          <button
            type="button"
            onClick={onCancel}
            className="w-full py-2.5 bg-gray-700 hover:bg-gray-600 text-white rounded-lg font-medium transition-colors"
          >
            取消
          </button>
        </form>
      </div>
    </div>
  );
}
