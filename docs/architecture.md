# LitAOSS 架构设计文档

## 1. 项目概述

LitAOSS 是一个端到端加密的私有存储系统。文件在浏览器端完成加密后上传至阿里云 OSS，服务端全程不接触明文数据和加密密钥，实现零知识架构。

### 1.1 核心目标

- 文件加密在浏览器端完成，服务端仅存储密文
- SecretKey 加密存储于配置文件，启动时自动解密
- 数据库文件支持加密存储，停止服务后自动加密
- 在线预览图片、文本、PDF、Word、Excel（前端可插拔渲染，见 §7.2）
- 支持文本文件在线编辑并加密保存
- 单用户自用，无需多用户权限体系

### 1.2 技术选型

| 层级 | 技术 | 选型理由 |
|------|------|----------|
| 前端 | React 18 + TypeScript + Vite | 类型安全、生态成熟、构建速度快 |
| UI | TailwindCSS | 原子化 CSS，开发效率高 |
| 加密 | Web Crypto API (原生) | 浏览器原生、无依赖、硬件加速 |
| 后端 | Go + Gin | 高性能、OSS SDK 完善 |
| 数据库 | SQLite (modernc.org) | 纯 Go 实现，无需 CGO，单文件部署 |
| 对象存储 | 阿里云 OSS | S3 兼容、国内访问稳定 |

## 2. 系统架构

### 2.1 整体架构图

```
┌─────────────────────────────────────────────────────────┐
│                    Browser (SPA)                         │
│                                                         │
│  ┌───────────────────┐  ┌───────────────────────────┐   │
│  │  Web Crypto API   │  │     UI Components         │   │
│  │  ┌─────────────┐  │  │  ┌─────────────────────┐  │   │
│  │  │ PBKDF2      │  │  │  │ LoginScreen         │  │   │
│  │  │ AES-256-GCM │  │  │  │ FileExplorer        │  │   │
│  │  │ AES-KW      │  │  │  │ FilePreview         │  │   │
│  │  └─────────────┘  │  │  │ TextEditor          │  │   │
│  └─────────┬─────────┘  │  │ Settings            │  │   │
│            │            │  └─────────────────────┘  │   │
│            │            └─────────────┬─────────────┘   │
│            │                          │                  │
│            └──────────┬───────────────┘                  │
│                       │ Axios                            │
└───────────────────────┼─────────────────────────────────┘
                        │
          ┌─────────────▼─────────────┐
          │     Go Backend (Gin)      │     ┌─────────────────┐
          │                           │────▶│ 阿里云 OSS      │
          │  ┌─────────────────────┐  │     │ (加密后的 blob) │
          │  │ API Handlers        │  │     └─────────────────┘
          │  │  /api/auth/*        │  │
          │  │  /api/files/*       │  │     预签名 URL 直传
          │  │  /api/presign/*     │  │     ┌─────────────────┐
          │  │  /api/secret/*      │  │◀───│ Browser 直传    │
          │  └─────────────────────┘  │     └─────────────────┘
          │  ┌─────────────────────┐  │
          │  │ Storage Abstraction │  │
          │  │  AliyunOSS          │  │
          │  │  NoopStorage        │  │
          │  └─────────────────────┘  │
          │  ┌─────────────────────┐  │
          │  │ SQLite Database     │  │
          │  │  (支持文件级加密)    │  │
          │  └─────────────────────┘  │
          └───────────────────────────┘
```

### 2.2 数据流

#### 上传流程

```
用户选择文件
    │
    ▼
浏览器生成随机 File Key (AES-256)
    │
    ▼
AES-GCM 加密文件内容 (每文件独立 IV)
    │
    ▼
AES-KW 包装 File Key (用 Account Key)
    │
    ▼
请求 Go 后端生成预签名上传 URL (AK/SK 仅在后端)
    │
    ▼
浏览器直传加密 blob 到 OSS (不经后端)
    │
    ▼
后端保存文件元数据 (加密文件名、加密 File Key、OSS Key)
```

#### 下载/预览流程

```
前置检查: 类型可预览 且 size ≤ 类型上限（图片/文本 200MB、PDF 100MB、Word/Excel 50MB）
    │  不通过 → 直接提示，零网络请求，流程结束
    ▼
请求后端获取预签名下载 URL + 加密 File Key
    │
    ▼
浏览器直从 OSS 下载加密 blob
    │
    ▼
Account Key unwrap File Key (AES-KW)
    │
    ▼
File Key + AES-GCM 解密
    │
    ▼
根据文件类型渲染 (图片 / 文本 / PDF / Word / Excel)
```

