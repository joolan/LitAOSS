# LitAOSS API 参考文档

> Base URL: `http://localhost:8780`  
> Content-Type: `application/json`

---

## 认证机制

所有标记为 [需要鉴权] 的接口需要在请求头中携带 Session Token:

```
X-Session-Token: <token>
```

Session Token 在登录成功后返回，有效期 24 小时。

认证分级:
- **公开接口**: 无需认证
- **会话接口**: 需有效会话，不检查 MFA 状态
- **受保护接口**: 需有效会话 + MFA 验证 (如已启用)

---

## 1. 公开接口 (无需鉴权)

### GET /api/health

健康检查。

**响应:**
```json
{
  "status": "ok"
}
```

### GET /api/setup/status

检查系统是否已完成初始化。

**响应:**
```json
{
  "setup_complete": true
}
```

### POST /api/setup

首次设置主密码。仅在未初始化时可用。

**请求:**
```json
{
  "password_hash": "PBKDF2 派生的 Auth Hash (Base64)",
  "salt": "PBKDF2 salt (Base64)",
  "encrypted_account_key": "加密后的 Account Key (Base64)"
}
```

**响应:**
```json
{
  "ok": true
}
```

**错误:**
- `409` — 已初始化，无法重复设置

### POST /api/auth/login

登录验证。

**请求:**
```json
{
  "auth_hash": "PBKDF2 派生的 Auth Hash (Base64)",
  "salt": "使用的 salt (Base64)"
}
```

**响应 (成功):**
```json
{
  "ok": true,
  "encrypted_account_key": "加密后的 Account Key (Base64)",
  "salt": "salt (Base64)",
  "session_token": "用于后续请求的 token",
  "version": "v1.5.3"
}
```

**响应 (失败):**
```json
{
  "ok": false,
  "error": "invalid credentials"
}
```

**错误:**
- `429` — 登录尝试次数过多，已被锁定

> **后端版本号**: `version` 字段仅在凭证验证成功时返回（version 源自 `internal/version`，可用 ldflags 覆盖）。
> **单会话在线**: 每次登录成功会注销此前的全部会话（含停留在 MFA 验证页的会话）。旧设备的下一次请求将收到 `401`，前端自动退回登录页。
> 匿名接口（`/api/health`、`/api/setup/status`、`/api/auth/salt`）与所有错误响应（401/400/429 等）
> 一律不携带版本号，未登录用户无法获取后端版本以做指纹识别。前端将版本暂存于页面内存，
> 在「设置」弹窗标题旁展示。

### GET /api/auth/salt

获取 salt (用于客户端密钥派生)。

**响应:**
```json
{
  "salt": "Base64 编码的 salt"
}
```

---

## 2. 会话接口 (需有效会话)

以下接口需要在请求头中携带 `X-Session-Token`，但不检查 MFA 状态。

### POST /api/auth/verify-totp

验证 TOTP 验证码 (MFA 登录流程)。

**请求:**
```json
{
  "code": "6位验证码"
}
```

**响应:**
```json
{
  "ok": true
}
```

**错误:**
- `400` — 验证码错误
- `429` — 验证尝试次数过多，已被锁定

### POST /api/auth/logout

登出并销毁当前会话。

**响应:**
```json
{
  "ok": true
}
```

---

## 3. 受保护接口 (需鉴权 + MFA)

以下接口需要在请求头中携带 `X-Session-Token`，如已启用 MFA 则需完成 TOTP 验证。

### POST /api/auth/verify-totp-delete

删除操作的二次 MFA 验证 (启用 TOTP 时)。每个 Session Token 首次删除文件前需调用一次；验证通过后同一 Session 的后续删除不再校验。

**请求:**
```json
{
  "code": "6位验证码"
}
```

**响应:**
```json
{
  "ok": true
}
```

**错误:**
- `400` — 验证码错误
- `429` — 验证尝试次数过多，已被锁定

> 未完成验证时调用 `DELETE /api/files/:id` 或 `POST /api/files/batch-delete` 会返回
> `403 { "mfa_required": true, "error": "MFA verification required for delete" }`。

### POST /api/auth/update-key

更新加密密钥 (需要验证密码)。

**请求:**
```json
{
  "encrypted_account_key": "新的加密 Account Key (Base64)",
  "password_hash": "当前密码的 Auth Hash"
}
```

