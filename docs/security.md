# LitAOSS 安全设计文档

---

## 1. 安全模型

### 1.1 零知识架构

LitAOSS 采用零知识架构，核心原则：

```
服务端 = 不信任方
┌─────────────────────────────────────┐
│  服务端能接触到:                     │
│  ✓ 加密后的文件 blob                │
│  ✓ 加密后的文件名                   │
│  ✓ 加密后的 File Key                │
│  ✓ 加密后的 Account Key             │
│  ✓ 加密后的 SecretKey               │
│  ✓ 加密后的数据库文件               │
│  ✓ Auth Hash (用于验证身份)          │
│                                     │
│  服务端接触不到:                     │
│  ✗ 主密码                           │
│  ✗ Master Key                      │
│  ✗ Account Key 明文                 │
│  ✗ File Key 明文                    │
│  ✗ SecretKey 明文                   │
│  ✗ 文件明文内容                     │
│  ✗ 文件真实名称                     │
└─────────────────────────────────────┘
```

### 1.2 威胁模型

| 威胁 | 防护措施 |
|------|----------|
| OSS 数据泄露 | 文件在上传前已在浏览器端加密；Bucket 私有 + 预签名 URL |
| 服务器被入侵 | 服务器不存储任何密钥明文 (无法直接解密，但可影响完整性/可用性，见 §12) |
| 数据库泄露 | 密钥均被 AES-KW 包装，解包需主密码；PBKDF2 500k 抗离线爆破 |
| 数据库丢失 | **无法解密**——密钥材料仅存于数据库，靠备份恢复 (见 §11) |
| 暴力破解主密码 | PBKDF2 500k 迭代 + 密码最少 12 字符 + 5 次锁定 |
| 中间人攻击 | 需要 HTTPS (Web Crypto API 要求)；Auth Hash 可重放，明文传输=可登录 |
| XSS / 恶意扩展 | React 自动转义；不解锁时存储中无任何密钥材料；**已解锁期间**注入脚本仍可读内存 (见 §12) |
| 前端代码被篡改 | 前端是信任根，需 HTTPS + 依赖审计 (见 §12) |
| SecretKey 泄露 | AES-256-GCM 加密存储于配置文件 (仅防磁盘泄露，同机被入侵则无效) |
| Setup 竞态攻击 | sync.Mutex + DB 事务保护 |
| 会话劫持 | 登出接口主动失效 + 24h 自动过期 + TOTP 二次验证 |

---

## 2. 密码安全

### 2.1 主密码要求

| 要求 | 值 |
|------|-----|
| 最小长度 | 12 字符 |
| 最大长度 | 128 字符 |
| 字符集 | 任意 Unicode 字符 |
| 存储方式 | 仅存储 PBKDF2 派生的 Auth Hash |

### 2.2 密钥派生

```
密码 + Salt (16字节随机)
    │
    ├─ PBKDF2-SHA256 (500k, 裸 salt) ───────────▶ Auth Hash
    │                                              (身份验证)
    └─ PBKDF2-SHA256 (500k, salt‖"account-key") ─▶ Master Key
                                                   (加密密钥, AES-KW)
```

> **域分离**: 验证用的 Auth Hash 与加密用的 Master Key 来自两次独立的 PBKDF2 派生（Account Key 包装密钥的 salt 追加 `"account-key"` 后缀），两者互不相关。

### 2.3 暴力破解防护

| 层级 | 措施 |
|------|------|
| 计算成本 | PBKDF2 500k 迭代，每次尝试约 200-500ms |
| 账户锁定 | 连续 5 次失败后锁定 15 分钟 |
| 密码复杂度 | 最少 12 字符 |
| 存储安全 | 服务端仅存 Auth Hash，不可逆 |

### 2.4 Setup 竞态防护

- 使用 `sync.Mutex` 防止并发 Setup 请求
- 数据库操作使用事务 (BEGIN/COMMIT)
- 防止通过并发请求覆盖已有账户

---

## 3. 加密安全

### 3.1 对称加密 (文件)

| 参数 | 值 | 说明 |
|------|-----|------|
| 算法 | AES-256-GCM | 认证加密，防篡改 |
| 密钥长度 | 256 位 | 当前最高安全级别 |
| IV 长度 | 12 字节 | 每次加密随机生成 |
| 认证标签 | 128 位 | 检测密文篡改 |

### 3.2 对称加密 (SecretKey)

