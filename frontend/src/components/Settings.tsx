import { useState, lazy, Suspense } from 'react';
import { Settings as SettingsIcon, Key, Lock, Eye, EyeOff, Check, AlertCircle, Copy, Shield, RefreshCw, Wrench, Database, History, BarChart3, ScrollText } from 'lucide-react';
import { api, getServerVersion } from '../api/client';
import ChangePassword from './ChangePassword';
import MFASetup from './MFASetup';
import FileEncryptTool from './FileEncryptTool';
import BackupSettings from './BackupSettings';
import LoginHistory from './LoginHistory';
import AuditLog from './AuditLog';
import OfflineCacheSettings from './OfflineCacheSettings';

interface SettingsProps {
  onClose: () => void;
}

type Tab = 'encrypt-tool' | 'encrypt' | 'password' | 'mfa' | 'backup' | 'history' | 'audit' | 'cache' | 'stats';
type EncryptSubTab = 'encrypt' | 'decrypt';

const StatsCharts = lazy(() => import('./StatsCharts'));

export default function Settings({ onClose }: SettingsProps) {
  const [tab, setTab] = useState<Tab>('encrypt-tool');
  const [encryptSubTab, setEncryptSubTab] = useState<EncryptSubTab>('encrypt');
  const [secretKey, setSecretKey] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [showPassphrase, setShowPassphrase] = useState(false);
  const [encryptedSK, setEncryptedSK] = useState('');
  const [decryptPassphrase, setDecryptPassphrase] = useState('');
  const [showDecryptPassphrase, setShowDecryptPassphrase] = useState(false);
  const [decryptSK, setDecryptSK] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const handleEncrypt = async () => {
    if (!secretKey || !passphrase) {
      setError('请填写 SecretKey 和加密口令');
      return;
    }
    setLoading(true);
    setError('');
    setSuccess('');
    try {
      const data = await api.encryptSecret({ plaintext: secretKey, passphrase });

      setEncryptedSK(data.encrypted);
      setSuccess('加密完成！将以下内容填入 config.json 的 encrypted_sk 字段，secret_key 留空');
    } catch (err: any) {
      setError(err.message || '加密失败');
    } finally {
      setLoading(false);
    }
  };

  const handleDecrypt = async () => {
    if (!encryptedSK) {
      setError('请填写 encrypted_sk');
      return;
    }
    setLoading(true);
    setError('');
    setSuccess('');
    try {
      const data = await api.decryptSecret({ encrypted: encryptedSK, passphrase: decryptPassphrase });

      setDecryptSK(data.plaintext);
      setSuccess('解密验证成功');
    } catch (err: any) {
      setError(err.message || '解密失败');
    } finally {
      setLoading(false);
    }
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4">
      <div
        className="bg-gray-900 rounded-2xl w-full max-w-2xl max-h-[90vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* shrink-0：内容区数据多时不得压缩标题与 tab 栏（移动端曾出现 tab 被截断） */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-800 shrink-0">
          <div className="flex items-center gap-3">
            <SettingsIcon className="w-5 h-5 text-emerald-400" />
            <h2 className="text-lg font-semibold text-white">设置</h2>
            {getServerVersion() && (
              <span className="text-xs font-normal text-gray-500" title="后端版本号">
                {getServerVersion()}
              </span>
            )}
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-white text-lg">&times;</button>
        </div>

        <div className="flex border-b border-gray-800 overflow-x-auto shrink-0">
          <button
            onClick={() => setTab('encrypt-tool')}
            className={`flex-auto px-3 py-3 text-sm font-medium whitespace-nowrap transition-colors ${
              tab === 'encrypt-tool' ? 'text-emerald-400 border-b-2 border-emerald-400' : 'text-gray-400 hover:text-white'
            }`}
          >
            <Wrench className="w-4 h-4 inline mr-1" />
            加密工具
          </button>
          <button
            onClick={() => setTab('encrypt')}
            className={`flex-auto px-3 py-3 text-sm font-medium whitespace-nowrap transition-colors ${
              tab === 'encrypt' ? 'text-emerald-400 border-b-2 border-emerald-400' : 'text-gray-400 hover:text-white'
            }`}
          >
            <Key className="w-4 h-4 inline mr-1" />
            密钥加密
          </button>
          <button
            onClick={() => setTab('password')}
            className={`flex-auto px-3 py-3 text-sm font-medium whitespace-nowrap transition-colors ${
              tab === 'password' ? 'text-emerald-400 border-b-2 border-emerald-400' : 'text-gray-400 hover:text-white'
            }`}
          >
            <RefreshCw className="w-4 h-4 inline mr-1" />
            修改密码
          </button>
          <button
            onClick={() => setTab('mfa')}
            className={`flex-auto px-3 py-3 text-sm font-medium whitespace-nowrap transition-colors ${
              tab === 'mfa' ? 'text-emerald-400 border-b-2 border-emerald-400' : 'text-gray-400 hover:text-white'
            }`}
          >
            <Shield className="w-4 h-4 inline mr-1" />
            MFA
          </button>
          <button
            onClick={() => setTab('backup')}
            className={`flex-auto px-3 py-3 text-sm font-medium whitespace-nowrap transition-colors ${
              tab === 'backup' ? 'text-emerald-400 border-b-2 border-emerald-400' : 'text-gray-400 hover:text-white'
            }`}
          >
            <Database className="w-4 h-4 inline mr-1" />
            备份
          </button>
          <button
            onClick={() => setTab('history')}
            className={`flex-auto px-3 py-3 text-sm font-medium whitespace-nowrap transition-colors ${
              tab === 'history' ? 'text-emerald-400 border-b-2 border-emerald-400' : 'text-gray-400 hover:text-white'
            }`}
          >
            <History className="w-4 h-4 inline mr-1" />
            登录历史
          </button>
          <button
            onClick={() => setTab('audit')}
            className={`flex-auto px-3 py-3 text-sm font-medium whitespace-nowrap transition-colors ${
              tab === 'audit' ? 'text-emerald-400 border-b-2 border-emerald-400' : 'text-gray-400 hover:text-white'
            }`}
          >
            <ScrollText className="w-4 h-4 inline mr-1" />
            操作审计
          </button>
          <button
            onClick={() => setTab('cache')}
            className={`flex-auto px-3 py-3 text-sm font-medium whitespace-nowrap transition-colors ${
              tab === 'cache' ? 'text-emerald-400 border-b-2 border-emerald-400' : 'text-gray-400 hover:text-white'
            }`}
          >
            <Database className="w-4 h-4 inline mr-1" />
            缓存
          </button>
          <button
            onClick={() => setTab('stats')}
            className={`flex-auto px-3 py-3 text-sm font-medium whitespace-nowrap transition-colors ${
              tab === 'stats' ? 'text-emerald-400 border-b-2 border-emerald-400' : 'text-gray-400 hover:text-white'
            }`}
          >
            <BarChart3 className="w-4 h-4 inline mr-1" />
            统计
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-auto p-6">
          {tab === 'encrypt-tool' && <FileEncryptTool />}

          {tab === 'encrypt' && (
            <>
              {(error || success) && (
                <div className="mb-4 space-y-2">
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
                </div>
              )}

              <div className="flex border-b border-gray-800 mb-4">
                <button
                  onClick={() => { setEncryptSubTab('encrypt'); setError(''); setSuccess(''); }}
                  className={`flex-1 px-4 py-2.5 text-sm font-medium transition-colors ${
                    encryptSubTab === 'encrypt' ? 'text-emerald-400 border-b-2 border-emerald-400' : 'text-gray-400 hover:text-white'
                  }`}
                >
                  <Key className="w-4 h-4 inline mr-2" />
                  加密 SecretKey
                </button>
                <button
                  onClick={() => { setEncryptSubTab('decrypt'); setError(''); setSuccess(''); }}
                  className={`flex-1 px-4 py-2.5 text-sm font-medium transition-colors ${
                    encryptSubTab === 'decrypt' ? 'text-emerald-400 border-b-2 border-emerald-400' : 'text-gray-400 hover:text-white'
                  }`}
                >
                  <Lock className="w-4 h-4 inline mr-2" />
                  解密验证
                </button>
              </div>

              {encryptSubTab === 'encrypt' ? (
              <div className="space-y-4">
                <p className="text-sm text-gray-400">
                  将 SecretKey 加密后配置到 config.json，避免明文泄露。AccessKey 保持明文即可。
                </p>
                <div>
                  <label className="block text-sm font-medium text-gray-300 mb-1.5">SecretKey</label>
                  <input
                    type="password"
                    value={secretKey}
                    onChange={(e) => setSecretKey(e.target.value)}
                    placeholder="阿里云 AccessKey Secret"
                    className="w-full px-4 py-2.5 bg-gray-800 border border-gray-700 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:border-emerald-500 transition-colors font-mono text-sm"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-300 mb-1.5">加密口令</label>
                  <div className="relative">
                    <input
                      type={showPassphrase ? 'text' : 'password'}
                      value={passphrase}
                      onChange={(e) => setPassphrase(e.target.value)}
                      placeholder="用于加密的口令，后端也需要此口令解密"
                      className="w-full px-4 py-2.5 bg-gray-800 border border-gray-700 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:border-emerald-500 transition-colors pr-10"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassphrase(!showPassphrase)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-300"
                    >
                      {showPassphrase ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>
                </div>

                <div className="p-3 rounded-lg bg-blue-500/10 text-blue-400 text-xs">
                  口令需配置到后端：设置环境变量 <code>LITAOSS_PASSPHRASE</code>，或在后端目录创建 <code>passphrase.txt</code> 文件。
                </div>

                <button
                  onClick={handleEncrypt}
                  disabled={loading || !secretKey || !passphrase}
                  className="w-full py-2.5 bg-emerald-600 hover:bg-emerald-500 disabled:bg-gray-700 disabled:text-gray-500 text-white rounded-lg font-medium transition-colors"
                >
                  {loading ? '加密中...' : '加密'}
                </button>

                {encryptedSK && (
                  <div className="mt-6">
                    <p className="text-sm text-amber-400 mb-2">复制到 config.json 的 encrypted_sk 字段：</p>
                    <div className="flex items-center gap-2">
                      <code className="flex-1 p-2 bg-gray-800 rounded text-xs text-gray-300 break-all font-mono">
                        {encryptedSK}
                      </code>
                      <button onClick={() => copyToClipboard(encryptedSK)} className="p-1.5 hover:bg-gray-700 rounded flex-shrink-0">
                        <Copy className="w-4 h-4 text-gray-400" />
                      </button>
                    </div>
                    <p className="text-xs text-gray-500 mt-2">同时将 config.json 中的 secret_key 设为空字符串</p>
                  </div>
                )}
              </div>
              ) : (
              <div className="space-y-4">
                <p className="text-sm text-gray-400">
                  验证 encrypted_sk 是否能用口令正确解密。
                </p>
                <div>
                  <label className="block text-sm font-medium text-gray-300 mb-1.5">encrypted_sk</label>
                  <textarea
                    value={encryptedSK}
                    onChange={(e) => setEncryptedSK(e.target.value)}
                    placeholder="粘贴 config.json 中的 encrypted_sk 值"
                    rows={3}
                    className="w-full px-4 py-2.5 bg-gray-800 border border-gray-700 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:border-emerald-500 transition-colors font-mono text-sm resize-none"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-300 mb-1.5">解密口令</label>
                  <div className="relative">
                    <input
                      type={showDecryptPassphrase ? 'text' : 'password'}
                      value={decryptPassphrase}
                      onChange={(e) => setDecryptPassphrase(e.target.value)}
                      placeholder="加密时使用的口令"
                      className="w-full px-4 py-2.5 bg-gray-800 border border-gray-700 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:border-emerald-500 transition-colors pr-10"
                    />
                    <button
                      type="button"
                      onClick={() => setShowDecryptPassphrase(!showDecryptPassphrase)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-300"
                    >
                      {showDecryptPassphrase ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>
                </div>

                <button
                  onClick={handleDecrypt}
                  disabled={loading || !encryptedSK || !decryptPassphrase}
                  className="w-full py-2.5 bg-emerald-600 hover:bg-emerald-500 disabled:bg-gray-700 disabled:text-gray-500 text-white rounded-lg font-medium transition-colors"
                >
                  {loading ? '验证中...' : '验证解密'}
                </button>

                {decryptSK && (
                  <div className="mt-4">
                    <p className="text-sm text-emerald-400 mb-2">解密结果：</p>
                    <code className="block p-2 bg-gray-800 rounded text-xs text-gray-300 break-all font-mono">
                      {decryptSK}
                    </code>
                  </div>
                )}
              </div>
              )}
            </>
          )}

          {tab === 'password' && <ChangePassword onClose={onClose} />}
          {tab === 'mfa' && <MFASetup onClose={onClose} />}
          {tab === 'history' && <LoginHistory />}
          {tab === 'audit' && <AuditLog />}
          {tab === 'cache' && <OfflineCacheSettings />}
          {tab === 'stats' && (
            <Suspense fallback={<div className="text-gray-400 text-sm py-8 text-center">加载统计…</div>}>
              <StatsCharts />
            </Suspense>
          )}
          {tab === 'backup' && (
            <>
              {(error || success) && (
                <div className="mb-4 space-y-2">
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
                </div>
              )}
              <BackupSettings onError={setError} onSuccess={setSuccess} />
            </>
          )}
        </div>
      </div>
    </div>
  );
}