> 操作菜单中的"预览"入口仅对可预览类型渲染；不支持的类型只有下载/历史/重命名/删除。

#### 文本编辑保存流程

```
下载加密内容 → 解密显示
    │
    ▼
用户编辑文本
    │
    ▼
重新生成 File Key + AES-GCM 加密新内容
    │
    ▼
删除旧 OSS 对象 + 上传新加密 blob
    │
    ▼
更新数据库元数据
```

## 3. 加密架构

### 3.1 密钥层级

```
用户主密码 (User Password)
    │
    ▼ PBKDF2-SHA256 ×2 (500,000 iterations, 16 字节 salt)
    │
┌───┴───────────────────────────────┐
│                                   │
│  Auth Hash                        │  Master Key
│  (裸 salt 派生, 服务端验证)         │  (salt‖"account-key" 域分离派生)
│                                   │  (AES-KW, 256-bit)
└───────────────────────────────────┘
                │
                ▼ AES-KW unwrap
        Account Key (随机生成)
        AES-KW 包装后存储于服务端
                │
        ┌───────┴───────┐
        │               │
   File Key₁       File Key₂
   (每文件独立随机,   (AES-GCM, 256-bit)
    AES-KW 包装后存服务端)
```

> 说明: File Key 与**文件名**一律由 **Account Key** 保护——改主密码只重新包装 Account Key，文件密钥与文件名不受影响。
> Auth Hash（裸 salt 派生）与 Master Key（`salt‖"account-key"` 域分离派生）来自两次独立的 PBKDF2，修改 KDF 参数时必须同步 `crypto.ts` 与 `fileKey.ts` 两处实现。
> Account Key 的包装值、File Key 的包装值、IV、OSS 对象键只存在于数据库中——**数据库丢失且无备份时，即使知道主密码也无法解密** (详见 security.md §11)。

### 3.2 安全保证

| 保证 | 实现方式 |
|------|----------|
| 零知识 | Master Key 仅在浏览器内存，服务端无任何明文密钥 |
| 抗暴力破解 | PBKDF2 500k 迭代 + 最少 12 字符密码 + 5 次失败锁定 |
| 抗篡改 | AES-GCM 认证加密，任何篡改都会被检测 |
| 密钥隔离 | 每文件独立密钥，单文件泄露不影响其他文件 |
| SecretKey 保护 | 加密存储于配置文件，使用时解密 |
| 数据库加密 | 停止服务后自动加密数据库文件 |
| 预签名 URL | 有时效、限路径，AK/SK 不暴露给前端 |

### 3.3 加密参数

| 参数 | 值 |
|------|-----|
| 密钥派生 | PBKDF2-SHA256 |
| 迭代次数 | 500,000 |
| Salt 长度 | 16 字节 |
| 对称加密 | AES-256-GCM |
| IV 长度 | 12 字节 |
| 认证标签 | 128-bit |
| 密钥包装 | AES-KW |

## 4. 数据模型

### 4.1 SQLite 表结构

```sql
-- 认证表
CREATE TABLE auth (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    password_hash TEXT NOT NULL,      -- PBKDF2 派生的 Auth Hash
    salt TEXT NOT NULL,               -- PBKDF2 salt (Base64)
    encrypted_account_key BLOB,       -- 加密后的 Account Key
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 文件元数据表
CREATE TABLE files (
    id TEXT PRIMARY KEY,              -- UUID
    name_encrypted TEXT NOT NULL,     -- AES-GCM 加密的文件名
    parent_id TEXT,                   -- 父目录 ID (NULL = 根目录)
    is_directory INTEGER DEFAULT 0,
    file_size INTEGER DEFAULT 0,      -- 加密后大小
    file_type TEXT DEFAULT '',        -- MIME type
    oss_key TEXT NOT NULL,            -- OSS 对象路径
    encrypted_file_key BLOB,         -- AES-KW 加密的 File Key
    iv BLOB,                          -- 文件加密 IV
    salt BLOB,                        -- 加密 salt
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    deleted_at DATETIME,             -- 软删除
    FOREIGN KEY (parent_id) REFERENCES files(id)
);

-- 登录尝试记录 (防暴力破解)
CREATE TABLE login_attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ip_address TEXT NOT NULL,
    success INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 软删除台账 (OSS 对象不物理删除，仅登记)
CREATE TABLE deleted_objects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    file_id TEXT NOT NULL,             -- 来源文件 UUID
    name_encrypted TEXT NOT NULL DEFAULT '',  -- 文件名 (Account Key 密文，零知识)
    oss_key TEXT NOT NULL,             -- OSS 对象路径 (对象保留在 OSS)
    file_size INTEGER NOT NULL DEFAULT 0,
    file_type TEXT NOT NULL DEFAULT '',
    is_version INTEGER NOT NULL DEFAULT 0,  -- 1 = 历史版本对象
    reason TEXT NOT NULL,              -- 单个删除 / 批量删除 (后端固定)
    deleted_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- OSS 加密备份上传台账不在数据库里: 见 data/backups/oss-ledger.json。
-- 原因: ① 台账写入会改变备份内容，MD5 跳过将永远失效；
--       ② 恢复旧数据库快照会把台账回滚，较新的 OSS 对象将从恢复白名单消失。
```