| 参数 | 值 | 说明 |
|------|-----|------|
| 算法 | AES-256-GCM | 认证加密 |
| 密钥派生 | scrypt (N=32768, r=8, p=1) | 内存硬化，抗 GPU 爆破 |
| Salt | 16 字节随机 | 每次加密唯一 |
| Nonce | 12 字节随机 | GCM 标准 |

### 3.3 密钥包装

| 场景 | 算法 | 说明 |
|------|------|------|
| Account Key 包装 | AES-KW | 用 Master Key 加密（KDF 域分离: `salt‖"account-key"` 派生）；改密时用新 Master Key 重新包装 |
| File Key 包装 | AES-KW | 用 **Account Key** 加密；改主密码不影响 File Key |
| 文件名加密 | AES-GCM | 用 **Account Key** 加密 (改密不受影响) |

### 3.4 随机性

- 所有 IV、Salt、Nonce 使用 CSPRNG 生成
- 浏览器端 `crypto.getRandomValues()`
- 服务端 `crypto/rand`
- 每次加密使用不同值，相同明文产生不同密文

### 3.5 密钥隔离

```
Master Key (由主密码 PBKDF2 派生，浏览器内存)
    │
    └── Account Key (AES-KW 包装后存服务端；改密时用新 Master Key 重新包装)
              │
              ├── File Key₁ (每个文件独立随机，AES-KW 包装后存服务端)
              ├── File Key₂
              └── File Key₃
```

- 单个 File Key 泄露不影响其他文件
- Account Key / File Key 的包装值泄露，需要 Master Key (即主密码) 才能解包
- **改主密码只重新包装 Account Key**，所有 File Key 与文件名保持有效
- 文件名由 Account Key 派生的 AES-GCM 密钥加密 (改密不受影响)
- **不持久化任何解锁材料**: 主密码、salt、包装密钥、Session Token 均只存在页面内存中；刷新 / 新标签页 / 关闭页面 / 锁定都会清除，必须重新输密码解锁
- 文件密钥的包装值、IV、OSS 对象键**只存在数据库中**——数据库丢失即密钥丢失 (见 §11)

---

## 4. 会话安全

### 4.1 会话管理

| 属性 | 值 |
|------|-----|
| 令牌格式 | UUID v4 |
| 存储方式 | 内存 (map) |
| 过期时间 | 24 小时 |
| 传输方式 | HTTP Header (`X-Session-Token`) |

### 4.2 会话生命周期

```
登录 → 创建会话 → 使用 → 登出/过期
         │              │
         └── MFA 验证 ──┘
```

### 4.3 安全措施

- **登出接口**: `POST /api/auth/logout` 主动失效会话
- **单会话在线**: `Login` 成功后调用 `sessions.DeleteAllExcept(新 Token)`——同一时刻只允许一个在线会话，新登录自动踢下线此前所有会话（含停留在 MFA 验证页的会话）
- **空闲超时（前端）**: 30 分钟无输入操作自动登出并退回登录页；最小化浏览器、锁屏等离屏时段不产生输入、不重置计时，离屏超时同样生效（后台定时器 + 恢复可见时立即校验）
- **自动过期**: 24 小时后自动失效
- **改密失效全部会话**: `ChangePassword` 成功后调用 `sessions.DeleteAll()`，所有已登录会话（含旧密码会话）立即失效，需重新登录
- **启用 MFA 失效其他会话**: `MFAEnable` 调用 `sessions.DeleteAllExcept(当前 Token)`，仅保留当前已验证会话
- **验证竞态防护**: `SessionStore.Validate` 使用写锁（`sync.RWMutex` 写路径），避免并发验证竞态
- **MFA 保护**: 启用 MFA 后，新会话需完成 TOTP 验证才能访问受保护资源
- **暴力破解防护**: TOTP 验证失败 5 次后锁定 15 分钟

---

## 5. 网络安全

### 5.1 HTTPS 要求

Web Crypto API 要求安全上下文 (Secure Context)：

| 环境 | 是否需要 HTTPS |
|------|---------------|
| localhost | 不需要 |
| 127.0.0.1 | 不需要 |
| 局域网 IP | 需要 |
| 公网域名 | 需要 |

### 5.2 CORS 配置

```
允许来源: localhost:3000, localhost:5173 (可配置)
允许凭证: true
允许方法: GET, POST, PUT, DELETE, OPTIONS
允许头: Content-Type, X-Session-Token
```