**响应:**
```json
{
  "ok": true
}
```

### GET /api/auth/salt

获取 salt (用于客户端密钥派生)。

**响应:**
```json
{
  "salt": "Base64 编码的 salt"
}
```

---

## 3. 文件操作

### GET /api/files

列出文件/文件夹。

**查询参数:**
- `parent_id` (可选) — 父目录 ID，不传则列出根目录

**响应:**
```json
{
  "files": [
    {
      "id": "uuid",
      "name_encrypted": "Base64 编码的加密文件名",
      "parent_id": "父目录 ID 或 null",
      "is_directory": false,
      "file_size": 1024,
      "file_type": "text/plain",
      "oss_key": "files/uuid/random.enc",
      "encrypted_file_key": "Base64 编码的加密 File Key",
      "iv": [1, 2, 3, ...],
      "salt": [],
      "created_at": "2026-09-22T12:00:00Z",
      "updated_at": "2026-09-22T12:00:00Z",
      "deleted_at": null
    }
  ]
}
```

### GET /api/files/:id

获取单个文件信息。

**响应:** 同上单个文件对象。

### POST /api/files

创建文件记录 (上传完成后调用)。

**请求:**
```json
{
  "name_encrypted": "加密后的文件名 (Base64)",
  "parent_id": "父目录 ID (可选)",
  "file_size": 1024,
  "file_type": "text/plain",
  "encrypted_file_key": "加密的 File Key (Base64)",
  "iv": [1, 2, 3, ...],
  "salt": [],
  "oss_key": "files/uuid/random.enc"
}
```

**响应:** 创建的文件对象。

### PUT /api/files/:id/rename

重命名文件 (更新加密文件名)。

**请求:**
```json
{
  "id": "文件 ID",
  "name_encrypted": "新的加密文件名 (Base64)"
}
```

**响应:**
```json
{
  "ok": true
}
```

### PUT /api/files/:id/content

更新文件内容元数据 (文本编辑保存时调用；旧内容已先存入版本历史)。

**请求:**
```json
{
  "file_size": 2048,
  "file_type": "text/plain",
  "encrypted_file_key": "新内容的 File Key (Base64 或字节数组)",
  "iv": [1, 2, 3, ...],
  "salt": [],
  "oss_key": "files/uuid/random.enc"
}
```

**响应:**
```json
{
  "ok": true
}
```

### GET /api/files/:id/versions

列出文件的历史版本。

**响应:**
```json
{
  "versions": [
    {
      "id": "uuid",
      "file_id": "文件 ID",
      "version": 1,
      "oss_key": "versions/uuid/1.enc",
      "encrypted_file_key": "该版本的 File Key (Base64)",
      "iv": "Base64",
      "salt": "",
      "file_size": 1024,
      "created_at": "2026-09-24T12:00:00Z"
    }
  ]
}
```

### POST /api/files/:id/versions

创建历史版本记录 (保存/恢复前把旧内容存档)。

**请求:**
```json
{
  "oss_key": "versions/uuid/1.enc",
  "encrypted_file_key": "该版本的 File Key (Base64)",
  "iv": "Base64",
  "salt": "",
  "file_size": 1024
}
```

**响应:**
```json
{
  "ok": true
}
```

### DELETE /api/files/:id

软删除文件 (设置 deleted_at)。**OSS 对象不物理删除**: 主对象与该文件全部历史版本对象写入 `deleted_objects` 台账 (reason=`单个删除`)，对象保留在 OSS 上。

**请求:**
```json
{
  "id": "文件 ID"
}
```

**响应:**
```json
{
  "ok": true
}
```

### POST /api/files/batch-delete

批量删除文件。同样写入 `deleted_objects` 台账 (reason=`批量删除`)，不触碰 OSS。

**请求:**
```json
{
  "ids": ["id1", "id2", "id3"]
}
```

**响应:**
```json
{
  "ok": true
}
```

### GET /api/deleted-objects

查询软删除台账: 所有保留在 OSS 上但已逻辑删除的对象 (主对象 + 历史版本对象)，按删除时间倒序。文件名以 Account Key 密文存储 (零知识，服务端不可读)。

**权限:** 需有效会话

