import { useState, useEffect } from 'react';
import { api, setSessionToken } from './api/client';
import { deriveMasterKey, unwrapAccountKey } from './crypto/crypto';
import { setUnlockMaterial, clearUnlockMaterial } from './session';
import LoginScreen from './components/LoginScreen';
import FileExplorer from './components/FileExplorer';
import TOTPVerify from './components/TOTPVerify';

type AppState = 'loading' | 'login' | 'mfa' | 'unlocked';

export default function App() {
  const [state, setState] = useState<AppState>('loading');
  const [masterKey, setMasterKey] = useState<CryptoKey | null>(null);
  const [accountKey, setAccountKey] = useState<CryptoKey | null>(null);
  const [pendingSessionToken, setPendingSessionToken] = useState('');
  const [pendingLoginResult, setPendingLoginResult] = useState<{ encrypted_account_key: string; salt: string } | null>(null);

  useEffect(() => {
    checkAuth();
  }, []);

  const checkAuth = async () => {
    try {
      await api.getSetupStatus();
    } catch {
      // 后端不可达也进入登录页，LoginScreen 自行处理错误
    }
    setState('login');
  };

  const handleUnlock = async (password: string): Promise<boolean> => {
    try {
      console.log('[unlock] checking setup status...');
      const status = await api.getSetupStatus();
      console.log('[unlock] setup_complete:', status.setup_complete);

      if (!status.setup_complete) {
        console.log('[unlock] calling handleSetup...');
        await handleSetup(password);
        return true;
      }

      console.log('[unlock] getting stored salt...');
      const saltRes = await fetch('/api/auth/salt');
      const saltData = await saltRes.json();
      if (!saltData.salt) {
        console.error('[unlock] no salt found');
        return false;
      }

      const saltBytes = Uint8Array.from(atob(saltData.salt), c => c.charCodeAt(0));
      const keyMaterial = await deriveMasterKey(password, saltBytes);

      const loginRes = await api.login({
        auth_hash: keyMaterial.authHash,
        salt: keyMaterial.salt,
      });

      if (!loginRes.ok || !loginRes.encrypted_account_key) {
        return false;
      }

      if (loginRes.session_token) {
        setSessionToken(loginRes.session_token);
      }

      if (loginRes.mfa_required) {
        setPendingSessionToken(loginRes.session_token || '');
        setPendingLoginResult({
          encrypted_account_key: loginRes.encrypted_account_key,
          salt: loginRes.salt || keyMaterial.salt,
        });
        setUnlockMaterial(password, loginRes.salt || keyMaterial.salt, loginRes.encrypted_account_key);
        setMasterKey(keyMaterial.masterKey);
        setState('mfa');
        return true;
      }

      const accKey = await unwrapAccountKey(keyMaterial.masterKey, loginRes.encrypted_account_key);

      setUnlockMaterial(password, loginRes.salt || keyMaterial.salt, loginRes.encrypted_account_key);

      setMasterKey(keyMaterial.masterKey);
      setAccountKey(accKey);
      setState('unlocked');
      return true;
    } catch (err) {
      // 不再吞掉异常返回 false——否则网络/加密错误会被登录页误报成「密码错误」
      console.error('[unlock] error:', err);
      throw err;
    }
  };

  const handleTotpSuccess = async (newToken: string) => {
    setSessionToken(newToken);
    try {
      if (pendingLoginResult && masterKey) {
        const accKey = await unwrapAccountKey(masterKey, pendingLoginResult.encrypted_account_key);
        setAccountKey(accKey);
      }
    } catch (err) {
      console.error('[unlock] account key unwrap failed:', err);
      setPendingSessionToken('');
      setPendingLoginResult(null);
      setMasterKey(null);
      clearUnlockMaterial();
      setSessionToken(null);
      setState('login');
      alert('解锁失败：会话密钥校验未通过，请重新登录');
      return;
    }
    setPendingSessionToken('');
    setPendingLoginResult(null);
    setState('unlocked');
  };

  const handleTotpCancel = () => {
    setPendingSessionToken('');
    setPendingLoginResult(null);
    setMasterKey(null);
    clearUnlockMaterial();
    setSessionToken(null);
    setState('login');
  };

  const handleSetup = async (password: string) => {
    console.log('[setup] deriveMasterKey...');
    const keyMaterial = await deriveMasterKey(password);
    console.log('[setup] deriveMasterKey done, authHash:', keyMaterial.authHash.substring(0, 10) + '...');

    console.log('[setup] generate account key...');
    const accountKeyRaw = await crypto.subtle.generateKey(
      { name: 'AES-KW', length: 256 },
      true,
      ['wrapKey', 'unwrapKey'],
    );

    console.log('[setup] wrapping account key...');
    const wrappedAccountKey = await crypto.subtle.wrapKey(
      'raw',
      accountKeyRaw,
      keyMaterial.masterKey,
      'AES-KW',
    );

    const wrappedBase64 = btoa(String.fromCharCode(...new Uint8Array(wrappedAccountKey)));
    console.log('[setup] account key wrapped, calling api.setup...');

    await api.setup({
      password_hash: keyMaterial.authHash,
      salt: keyMaterial.salt,
      encrypted_account_key: wrappedBase64,
    });
    console.log('[setup] api.setup done');

    setUnlockMaterial(password, keyMaterial.salt, wrappedBase64);

    setMasterKey(keyMaterial.masterKey);
    setAccountKey(accountKeyRaw);
    setState('unlocked');
    console.log('[setup] setup complete');
  };

  const handleLock = async () => {
    try { await api.logout(); } catch {}
    setSessionToken(null);
    clearUnlockMaterial();
    setMasterKey(null);
    setAccountKey(null);
    setState('login');
  };

  if (state === 'loading') {
    return (
      <div className="min-h-screen bg-gray-950 flex items-center justify-center">
        <div className="text-gray-400">加载中...</div>
      </div>
    );
  }

  if (state === 'login') {
    return <LoginScreen onUnlock={handleUnlock} />;
  }

  if (state === 'mfa') {
    return (
      <TOTPVerify
        sessionToken={pendingSessionToken}
        onSuccess={handleTotpSuccess}
        onCancel={handleTotpCancel}
      />
    );
  }

  return (
    <div className="min-h-screen bg-gray-950">
      <FileExplorer onLock={handleLock} />
    </div>
  );
}