### 5.3 安全头

```
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
X-XSS-Protection: 1; mode=block
Referrer-Policy: strict-origin-when-cross-origin
Content-Security-Policy: default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://*.aliyuncs.com; font-src 'self' data:; connect-src 'self' https://*.aliyuncs.com; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'
```

CSP 双重生效路径:

- **前端**: `frontend/index.html` 的 `<meta http-equiv="Content-Security-Policy">` — 页面由 Vite/nginx 提供时唯一生效的策略
- **后端**: `SecurityHeaders()` 中间件在 API 响应上附带同策略（defense-in-depth）

说明:

- `script-src 'unsafe-inline'` 为 Vite 开发环境内联 HMR preamble 所需；生产环境建议改为 nonce/hash 并去掉 `'unsafe-inline'`
- `img-src` / `connect-src` 允许 `https://*.aliyuncs.com`（浏览器 ↔ OSS 预签名直传/下载）；若 OSS 使用自定义 CNAME 域名，需在两处策略中同步扩展
- `frame-ancestors 'none'` 仅响应头生效（meta 标签中浏览器忽略），配合 `X-Frame-Options: DENY` 防点击劫持

---

## 6. MFA 安全

### 6.1 TOTP 配置

| 参数 | 值 |
|------|-----|
| 算法 | SHA-1 |
| 数字位数 | 6 位 |
| 时间窗口 | 30 秒 |
| 容差 | ±1 步 |

### 6.2 MFA 操作安全

| 操作 | 要求 |
|------|------|
| 启用 MFA | 需要有效的 TOTP 验证码 |
| 禁用 MFA | 需要密码 + TOTP 验证码 |
| 验证 TOTP | 需要有效会话 + 正确验证码 |
| 恢复数据库备份 | 需要 TOTP 验证码（复用 delete-MFA 标记，见 6.4） |
| 重复 MFA Setup | 已启用时返回 `409`，不静默重置（防止把已启用状态清回未启用） |

**MFA 状态单一来源**: 以数据库 `mfa` 表为准。后端启动时读取 `mfa` 表并将结果同步写入 `config.Auth.MFAEnabled`（`main.go`），`config.json` 中的 `mfa_enabled` 字段不再作为权威值——此前 `UpdateBackupConfig` 的整配置保存会把内存中的 `true` 顺带写进 `config.json`，造成"配置文件说已启用、数据库说未启用"的双真相源。

### 6.3 暴力破解防护

- TOTP 验证失败次数按会话追踪
- 连续 5 次失败后锁定 15 分钟
- 禁用 MFA 需要密码二次验证

### 6.4 删除/高危操作二次验证

启用 TOTP 后，以下高危操作额外要求 TOTP 验证:

- 删除文件: `DELETE /api/files/:id`、`POST /api/files/batch-delete`
- 恢复数据库备份: `POST /api/backup/restore`（恢复会覆盖 `mfa`/`sessions` 等敏感表，同样走 `requireDeleteMFA`）

验证流程:

- 每个 Session Token **首次高危操作**前需调用 `POST /api/auth/verify-totp-delete` 完成一次 TOTP 验证
- 验证通过后该 Session 标记 `DeleteMFAVerified`，**同一 Session 后续高危操作不再校验**
- Session 登出/过期/后端重启后失效，需重新验证
- 验证失败计入与登录 TOTP 相同的限流计数 (5 次 / 15 分钟锁定)
- 未验证时接口返回 `403 { "mfa_required": true }`，前端弹出验证码输入框，验证成功后自动重试（文件删除在 `FileExplorer`，备份恢复在 `BackupSettings`）

---

## 7. SecretKey 安全

### 7.1 配置文件加密

config.json 中的 SecretKey 可以加密存储：

```json
{
  "oss": {
    "access_key": "明文 AccessKey",
    "secret_key": "",
    "encrypted_sk": "加密后的 SecretKey"
  }
}
```

### 7.2 加密流程

```
明文 SecretKey + 加密口令
    │
    ▼ scrypt 密钥派生
    │  N=32768, r=8, p=1
    │
    ▼ AES-256-GCM 加密
    │  随机 Salt + Nonce
    │
    ▼
密文 (Hex 编码)
    │
    ▼
配置到 config.json
```

### 7.3 使用流程