**响应:**
```json
{
  "ok": true,
  "deleted_objects": [
    {
      "id": 1,
      "file_id": "文件 UUID",
      "name_encrypted": "Iv+密文 base64",
      "oss_key": "files/uuid/random.enc",
      "file_size": 102400,
      "file_type": "text/plain",
      "is_version": false,
      "reason": "单个删除",
      "deleted_at": "2026-09-25T12:00:00Z"
    }
  ]
}
```

`is_version: true` 表示该文件的历史版本对象；`reason` 取值: `单个删除` / `批量删除` (后端固定，不可自定义)。

---

## 4. 文件夹

### POST /api/folders

创建文件夹。

**请求:**
```json
{
  "name_encrypted": "加密后的文件夹名 (Base64)",
  "parent_id": "父目录 ID (可选)"
}
```

**响应:** 创建的文件夹对象。

---

## 5. 存储

### POST /api/presign/upload

获取预签名上传 URL。

**请求:**
```json
{
  "oss_key": "files/uuid/random.enc",
  "expires": 3600
}
```

- `expires` (可选) — 签名有效期，单位秒，**默认 3600（1 小时）**；过期后 PUT 返回 403

**响应:**
```json
{
  "url": "https://bucket.oss-cn-hangzhou.aliyuncs.com/..."
}
```

### POST /api/presign/download

获取预签名下载 URL。

**请求:**
```json
{
  "oss_key": "files/uuid/random.enc",
  "expires": 3600
}
```

- `expires` (可选) — 签名有效期，单位秒，**默认 3600（1 小时）**；过期后 GET 返回 403

**响应:**
```json
{
  "url": "https://bucket.oss-cn-hangzhou.aliyuncs.com/..."
}
```

### POST /api/oss/key

生成 OSS 对象 key。

**查询参数:**
- `folder` (可选) — 目录前缀，默认 "files"

**响应:**
```json
{
  "oss_key": "files/uuid/random.enc"
}
```

---

## 6. 密钥管理

### POST /api/secret/encrypt

加密明文字符串 (用于 SecretKey 加密)。

**请求:**
```json
{
  "plaintext": "明文 SecretKey",
  "passphrase": "加密口令"
}
```

**响应:**
```json
{
  "encrypted": "a1b2c3d4e5f6..."
}
```

### POST /api/secret/decrypt

解密密文字符串。

**请求:**
```json
{
  "encrypted": "a1b2c3d4e5f6...",
  "passphrase": "加密口令"
}
```

**响应:**
```json
{
  "plaintext": "明文 SecretKey"
}
```

---

## 7. MFA 管理

### POST /api/mfa/setup

初始化 MFA (返回 TOTP 密钥和 URI)。

**响应:**
```json
{
  "ok": true,
  "secret": "TOTP 密钥",
  "uri": "otpauth://totp/..."
}
```

### POST /api/mfa/enable

启用 MFA (验证 TOTP 验证码)。

**请求:**
```json
{
  "code": "6位验证码"
}
```

**响应:**
```json
{
  "ok": true
}
```

### POST /api/mfa/disable

禁用 MFA (需密码 + TOTP 验证码)。

**请求:**
```json
{
  "code": "6位验证码",
  "password_hash": "当前密码的 Auth Hash"
}
```

**响应:**
```json
{
  "ok": true
}
```

### GET /api/mfa/status

获取 MFA 状态。

**响应:**
```json
{
  "ok": true,
  "enabled": true
}
```

---

## 8. 统计

### GET /api/stats

获取存储统计信息。

**响应:**
```json
{
  "total_size": 1048576,
  "file_count": 42,
  "folder_count": 5
}
```

---

## 9. 备份管理 [需要鉴权]

### GET /api/backup/config

获取当前备份配置及最近一次 OSS 上传摘要。

**响应:**
```json
{
  "ok": true,
  "config": {
    "auto_backup": false,
    "backup_time": "03:00",
    "on_file_change": false,
    "min_interval": 300,
    "max_backups": 10,
    "auto_backup_upload_oss": false,
    "on_file_change_upload_oss": false
  },
  "oss_backup": {
    "name": "lit-aoss_20260925_213531.db",
    "md5": "49e7fe1fdfb6ea388ae519df2a6feaa4",
    "file_size": 90161,
    "uploaded_at": "2026-09-25T13:35:32Z"
  }
}
```

`oss_backup` 无上传记录时为 `null`。

### POST /api/backup/config

更新备份配置。