### 4.2 OSS 对象路径

```
files/{uuid}/{random}.enc
db-backups/{lit-aoss_<ts>}.db.enc
```

- UUID: 数据库记录 ID
- Random: 随机字符串，避免路径可预测
- .enc: 标识为加密文件
- `db-backups/`: 数据库备份的 AES-256-GCM 加密副本（服务端直传，密钥 = scrypt(数据库口令)），与 `files/` 隔离

## 5. API 设计

### 5.1 认证相关

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | /api/setup/status | 检查是否已初始化 |
| POST | /api/setup | 首次设置主密码 |
| POST | /api/auth/login | 登录验证（成功响应含后端版本号 `version`，仅此认证成功路径返回） |
| GET | /api/auth/salt | 获取 salt (用于客户端密钥派生) |
| POST | /api/auth/update-key | 更新加密密钥 |

### 5.2 文件操作

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | /api/files | 列出文件 (支持 parent_id 查询) |
| GET | /api/files/:id | 获取单个文件信息 |
| POST | /api/files | 创建文件记录 |
| PUT | /api/files/:id/rename | 重命名文件 |
| DELETE | /api/files/:id | 软删除文件 (写 deleted_objects 台账，不删 OSS 对象) |
| POST | /api/files/batch-delete | 批量删除 (同上) |
| GET | /api/deleted-objects | 查询软删除台账 |

### 5.3 存储操作

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | /api/presign/upload | 获取预签名上传 URL |
| POST | /api/presign/download | 获取预签名下载 URL |
| POST | /api/oss/key | 生成 OSS 对象 key |
| POST | /api/folders | 创建文件夹 |

### 5.4 密钥管理

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | /api/secret/encrypt | 加密明文 (用于 SecretKey) |
| POST | /api/secret/decrypt | 解密密文 |

### 5.5 统计

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | /api/stats | 获取存储统计 |

### 5.6 备份管理

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | /api/backup/config | 备份配置 + 最近一次 OSS 上传摘要 |
| POST | /api/backup/config | 更新备份配置（含两个 *_upload_oss 开关） |
| POST | /api/backup/now | 手动备份，`upload_oss` 可选（弹窗二选一） |
| GET | /api/backup/list | 本地备份列表 + OSS 上传台账（`data/backups/oss-ledger.json`） |
| POST | /api/backup/restore | 本地恢复（需 delete-MFA，恢复前安全快照） |
| POST | /api/backup/restore-oss | 从 OSS 下载加密备份恢复（需 delete-MFA，校验台账白名单） |

备份触发路径统一走 `BackupManager.RunBackup(uploadOSS)`：
- 快照方式: `VACUUM INTO`（含 WAL 未 checkpoint 数据的一致性快照；文件拷贝会得到旧内容且 md5 恒定）
- 定时: `startBackupScheduler` 每 30 秒重读配置，当日到点触发
- 文件操作: `triggerBackup`（带最小间隔）
- 手动: 设置页弹窗二选一
- 上传 OSS 前先 MD5 比对 `data/backups/oss-ledger.json` 台账最新行（台账独立于数据库），内容无变化则跳过
- 恢复: 暂存为 `<db>.restore`，重启时应用（清理 `-wal`/`-shm` 并同步 `.db.enc`，否则启动解密会覆盖恢复结果）

## 6. 项目结构