1. 通过前端设置页面加密 SecretKey
2. 将加密值配置到 `encrypted_sk` 字段
3. 将 `secret_key` 字段设为空字符串
4. 配置加密口令 (环境变量或文件)
5. 后端启动时自动解密

### 7.4 口令存储方式

| 方式 | 配置方法 |
|------|----------|
| 环境变量 | `set LITAOSS_PASSPHRASE=your-passphrase` |
| 文件 | 在 backend 目录创建 `passphrase.txt` |

---

## 8. 数据库安全

### 8.1 文件级加密

数据库文件支持加密存储，停止服务后自动加密：

```
运行时:
  data/lit-aoss.db     ← 明文 (内存中解密使用)

停止服务后:
  data/lit-aoss.db.enc ← 加密文件 (AES-256-GCM)
  data/lit-aoss.db     ← 已删除
```

### 8.2 加密流程

```
启动:
  读取 .db.enc → 解密 → 写入 .db → 打开数据库

关闭:
  关闭数据库 → 加密 .db → 写入 .db.enc → 删除 .db
```

### 8.3 安全说明

- 加密口令与 SecretKey 加密口令共用同一个
- 运行时数据库为明文 (内存中)，这是 SQLite 的限制
- 真正的敏感数据 (密钥、文件名) 已在应用层加密
- 数据库加密主要防止离线分析元数据

---

## 9. API 安全

### 9.1 认证分级

| 分级 | 端点 | 说明 |
|------|------|------|
| 公开 | `/api/health`, `/api/setup/*`, `/api/auth/salt` | 无需认证 |
| 需会话 | `/api/auth/verify-totp`, `/api/auth/logout` | 需有效会话，不检查 MFA |
| 受保护 | `/api/*` (其他所有) | 需有效会话 + MFA 验证；删除接口另需首次删除二次验证 (§6.4) |

### 9.2 错误信息脱敏

所有 API 错误响应均不泄露:
- 数据库结构/表名
- 文件系统路径
- 内部状态信息
- 加密密钥

**版本号仅认证后返回**: `version` 字段只出现在登录成功的响应中（凭证已验证）；公开端点
（§9.1 第一行）与所有错误响应（400/401/429/500）一律不携带版本号，未登录用户无法通过
响应指纹识别后端版本（v1.5.3，`internal/version`）。

---

## 10. 安全建议

### 10.1 部署

