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

### POST /api/auth/verify-recovery

用**恢复码**完成 MFA 验证（认证器丢失时的登录途径）。与 `verify-totp` 共用
pending 会话流转与失败锁定；恢复码**一次性消费**，用过即失效。

**请求:**
```json
{
  "code": "ABCD-EFGH-JKLM-NPQR-STUV"
}
```

（大小写、横线、空格不敏感，服务端规范化后比对）

**响应:**
```json
{
  "ok": true
}
```

**错误:**
- `400` — 恢复码无效或已使用过
- `429` — 尝试次数过多，已被锁定（与 TOTP 共用计数）

**安全说明:** 恢复码为 96 bit 密码学随机值，服务端仅存 SHA-256 哈希；
离线暴力枚举不可行，不破坏零知识口径。重新生成使旧码全部失效；
禁用 MFA 时恢复码随之清空。

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

### GET /api/auth/login-history

获取最近 50 条登录尝试（倒序，含成功与失败）。密码错误与 MFA 验证失败均记录且**完整保留**（成功登录后旧失败不再删除，只按"晚于最近一次成功的失败"计算锁定计数）。IP 取自可信代理提交的 `X-Forwarded-For`（见 `server.trusted_proxies`）。

**响应:**
```json
{
  "attempts": [
    { "id": 7, "ip_address": "127.0.0.1", "success": true, "created_at": "2026-09-27T01:24:07Z" },
    { "id": 6, "ip_address": "127.0.0.1", "success": false, "created_at": "2026-09-27T01:20:11Z" }
  ]
}
```

---

### GET /api/auth/login-stats

近 N 天（`days` 可选，默认 30，1–90）每日**成功**登录次数，供统计页图表使用。按日期升序返回，无登录的日期不出现（前端补零）。

**查询参数:** `days` — 统计天数（默认 30）

**响应:**
```json
{
  "days": [
    { "day": "2026-09-25", "count": 2 },
    { "day": "2026-09-27", "count": 1 }
  ]
}
```

---

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
  "oss_key": "files/uuid/random.enc",
  "content_hash": "客户端内容哈希 (可选，用于去重)"
}
```

**响应:** 创建的文件对象。

### POST /api/files/dedup-check

内容寻址查重：客户端在上传前提交内容哈希，命中则可跳过加密与 OSS 上传、
直接复用既有文件的密钥封装字段建记录（同内容同一密文对象）。

内容哈希为客户端用 **Account Key** 派生的 HMAC-SHA256（见 `contentHash.ts`），
服务端只做相等比对，无密钥无法离线猜解，不破坏零知识模型。
修改主密码只重新包装 Account Key、原始字节不变，改密前后哈希稳定，查重持续有效。

**请求:**
```json
{
  "content_hash": "64 位十六进制哈希"
}
```

**响应:**
```json
{ "found": false }
```

或命中：

```json
{
  "found": true,
  "file": {
    "oss_key": "files/uuid/random.enc",
    "encrypted_file_key": "复用的 File Key 封装",
    "iv": "...",
    "salt": "...",
    "file_size": 1024,
    "file_type": "text/plain"
  }
}
```

**说明:**
- 仅匹配有效（未软删除）的文件记录；历史文件无 `content_hash`（NULL）不参与匹配
- 恢复历史版本会清空 `content_hash`（内容未知，宁可失去去重也不误配）

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

### PUT /api/files/:id/move

移动文件或文件夹到指定目录（`parent_id` 传 `null`/省略表示移到根目录）。

**请求:**
```json
{
  "parent_id": "目标文件夹 ID 或 null"
}
```

**校验规则:**
- 目标必须存在且为文件夹，否则 `400`
- 不能移动到自身；文件夹不能移动到自身的子文件夹（防环），否则 `400`

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
  "oss_key": "files/uuid/random.enc",
  "content_hash": "新内容的客户端哈希；空字符串表示清除（内容未知时）"
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

软删除文件 (设置 deleted_at)。**OSS 对象不物理删除**；此阶段不登记台账（对象需支撑恢复与历史版本），`deleted_objects` 台账在物理清理时按剩余引用登记（见 `POST /api/trash/purge`）。

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

批量删除文件。同样仅标记软删，不触碰 OSS、不登记台账（时机同单个删除）。

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

查询删除台账: 已**物理清理**（purge）且经引用检查确认无任何存活引用的对象 (主对象 + 历史版本对象，去重复用的共享对象仅在最后一个引用消失后登记)，按登记时间倒序。文件名以 Account Key 密文存储 (零知识，服务端不可读)。

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
      "reason": "回收站物理清理",
      "deleted_at": "2026-09-25T12:00:00Z"
    }
  ]
}
```