**请求:**
```json
{
  "auto_backup": true,
  "backup_time": "03:00",
  "on_file_change": true,
  "min_interval": 300,
  "max_backups": 10,
  "auto_backup_upload_oss": true,
  "on_file_change_upload_oss": false
}
```

所有字段可选，仅更新提供的字段。两个 `*_upload_oss` 开关分别控制定时备份 / 文件操作触发备份是否同时上传加密副本到 OSS；两条自动备份路径各由自己的开关独立控制。

### POST /api/backup/now

立即执行手动备份，可选择是否同时上传 OSS。

**请求 (可选，缺省为不上传):**
```json
{
  "upload_oss": true
}
```

**响应:**
```json
{
  "ok": true,
  "path": "./data/backups/lit-aoss_20260925_213531.db",
  "oss": "uploaded"
}
```

`oss` 取值:
- `not_requested` — 仅本地备份
- `uploaded` — 加密副本已上传 OSS
- `skipped` — 备份内容与上次上传一致（MD5 相同），跳过上传
- `failed` — 本地备份成功但上传失败，附 `oss_error` 字段

上传的副本使用 AES-256-GCM 加密（密钥 = scrypt(数据库口令)）；未配置数据库口令时拒绝上传。

### GET /api/backup/list

列出所有历史备份与 OSS 加密备份台账。

**响应:**
```json
{
  "ok": true,
  "backups": [
    {
      "name": "lit-aoss_20260923_150405.db",
      "size": 123456,
      "created_at": "2026-09-23T15:04:05Z"
    }
  ],
  "oss_backups": [
    {
      "id": 1,
      "name": "lit-aoss_20260925_213531.db",
      "oss_key": "db-backups/lit-aoss_20260925_213531.db.enc",
      "md5": "49e7fe1fdfb6ea388ae519df2a6feaa4",
      "file_size": 90161,
      "uploaded_at": "2026-09-25T13:35:32Z"
    }
  ]
}
```

`oss_backups` 读取本地台账文件 `data/backups/oss-ledger.json`（台账独立于数据库，见 architecture §4.1），不调用 OSS ListObjects（无需列表权限）。

### POST /api/backup/restore

恢复指定备份。会先自动备份当前数据库。

恢复内容**暂存**为 `<数据库路径>.restore`，重启服务端时应用（同时清理旧 `-wal`/`-shm` 并同步 `.db.enc`——否则启动解密会用旧 `.enc` 覆盖恢复结果）。暂存期间运行中的服务不受影响。

**请求:**
```json
{
  "name": "lit-aoss_20260923_150405.db"
}
```

**响应:**
```json
{
  "ok": true,
  "message": "restore staged, restart server to apply"
}
```

**错误 (MFA 未验证):**
```json
{
  "ok": false,
  "mfa_required": true,
  "error": "MFA verification required for delete"
}
```

启用 TOTP 时恢复属于高危操作: 首次恢复前需调用 `POST /api/auth/verify-totp-delete`（见「verify-totp-delete」），前端 `BackupSettings` 会自动弹出验证码输入框并重试。未验证时返回 `403`。

> **注意**: 恢复后需要重启后端服务。

### POST /api/backup/restore-oss

从 OSS 下载指定的加密备份，解密后恢复（与本地恢复走同一流程，同样先对当前数据库做安全快照）。

**请求:**
```json
{
  "oss_key": "db-backups/lit-aoss_20260925_213531.db.enc"
}
```

**约束:**
- `oss_key` 必须以 `db-backups/` 开头，且存在于 OSS 上传台账中（拒绝任意对象；台账文件 `data/backups/oss-ledger.json`）
- 需要配置数据库口令才能解密，否则返回 `500`
- 启用 MFA 时需先通过 delete-MFA 验证（同 `/backup/restore`，未验证返回 `403 {"mfa_required": true}`）

**响应:**
```json
{
  "ok": true,
  "message": "restore staged, restart server to apply"
}
```

> **注意**: 恢复内容重启后生效（同本地恢复的暂存机制）。

---

## 错误响应格式

所有错误响应格式:

```json
{
  "ok": false,
  "error": "错误描述"
}
```

常见 HTTP 状态码:
- `200` — 成功
- `400` — 请求参数错误
- `401` — 认证失败
- `404` — 资源不存在
- `409` — 冲突 (如重复初始化)
- `429` — 请求过于频繁
- `500` — 服务器内部错误
