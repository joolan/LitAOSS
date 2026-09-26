# THIRD-PARTY-NOTICES

LitAOSS 引用了以下第三方开源软件。各依赖以其原许可证（original license）授权，版权归原作者所有；各许可证全文见对应项目的仓库或 `node_modules/`、Go 模块缓存中的许可证文件。

版本以本仓库 `backend/go.mod`、`frontend/package.json` 为准。

## 后端（Go）直接依赖

| 模块 | 许可证 |
|------|--------|
| github.com/gin-gonic/gin | MIT |
| github.com/aliyun/aliyun-oss-go-sdk | MIT |
| github.com/google/uuid | BSD-3-Clause |
| github.com/pquerna/otp | Apache-2.0 |
| modernc.org/sqlite | BSD-3-Clause |

间接依赖完整清单见 `backend/go.mod`。

## 前端（浏览器运行时打包）

| 包 | 用途 | 许可证 |
|----|------|--------|
| react / react-dom / scheduler | UI 框架 | MIT |
| react-router-dom | 路由 | MIT |
| lucide-react | 图标 | ISC |
| qrcode | 二维码渲染 | MIT |
| react-pdf | PDF 预览组件 | MIT |
| pdfjs-dist（react-pdf 依赖） | PDF 解析渲染（含 cmaps、standard_fonts 资源） | Apache-2.0 |
| docx-preview | Word (.docx) 预览渲染 | Apache-2.0 |
| jszip（docx-preview 依赖） | DOCX 压缩包解析 | MIT 或 GPL-3.0-or-later（本项目按 MIT 使用） |
| xlsx（SheetJS Community Edition） | Excel 解析 | Apache-2.0 |
| clsx / dequal / tiny-invariant / warning / make-* / merge-refs 等（react-pdf 依赖） | 工具函数 | MIT |
| 其余传递依赖 | 见 `frontend/package.json` / `frontend/package-lock.json` | 各自许可证 |

## 构建与开发工具（不随产物分发）

| 包 | 许可证 |
|----|--------|
| vite / @vitejs/plugin-react / vite-plugin-static-copy / tailwindcss | MIT |
| typescript | Apache-2.0 |
| playwright-core（预览自检脚本） | Apache-2.0 |