`is_version: true` 表示该文件的历史版本对象；`reason` 取值: `回收站物理清理`（物理清理登记时固定写入）。

### GET /api/audit

操作审计分页列表 (按 id 倒序)。记录 `upload` / `download`(仅 purpose=download) / `delete` / `rename` / `move` / `edit` / `change_password` / `create_folder` / `restore` / `purge_trash`；文件名为密文 (前端会话内解密，零知识不变)，IP 为可信代理口径下的客户端 IP。审计失败仅记日志、不影响业务。

**权限:** 需有效会话 + MFA

**查询参数:**
- `page` (可选) — 页码，1 起，默认 1
- `page_size` (可选) — 每页条数，默认 50，上限 200
- `action` (可选) — 按动作过滤，非法取值返回 400

**响应:**
```json
{
  "ok": true,
  "items": [
    {
      "id": 1,
      "action": "delete",
      "target_type": "file",
      "target_id": "文件 UUID",
      "name_encrypted": "Iv+密文 base64",
      "detail": "单个删除",
      "ip_address": "1.2.3.4",
      "created_at": "2026-09-28T12:00:00Z"
    }
  ],
  "total": 123
}
```

`rename` 的 `detail` 存旧文件密文名；`move` 的 `detail` 存目标目录密文名 (空 = 根目录)；`upload` 的 `detail` 存字节数。

### GET /api/trash

回收站列表: 仅含显式软删 (`deleted_at IS NOT NULL`) 的行，被删文件夹的子项不重复出现。文件名为密文。

**权限:** 需有效会话 + MFA

**响应:**
```json
{
  "ok": true,
  "items": [
    {
      "id": "文件 UUID",
      "name_encrypted": "Iv+密文 base64",
      "is_directory": false,
      "file_size": 102400,
      "parent_id": "原父目录 UUID 或 null",
      "deleted_at": "2026-09-28T12:00:00Z"
    }
  ],
  "retention_days": 30
}
```

`retention_days` 为 0 表示从不自动清理 (配置 `trash.retention_days`)。

### POST /api/trash/:id/restore

恢复软删条目。原父目录仍存在且未删除则回原位，否则回根目录。**不需要删除 MFA** (恢复为反破坏操作)。恢复动作写入审计 (`restore`)。

**权限:** 需有效会话 + MFA

**响应:**
```json
{ "ok": true, "parent_id": "恢复到的父目录 UUID，null 表示根目录" }
```

条目不在回收站时返回 404。

### POST /api/trash/purge

清空回收站: 立即物理删除全部软删行及其后代，**不可恢复**。与删除同受 MFA 二次验证保护 (`verify-totp-delete`，同一会话仅首次需要)。写入审计 (`purge_trash`)。

**权限:** 需有效会话 + 删除 MFA

**响应:**
```json
{ "ok": true, "purged": 12 }
```