- 必须使用 HTTPS (Let's Encrypt 免费证书)
- 配置防火墙，仅开放必要端口
- 定期更新系统和依赖
- **OSS 最小权限**: 仅 `oss:PutObject` + `oss:GetObject`，**不要授予 `oss:DeleteObject`**——所有删除均为软删除 (对象保留 OSS，登记 `deleted_objects` 台账)，代码中不存在 DeleteObject 调用

### 10.2 密码管理

- 使用密码管理器生成和保存主密码
- 不要在多个服务使用相同密码
- 定期更换主密码 (注意: 需重新加密所有文件)

### 10.3 备份

系统内置数据库备份功能 (设置 → 备份):

- **手动备份**: 立即创建数据库快照，弹窗可选「仅备份数据库」或「备份并上传 OSS」
- **定时备份**: 每天指定时间自动备份（调度器每 30 秒重读配置，开关/时间修改无需重启；停机错过的当日备份启动后补跑一次）
- **操作触发**: 文件新增/编辑/上传后自动备份，带最小间隔 (默认 5 分钟) 防止备份风暴
- 备份存储在 `data/backups/` 目录，自动清理超出数量的旧备份
- 恢复备份前会自动备份当前数据库

**OSS 加密备份副本** (可选，两个独立开关: 定时备份 / 文件操作触发各一):

- 上传前先用 AES-256-GCM 加密，密钥 = `scrypt(数据库口令, salt)` (N=32768, c=8)，格式 `[magic LAOB][version][salt][nonce][ciphertext]` — **未配置数据库口令时拒绝上传**，杜绝明文备份上云
- 对象键 `db-backups/<本地文件名>.enc`，与 `files/` 前缀隔离；本地仍为明文 SQLite
- **本地快照用 `VACUUM INTO`**: journal_mode=WAL 下文件拷贝拿不到未 checkpoint 的数据——旧实现的备份是过期内容（恢复会丢最近写入）且 md5 恒定导致上传永远被跳过
- **MD5 跳过**: 每次上传前计算明文 MD5 并与台账最新行比对，内容无变化则跳过（不调用 OSS ListObjects，无需列表权限）
- **台账在 `data/backups/oss-ledger.json`，不进数据库**（两个原因: ① 台账写入本身会改变备份内容 → 下一次 md5 必然变化 → 跳过永远失效；② 恢复旧数据库快照会把台账回滚 → 较新的 OSS 对象从恢复白名单中消失）
- 台账同时是**从 OSS 恢复的白名单**: `POST /api/backup/restore-oss` 只接受台账内且以 `db-backups/` 开头的 key
- 从 OSS 恢复需通过 delete-MFA 验证（与本地恢复同级），服务端下载 → 解密 → 暂存为 `<db>.restore`，重启时应用（同时清理旧 `-wal`/`-shm` 并同步 `.db.enc`——否则启动解密会用旧 `.enc` 覆盖恢复结果，恢复静默失效）
- 攻击者拿到 OSS 上的备份副本 = 拿到密文，可离线爆破 scrypt 口令 → **数据库口令强度决定备份副本安全**；OSS 泄露场景下备份不增加明文暴露面

补充建议:
- 定期备份 OSS 数据
- 备份 config.json (含加密 SecretKey)
- **切勿备份主密码** — 丢失即数据永久丢失
- **切勿备份加密口令** — 丢失将无法解密 SecretKey 和数据库；注意它同时也是 OSS 加密备份副本的解密口令

### 10.4 监控

- 监控登录失败次数
- 监控异常 API 请求
- 监控 OSS 流量异常

---

## 11. 数据丢失与恢复

### 11.1 数据库是"密钥库"

本系统解密任意 OSS 文件需要**同时**具备:

| 要件 | 说明 | 存放位置 |
|------|------|----------|
| 主密码 | 派生 Master Key | 用户记忆 / 密码管理器 |
| Salt | PBKDF2 输入 | 数据库 `auth.salt` |
| 被包装的 File Key | AES-KW 包装值 | 数据库 `files.encrypted_file_key` / `file_versions.encrypted_file_key` |
| IV | AES-GCM 初始化向量 | 数据库 `files.iv` |
| OSS 对象键 + 密文 | 实际文件内容 | OSS + 数据库 `files.oss_key` |
| 加密文件名 | 展示用 (Account Key 加密) | 数据库 `files.name_encrypted` |

主密码派生出的 Master Key 只是一把"开锁的钥匙"，**被它解包的密钥本体全部存在数据库里**。

### 11.2 丢失场景分析

| 场景 | 可解密? | 说明 |
|------|---------|------|
| 数据库丢失 + 无备份 + 无已登录会话 | ❌ **永远不可解密** | 即使知道主密码——被包装的 File Key、IV、OSS 键已不存在，无东西可解包 |
| 数据库丢失 + 有 `data/backups/` 备份 | ✅ | 恢复备份后一切正常，主密码不变 |
| 数据库泄露(被攻击者拷走) | ⚠️ 取决于主密码强度 | 攻击者可离线爆破 PBKDF2 500k；强随机密码安全，弱密码=全部失守 |
| 主密码遗忘 | ❌ 永远不可解密 | 服务端只有 Auth Hash，不可逆，无法找回 |
| OSS 泄露(对象或 SecretKey) | ❌ 仅得密文 | 无主密码 + 无数据库密钥材料无法解密；但可被篡改/删除 (完整性/可用性风险) |
| 后端服务器被入侵 | ❌ 不可直接解密 | 可拿到 DB、会话 token、OSS 凭证 → 全量密文读取与篡改；解密仍需主密码。若同机能改前端代码则可偷主密码 |

### 11.3 恢复路径与建议

1. **数据库备份 = 密钥备份**: `data/backups/` 中的快照包含解密所需的全部包装密钥，其安全等级应与主密码同级
2. 定期手动备份 (设置 → 备份)，并把备份复制到**离线/异机**位置 (防服务器整机丢失)；开启「备份并上传 OSS」即为自带的异机副本（加密态）
3. 备份可被离线爆破 → 备份存放位置本身需受保护；主密码强度是最后防线（本地明文备份爆破 PBKDF2/口令，OSS 加密副本爆破 scrypt 口令）
4. 页面内存中的解锁材料（主密码 / salt / 包装密钥）仅当次会话有效，**不构成备份**
5. (未来改进方向) 提供"恢复包导出"功能: 将包装密钥 + salt 导出为用主密码加密的 JSON，供用户离线保管

---

## 12. 已知风险与限制

以下为当前实现的**残余风险**，按实际危害排序:

### 12.1 浏览器端会话

- **不持久化**: 主密码、salt、包装后的 Account Key、Session Token 全部只保存在页面内存中
  - 刷新 / 新标签页 / 关闭页面 / 点击锁定 → 全部清除，必须重新输密码解锁
  - 浏览器磁盘上没有可被拷走离线使用的密钥材料
- **残余风险（已解锁使用期间）**:
  - 页面内注入的 JS (XSS) 可读取内存中的密码/密钥位、可 hook 解密函数直接窃取**文件明文**、可在输入时记录密码
  - 恶意浏览器扩展只能在你**已解锁操作时**作恶（存储中已无秘密可轮询）
  - 共享终端：你走开未锁定 = 攻击者等同于你 → 用完请点锁定
- 根治手段: 防 XSS（避免危险 HTML 注入、依赖审计、CSP、HTTPS），而非存储策略
- 权衡说明: 不提供"刷新自动解锁"（每次刷新需重新输密码 + PBKDF2 500k 约 1-2 秒），换取存储零密钥

### 12.2 前端是信任根

- 全部加密逻辑与密钥都在前端完成，被篡改的前端 (npm 依赖投毒、构建链被入侵、非 HTTPS 中间人) 可直接窃取主密码
- 缓解: 固定依赖版本、审计依赖、生产环境 HTTPS、自行构建部署 (不使用不可信 CDN)

### 12.3 网络

- 登录提交的 Auth Hash 是密码的**等价验证值**，非 HTTPS 下被截获可直接重放登录
- 非 HTTPS 下 session token、密文均可被窃听 (密文本身不可解，但暴露访问行为与文件大小)
- 强制: 公网/局域网部署必须 HTTPS，仅 localhost 可例外

### 12.4 服务端被入侵

- 可获得: 数据库 (全部包装密钥)、内存中的 session、OSS SecretKey、启动口令
- **不可**获得: 主密码、Master Key/File Key 明文 → 无法解密
- 但可: 下载全部密文、**篡改/删除文件与数据库** (GCM 认证标签能检测篡改但无法溯源)、若可修改前端部署则升级为可窃取主密码
- 局限: 当前无服务端签名/透明日志，完整性保护止于"可检测"

### 12.5 密码学参数

- PBKDF2-SHA256 500k 对现代 GPU 爆破偏紧 (OWASP 建议 ≥600k)，实际安全性依赖 12+ 字符高熵主密码
- 改进方向: 前端可用 Argon2id 或提高迭代次数 (需同步登录/验证逻辑)
- 前端存在两套 PBKDF2 实现 (`crypto.ts` / `fileKey.ts`)，**迭代次数与域分离后缀必须保持一致**，修改 KDF 参数时必须同步两处
- SecretKey 的 scrypt (N=32768) 同理，且 `passphrase.txt` 通常与数据同机存放，仅防磁盘/备份泄露，不防同机入侵

### 12.6 运行时明文

- 运行时 SQLite 数据库为明文，停止服务后才加密 (`.db.enc`)；且解密口令常与数据同目录 → 加密仅防"拷走文件离线分析"，不防"入侵正在运行的服务器"
- 本地备份快照 (`data/backups/`) 为明文 SQLite，处置等级等同密钥库；上传到 OSS 的备份副本为 AES-256-GCM 加密态（见 §10.3），泄露仅得密文

### 12.7 单用户 + 内存会话

- 会话表在内存中，重启后端 = 所有用户强制重新登录 (安全上是优点，运维上需知悉)
- 单账户模型，无多租户隔离需求

### 12.8 OSS 对象只增不减 (软删除)

- 为撤销 `oss:DeleteObject` 权限，删除均为软删除: 对象保留在 OSS，`deleted_objects` 台账登记 (文件名密文、oss_key、大小、原因、时间)，`GET /api/deleted-objects` 可查询
- 后果: 存储只增不减；清理需在 OSS 控制台按台账手动删除对象 (或临时恢复 DeleteObject 权限)
- **不可用 OSS 生命周期规则替代**: 规则按前缀/时间一刀切，无法区分存活对象与软删对象，会误删在用文件
- 已知孤儿: 上传 PUT 成功但 `createFileRecord` 失败的对象无任何记录，无法通过台账发现 (概率极低，既有问题)
