import { useState, useRef } from 'react';
import { Shield, Lock, Unlock, Upload, AlertCircle, Check, Info } from 'lucide-react';

const PBKDF2_ITERATIONS = 500000;

async function deriveKeyFromPassword(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export default function FileEncryptTool() {
  const [mode, setMode] = useState<'encrypt' | 'decrypt'>('encrypt');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [inputFile, setInputFile] = useState<File | null>(null);
  const [inputFileName, setInputFileName] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setInputFile(file);
      setInputFileName(file.name);
      setError('');
      setSuccess('');
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (file) {
      setInputFile(file);
      setInputFileName(file.name);
      setError('');
      setSuccess('');
    }
  };

  const handleEncrypt = async () => {
    if (!inputFile || !password) {
      setError('请选择文件并输入密码');
      return;
    }
    setLoading(true);
    setError('');
    setSuccess('');
    try {
      const salt = crypto.getRandomValues(new Uint8Array(16));
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const key = await deriveKeyFromPassword(password, salt);

      const plaintext = await inputFile.arrayBuffer();
      const ciphertext = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv, tagLength: 128 },
        key,
        plaintext,
      );

      const encData = {
        v: 2,
        iv: Array.from(iv),
        salt: Array.from(salt),
        data: Array.from(new Uint8Array(ciphertext)),
        name: inputFile.name,
        type: inputFile.type,
      };
      const blob = new Blob([JSON.stringify(encData)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = inputFile.name + '.enc';
      a.click();
      URL.revokeObjectURL(url);

      setSuccess('加密完成，文件已下载');
    } catch (err: any) {
      setError(err.message || '加密失败');
    } finally {
      setLoading(false);
    }
  };

  const handleDecrypt = async () => {
    if (!inputFile || !password) {
      setError('请选择加密文件并输入密码');
      return;
    }
    setLoading(true);
    setError('');
    setSuccess('');
    try {
      const text = await inputFile.text();
      const encData = JSON.parse(text);

      if (!encData.v || !encData.iv || !encData.salt || !encData.data) {
        throw new Error('无效的加密文件格式');
      }

      const salt = new Uint8Array(encData.salt);
      const iv = new Uint8Array(encData.iv);
      const key = await deriveKeyFromPassword(password, salt);

      const plaintext = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv, tagLength: 128 },
        key,
        new Uint8Array(encData.data),
      );

      const blob = new Blob([plaintext], { type: encData.type || 'application/octet-stream' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = encData.name || inputFile.name.replace('.enc', '');
      a.click();
      URL.revokeObjectURL(url);

      setSuccess('解密完成，文件已下载');
    } catch (err: any) {
      setError(err.message || '解密失败，请检查密码是否正确');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="max-w-xl mx-auto space-y-6">
      <div className="text-center">
        <Shield className="w-10 h-10 text-emerald-400 mx-auto mb-3" />
        <h2 className="text-xl font-bold text-white">文件加密/解密工具</h2>
        <p className="text-sm text-gray-400 mt-1">在浏览器本地加密或解密文件，不经过服务器</p>
      </div>

      <div className="flex items-start gap-2 p-3 rounded-lg bg-blue-500/10 text-blue-400 text-xs">
        <Info className="w-4 h-4 flex-shrink-0 mt-0.5" />
        <div>
          <p className="font-medium mb-1">此工具与网盘存储系统独立</p>
          <p>本工具使用单独的密码和加密格式（.enc JSON 文件），与网盘中文件的加密方式不同。网盘中的文件需要登录后才能解密，无法通过此工具解密。</p>
        </div>
      </div>

      <div className="flex bg-gray-800 rounded-lg p-1">
        <button
          onClick={() => { setMode('encrypt'); setError(''); setSuccess(''); }}
          className={`flex-1 py-2 rounded-md text-sm font-medium transition-colors ${
            mode === 'encrypt' ? 'bg-emerald-600 text-white' : 'text-gray-400 hover:text-white'
          }`}
        >
          <Lock className="w-4 h-4 inline mr-2" />
          加密
        </button>
        <button
          onClick={() => { setMode('decrypt'); setError(''); setSuccess(''); }}
          className={`flex-1 py-2 rounded-md text-sm font-medium transition-colors ${
            mode === 'decrypt' ? 'bg-emerald-600 text-white' : 'text-gray-400 hover:text-white'
          }`}
        >
          <Unlock className="w-4 h-4 inline mr-2" />
          解密
        </button>
      </div>

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

      <div className="bg-gray-900 rounded-xl p-6 space-y-4">
        <div>
          <label className="block text-sm font-medium text-gray-300 mb-1.5">密码</label>
          <div className="relative">
            <input
              type={showPassword ? 'text' : 'password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="输入加密/解密密码"
              className="w-full px-4 py-2.5 bg-gray-800 border border-gray-700 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:border-emerald-500 pr-10"
            />
            <button
              type="button"
              onClick={() => setShowPassword(!showPassword)}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-300"
            >
              {showPassword ? '🙈' : '👁'}
            </button>
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-300 mb-1.5">
            {mode === 'encrypt' ? '选择要加密的文件' : '选择加密文件 (.enc)'}
          </label>
          <div
            onDrop={handleDrop}
            onDragOver={(e) => e.preventDefault()}
            onClick={() => fileInputRef.current?.click()}
            className="border-2 border-dashed border-gray-700 rounded-lg p-8 text-center cursor-pointer hover:border-emerald-500 transition-colors"
          >
            <Upload className="w-8 h-8 text-gray-500 mx-auto mb-3" />
            {inputFileName ? (
              <p className="text-sm text-emerald-400">{inputFileName}</p>
            ) : (
              <p className="text-sm text-gray-400">点击选择或拖拽文件到这里</p>
            )}
          </div>
          <input
            ref={fileInputRef}
            type="file"
            onChange={handleFileChange}
            className="hidden"
          />
        </div>

        <button
          onClick={mode === 'encrypt' ? handleEncrypt : handleDecrypt}
          disabled={loading || !inputFile || !password}
          className="w-full py-3 bg-emerald-600 hover:bg-emerald-500 disabled:bg-gray-700 disabled:text-gray-500 text-white rounded-lg font-medium transition-colors"
        >
          {loading ? '处理中...' : mode === 'encrypt' ? '加密并下载' : '解密并下载'}
        </button>
      </div>

      <div className="bg-gray-900/50 rounded-lg p-4 text-xs text-gray-500 space-y-1">
        <p>• 加密算法: AES-256-GCM + PBKDF2 (500k 迭代)</p>
        <p>• 加密文件格式: JSON (包含 iv、salt、加密数据)</p>
        <p>• 加密文件扩展名: .enc</p>
        <p>• 所有操作在浏览器本地完成，不上传到任何服务器</p>
        <p>• 请牢记密码，密码丢失将无法解密</p>
      </div>
    </div>
  );
}