超过 `trash.retention_days` 的条目由后台任务每日自动物理清理 (启动时补跑)，清理时按剩余引用登记台账 `deleted_objects`；台账保留 90 天、审计 `audit_log` 保留 180 天后清理。

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
  "expires": 3600,
  "purpose": "download"
}
```

- `expires` (可选) — 签名有效期，单位秒，**默认 3600（1 小时）**；过期后 GET 返回 403
- `purpose` (可选) — 仅 `"download"` (拖出下载) 时后端记入下载审计并反查文件名；预览/编辑器加载不传，不计入下载计量

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

初始化 MFA (返回 TOTP 密钥和 URI)。**必须携带主密码派生的 `password_hash`**：仅凭会话（如会话被盗）不允许重置 TOTP 密钥，防止偷换认证器后锁定号主，与 `mfa/disable` 同一验证与锁定策略。

**请求:**
```json
{
  "password_hash": "当前密码的 Auth Hash"
}
```

**响应:**
```json
{
  "ok": true,
  "secret": "TOTP 密钥",
  "uri": "otpauth://totp/..."
}
```

**错误:**
- `400` — `password_hash` 缺失或密码错误
- `409` — MFA 已启用（需先禁用）
- `429` — 验证失败次数过多，已被锁定（5 次 / 15 分钟，与改密码/禁用 MFA 共用计数）

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

### POST /api/mfa/recovery-codes

生成（或整体重新生成）10 个一次性登录恢复码，**明文仅本次响应返回**，
请立即离线保存。重新生成会使旧码全部失效。需 MFA 已启用，且**必须携带主密码派生的
`password_hash`**：恢复码是长期 MFA 凭证，仅凭会话不得铸造/轮换（防会话被盗后预置
自己的码或静默作废号主的找回码），与 `mfa/setup`、`mfa/disable` 同一验证与锁定策略。

**请求:**
```json
{
  "password_hash": "当前密码的 Auth Hash"
}
```

**响应:**
```json
{
  "ok": true,
  "codes": ["ABCD-EFGH-JKLM-NPQR-STUV", "..."],
  "total": 10
}
```

**错误:**
- `400` — MFA 未启用 / `password_hash` 缺失或密码错误
- `429` — 验证失败次数过多，已被锁定（5 次 / 15 分钟，与改密码/禁用 MFA 共用计数）

### GET /api/mfa/status

获取 MFA 状态及恢复码统计。

**响应:**
```json
{
  "ok": true,
  "enabled": true,
  "recovery_total": 10,
  "recovery_remaining": 7
}
```

---

## 8. 统计

### GET /api/stats

获取存储统计信息（**仅根目录直下条目**；全库统计见 `/stats/summary`）。

**响应:**
```json
{
  "total_size": 1048576,
  "file_count": 42,
  "folder_count": 5
}
```

---

### GET /api/stats/summary

全库统计（统计页图表数据源）：总量、文件类型分布、顶层目录占用 Top 10。
目录名返回**加密形态**，由客户端解密后展示（零知识不变）。

**响应:**
```json
{
  "totals": { "total_size": 1048576, "file_count": 42, "folder_count": 5 },
  "types": [
    { "file_type": "image/png", "count": 12, "size": 524288 },
    { "file_type": "unknown", "count": 1, "size": 1024 }
  ],
  "top_dirs": [
    { "id": "目录 ID", "name_encrypted": "加密目录名", "count": 30, "size": 900000 },
    { "id": "", "name_encrypted": "", "count": 4, "size": 100000 }
  ]
}
```

**说明:**
- 仅统计未软删除记录；目录占用为该**顶层目录**下全部文件递归求和
- `id` 为空字符串表示根目录散文件（`name_encrypted` 同样为空，客户端自行命名）
- `file_type` 为空归一为 `"unknown"`

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

### POST /api/backup/drill

**恢复演练**：验证指定备份（缺省 = 本地最新一份）能被真实恢复流程打开、迁移并读取。把备份字节级复制到临时目录后，走与恢复后启动完全相同的 `db.New → 建表/迁移 → 全量查询` 路径做只读体检——**不写 `.restore`、不触碰线上数据、不需要 MFA 二次验证，可反复执行**。

**请求**（body 可省略或为空 = 最新备份）:
```json
{
  "name": "lit-aoss_20260927_030000.db"
}
```

**响应**（体检失败也返回 `200`，由 `ok`/`checks` 表达结果）:
```json
{
  "ok": true,
  "report": {
    "ok": true,
    "name": "lit-aoss_20260927_030000.db",
    "size": 49152,
    "created_at": "2026-09-27T03:00:01Z",
    "checks": [
      { "name": "备份文件", "ok": true, "detail": "…（49152 字节）" },
      { "name": "字节级拷贝", "ok": true, "detail": "已复制到临时目录（不写 .restore，不碰线上数据）" },
      { "name": "打开与迁移", "ok": true, "detail": "建表与迁移全部通过（含历史库补列回填）" },
      { "name": "账号数据", "ok": true, "detail": "主密码哈希与加密密钥齐备" },
      { "name": "文件全量扫描", "ok": true, "detail": "12 个文件 / 3 个目录" },
      { "name": "根目录文件列表", "ok": true, "detail": "5 条根目录记录可正常读取" },
      { "name": "MFA 状态表", "ok": true, "detail": "MFA 记录可读取" }
    ],
    "file_count": 12,
    "folder_count": 3,
    "duration_ms": 24
  }
}
```

**错误:**
- `400` — `name` 含路径分隔符或 `..`
- `404` — `backup not found` / `no backups found`

**用途**: 定期演练可提前发现「备份存在但恢复后读不了」类问题（例如 `content_hash` 为 NULL 曾导致 `GET /api/files` 500——该类历史库迁移错误会在「打开与迁移」「根目录文件列表」检查项上直接失败）。

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