```
LitAOSS/
├── backend/                              # Go 后端
│   ├── cmd/server/main.go                # 程序入口
│   ├── internal/
│   │   ├── api/
│   │   │   ├── handlers.go               # HTTP 路由与处理器
│   │   │   ├── session.go                # 会话存储
│   │   │   ├── mfa.go                    # TOTP/MFA 逻辑
│   │   │   ├── backup.go                 # 备份管理与恢复
│   │   │   └── ossledger.go              # OSS 备份上传台账 (文件, 不入库)
│   │   ├── config/
│   │   │   └── config.go                 # 配置加载与加密工具
│   │   ├── db/
│   │   │   ├── db.go                     # SQLite 数据库操作
│   │   │   └── cryptdb.go               # 数据库文件加密
│   │   ├── models/
│   │   │   └── models.go                 # 数据模型定义
│   │   ├── storage/
│   │   │   ├── interface.go              # 存储接口定义
│   │   │   ├── aliyun.go                 # 阿里云 OSS 实现
│   │   │   └── noop.go                   # 空存储 (未配置时)
│   │   └── version/
│   │       └── version.go                # 后端版本号 (仅登录成功后返回)
│   ├── config.json                       # 配置文件 (含加密 SecretKey)
│   ├── passphrase.txt                    # 加密口令 (可选)
│   ├── go.mod
│   └── go.sum
│
├── frontend/                             # React 前端
│   ├── src/
│   │   ├── crypto/
│   │   │   └── crypto.ts                 # Web Crypto 加密模块
│   │   ├── preview/
│   │   │   ├── registry.ts               # 预览模块注册表（扩展入口）
│   │   │   ├── modules/                  # 各格式模块描述 (pdf/docx/xlsx)
│   │   │   └── viewers/                  # 懒加载查看器组件
│   │   ├── api/
│   │   │   └── client.ts                 # API 客户端
│   │   ├── hooks/
│   │   │   └── useCrypto.tsx             # 加密状态管理
│   │   ├── components/
│   │   │   ├── LoginScreen.tsx           # 登录/初始化界面
│   │   │   ├── FileExplorer.tsx          # 文件管理器 (核心)
│   │   │   ├── FilePreview.tsx           # 文件预览
│   │   │   ├── TextEditor.tsx            # 文本编辑器
│   │   │   └── Settings.tsx              # SecretKey 加密设置
│   │   ├── App.tsx                       # 主应用
│   │   ├── main.tsx                      # 入口
│   │   └── index.css                     # 全局样式
│   ├── preview-harness.html              # 预览渲染自检页（开发用）
│   ├── previewTest.mjs                   # 自检自动化脚本（开发用）
│   ├── package.json
│   ├── vite.config.ts
│   └── tailwind.config.js
│
├── docs/                                 # 项目文档
│   ├── architecture.md                   # 架构设计文档
│   ├── api-reference.md                  # API 参考文档
│   ├── security.md                       # 安全设计文档
│   └── deployment.md                     # 部署指南
│
├── .gitignore
└── README.md
```

## 7. 扩展性设计

### 7.1 存储抽象层

`Storage` 接口定义了统一的存储操作，可轻松扩展支持其他云存储：

```go
type Storage interface {
    GeneratePresignedUploadURL(ctx, key, expires) (string, error)
    GeneratePresignedDownloadURL(ctx, key, expires) (string, error)
    Upload(ctx, key, reader, size) error
    Download(ctx, key) (io.ReadCloser, error)
    Delete(ctx, key) error
    Exists(ctx, key) (bool, error)
}
```

后续可实现 `TencentCOS`、`MinIO`、`S3` 等。

### 7.2 前端预览插件机制

预览能力通过 `frontend/src/preview/` 的注册表按格式挂载，新增一种可预览格式无需改动主流程：

1. 在 `preview/modules/` 新增模块描述（扩展名列表、类型、大小上限、查看器的动态 `import()`）
2. 在 `preview/index.ts` 调用 `registerPreview()` 注册一行

```ts
interface PreviewModule {
  id: string;                 // 模块标识
  extensions: string[];       // 命中的扩展名
  kind: 'image' | 'text' | 'document';   // 渲染类别
  maxSizeBytes: number;       // 分级大小上限
  load?: () => Promise<{ default: ComponentType<PreviewRenderProps> }>;  // 按需分包
}
```

- `kind: 'document'` 的查看器在预览时才动态加载（Vite 代码分包），不进主包
- 查看器只接收**本地解密后的 `ArrayBuffer`**，全程不出浏览器，符合零知识约束
- 当前内置: 图片 / 文本 / PDF (react-pdf) / Word (docx-preview) / Excel (SheetJS)
- 自检: `frontend/preview-harness.html` + `node previewTest.mjs`（需先启动 vite dev）

### 7.3 预留扩展点

- 文件分享链接 (通过 URL fragment 传递解密密钥)
- 搜索功能 (需对加密文件名建立索引)
