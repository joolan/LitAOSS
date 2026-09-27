import ReactDOM from 'react-dom/client'
import App from './App'
import './index.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <App />,
)

// PWA：仅生产构建注册 Service Worker（开发模式跳过，避免干扰热更新）
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch((err) => {
      console.warn('Service Worker 注册失败:', err)
    })
  })
}
