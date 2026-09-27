# LitAOSS 部署指南

---

## 1. 环境要求

### 1.1 开发环境

| 组件 | 版本要求 |
|------|----------|
| Go | 1.22+ |
| Node.js | 18+ |
| npm | 9+ |

### 1.2 生产环境

| 组件 | 说明 |
|------|------|
| 服务器 | Linux / Windows / macOS |
| Go | 编译后为静态二进制，无需运行时 |
| Node.js | 仅用于编译前端，运行时不需要 |
| HTTPS | 必须 (Web Crypto API 要求) |

---

## 2. 本地开发

### 2.1 启动后端

```bash
cd backend

# 安装依赖
go mod tidy

# 配置 OSS (编辑 config.json)
# 填入你的阿里云 AccessKey、SecretKey、Bucket 等

# 启动
go run cmd/server/main.go
```

后端默认运行在 `http://localhost:8780`（`config.json` → `server.port`，代码默认值 `internal/config` 亦为 8780；8080 常与 Java/Docker 开发服务冲突）。

### 2.2 启动前端

```bash
cd frontend

# 安装依赖
npm install

# 启动开发服务器
npm run dev
```

前端默认运行在 `http://localhost:3000`，自动代理 API 请求到后端。

---

## 3. 生产部署

### 3.1 编译后端

```bash
cd backend

# Linux/macOS
GOOS=linux GOARCH=amd64 go build -o lit-aoss-server ./cmd/server

# Windows
GOOS=windows GOARCH=amd64 go build -o lit-aoss-server.exe ./cmd/server
```

版本号默认取 `backend/internal/version/version.go`（如 `v1.5.3`），构建时可注入自定义值：

```bash
go build -ldflags "-X lit-aoss/internal/version.Version=v1.5.3" -o lit-aoss-server ./cmd/server
```

### 3.2 编译前端

```bash
cd frontend

# 安装依赖
npm install

# 编译
npm run build
```

编译产物在 `frontend/dist/` 目录。

### 3.3 部署架构

```
┌─────────────────────────────────────┐
│              Nginx                   │
│                                      │
│  /  ──────────────▶  前端静态文件    │
│  /api/* ──────────▶  Go 后端        │
│                                      │
└─────────────────────────────────────┘
         │
         ▼
┌─────────────────────┐
│   Go Backend        │
│   (lit-aoss-server)│
│                     │
│   Port: 8780        │
└─────────────────────┘
         │
         ▼
┌─────────────────────┐
│   阿里云 OSS        │
│   (加密文件存储)     │
└─────────────────────┘
```

### 3.4 Nginx 配置

```nginx
server {
    listen 80;
    server_name your-domain.com;
    return 301 https://$server_name$request_uri;
}

server {
    listen 443 ssl http2;
    server_name your-domain.com;

    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    root /var/www/lit-aoss/frontend/dist;

    # 安全头（注意：location 内出现任一 add_header 都会覆盖本层，因此下面各静态
    # location 内重复了 nosniff）
    add_header X-Content-Type-Options nosniff;
    add_header X-Frame-Options DENY;
    add_header X-XSS-Protection "1; mode=block";
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;

    # 前端静态文件（SPA fallback）
    location / {
        try_files $uri $uri/ /index.html;
    }

    # PWA：service worker 与 manifest 必须每次回源，否则新版本 sw.js 不会生效
    location = /sw.js {
        add_header Cache-Control "no-cache";
        add_header X-Content-Type-Options nosniff;
    }

    location = /manifest.webmanifest {
        types { application/manifest+json webmanifest; }
        add_header Cache-Control "no-cache";
        add_header X-Content-Type-Options nosniff;
    }

    # 构建产物文件名带内容哈希，可长缓存
    location ^~ /assets/ {
        add_header Cache-Control "public, max-age=31536000, immutable";
        add_header X-Content-Type-Options nosniff;
    }

    # API 代理
    location /api/ {
        proxy_pass http://127.0.0.1:8780;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # 文件上传大小限制
        client_max_body_size 100M;
    }
}
```

> **可信代理**: 如上例 nginx 与后端同机（`127.0.0.1`），默认 `server.trusted_proxies`（`127.0.0.1/32`、`::1/128`）即覆盖，`X-Forwarded-For` 中的客户端真实 IP 会被采信用于登录审计；若 nginx 部署在**其它机器**，必须把该代理 IP/CIDR 加入 `config.json` 的 `server.trusted_proxies`，否则后端只认 TCP 对端地址（即代理机 IP）。

### 3.5 systemd 服务 (Linux)

创建 `/etc/systemd/system/lit-aoss.service`:

```ini
[Unit]
Description=LitAOSS Encrypted Storage Server
After=network.target

[Service]
Type=simple
User=www-data
WorkingDirectory=/opt/lit-aoss/backend
ExecStart=/opt/lit-aoss/backend/lit-aoss-server
Restart=always
RestartSec=5
Environment=GIN_MODE=release
Environment=LITAOSS_PASSPHRASE=your-passphrase

[Install]
WantedBy=multi-user.target
```

启动服务:

```bash
sudo systemctl daemon-reload
sudo systemctl enable lit-aoss
sudo systemctl start lit-aoss
sudo systemctl status lit-aoss
```

### 3.6 Windows 服务

使用 NSSM 注册为 Windows 服务:

```cmd
nssm install LitAOSS C:\lit-aoss\backend\lit-aoss-server.exe
nssm set LitAOSS AppDirectory C:\lit-aoss\backend
nssm set LitAOSS DisplayName "LitAOSS Encrypted Storage"
nssm set LitAOSS Start SERVICE_AUTO_START
nssm start LitAOSS
```

---

## 4. 阿里云 OSS 配置

### 4.1 创建 Bucket

1. 登录阿里云控制台
2. 进入 OSS 管理
3. 创建 Bucket
   - Bucket 名称: 全局唯一
   - 区域: 选择离你最近的区域
   - 访问权限: 私有

### 4.2 获取 AccessKey

1. 登录阿里云控制台
2. 点击右上角头像 → AccessKey 管理
3. 创建 AccessKey (建议使用子用户 AccessKey)
4. 保存 AccessKey ID 和 AccessKey Secret

### 4.3 配置权限

建议创建 RAM 子用户，仅授予 OSS 权限:

```json
{
  "Version": "1",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "oss:GetObject",
        "oss:PutObject"
      ],
      "Resource": "acs:oss:*:*:your-bucket-name/*"
    }
  ]
}
```

> **不要授予 `oss:DeleteObject`** — 系统所有删除均为软删除: 对象保留在 OSS 上，由 `deleted_objects` 台账登记（文件名密文、原因、时间），代码中不存在任何 `DeleteObject` 调用（编译期保证）。ACL 类操作 (`GetObjectAcl`/`PutObjectAcl`) 也未被使用。
>
> **对象清理**: 撤销 DeleteObject 后系统内无法物理删除对象，存储只增不减；需在 OSS 控制台按台账 (`GET /api/deleted-objects` 或查库) 手动删除，或临时恢复权限。**不可用 OSS 生命周期规则代替**——它无法区分存活对象与软删对象，会误删在用文件。
>
> **备份上传**: 数据库加密备份副本由服务端直传，走 `oss:PutObject` 写入 `db-backups/` 前缀，恢复时用 `oss:GetObject` 下载——上述权限已覆盖，无需额外授权。

### 4.4 跨域配置

如果前后端不同域，需配置 CORS:

```xml
<CORSConfiguration>
  <CORSRule>
    <AllowedOrigin>https://your-domain.com</AllowedOrigin>
    <AllowedMethod>GET</AllowedMethod>
    <AllowedMethod>PUT</AllowedMethod>
    <AllowedMethod>POST</AllowedMethod>
    <AllowedHeader>*</AllowedHeader>
    <MaxAgeSeconds>3600</MaxAgeSeconds>
  </CORSRule>
</CORSConfiguration>
```

> 浏览器只向 OSS 发 PUT (上传) / GET (下载)，从不发 DELETE（删除在后端，且已全部移除），故 CORS 无需 DELETE 方法。

---

## 5. 配置文件

### 5.1 配置文件

完整模板见仓库中的 `backend/config.example.json`，复制后修改：

```bash
cp backend/config.example.json backend/config.json   # Windows: copy
```

**配置说明:**

| 字段 | 说明 |
|------|------|
| `server.allowed_origin` | 允许访问的前端域名，留空则仅允许 localhost |
| `oss.encrypted_sk` | 加密后的 SecretKey，留空则使用明文 `secret_key` |
| `backup.*` | 自动备份、文件变更触发、OSS 加密上传各开关 |

### 5.2 加密 SecretKey

1. 启动服务
2. 通过前端设置页面加密 SecretKey
3. 将加密值填入 `encrypted_sk` 字段
4. 将 `secret_key` 字段设为空字符串
5. 配置加密口令 (见 5.3)
6. 重启服务

### 5.3 配置加密口令

SecretKey 加密和数据库加密共用一个口令，通过以下方式配置：

```bash
# 方式1: 环境变量 (推荐)
set LITAOSS_PASSPHRASE=your-passphrase

# 方式2: 文件 (在 backend 目录创建 passphrase.txt)
echo your-passphrase > passphrase.txt
```

---

## 6. 监控与维护

### 6.1 日志

后端日志输出到 stdout，可配合 systemd 或 Docker 收集。

### 6.2 数据库备份

**方式一: 内置备份（推荐）** — 设置 → 备份:

- 手动备份 / 每日定时备份 / 文件操作触发备份
- 可选「同时备份到 OSS」（AES-256-GCM 加密副本，`db-backups/` 前缀，需在 config.json 配置加密口令）
- 恢复走 设置页（本地或 OSS），启用 MFA 时需 TOTP 验证，恢复后重启服务端

**方式二: 手动命令行:**

```bash
# 备份
cp ./data/lit-aoss.db ./data/lit-aoss.db.bak

# 或使用 sqlite3
sqlite3 ./data/lit-aoss.db ".backup ./data/lit-aoss.db.bak"
```

### 6.3 OSS 数据管理

- 定期检查 OSS 用量（`files/` 文件对象 + `deleted_objects` 软删对象 + `db-backups/` 加密备份均为只增不减）
- **慎用生命周期规则**: 规则按前缀/时间一刀切，会误删存活对象；清理应按 `deleted_objects` 表 / `data/backups/oss-ledger.json` 台账手动执行（见 security.md §12.8）
- 启用 OSS 访问日志

### 6.4 更新部署

```bash
# 编译新版本
go build -o lit-aoss-server ./cmd/server

# 替换二进制
sudo systemctl stop lit-aoss
cp lit-aoss-server /opt/lit-aoss/backend/
sudo systemctl start lit-aoss
```

---

## 7. 故障排查

### 7.1 常见问题

| 问题 | 可能原因 | 解决方案 |
|------|----------|----------|
| 上传失败 | OSS 未配置 | 检查 config.json 中的 AK/SK |
| 预览失败 | 非 HTTPS | 配置 HTTPS 或使用 localhost |
| 预览提示"文件太大" | 文件超过 200MB | 预期限制（PREVIEW_MAX_SIZE），请改用下载 |
| 操作菜单没有"预览"项 | 类型不在预览支持列表（如 .db） | 预期行为，该类型只提供下载/历史/重命名/删除 |
| 登录失败 | 密码错误 | 确认主密码正确 |
| 启动失败 | 端口占用 | 修改 config.json 中的端口 |
| 数据库错误 | 路径权限不足 | 检查 data 目录权限 |
| 数据库解密失败 | 口令错误 | 检查 LITAOSS_PASSPHRASE 或 passphrase.txt |
| SecretKey 解密失败 | 口令错误 | 检查 LITAOSS_PASSPHRASE 或 passphrase.txt |
| 首次设置提示「密码错误」（Network 中无任何 POST 请求） | 访问的是 HTTP 非安全上下文，浏览器禁用 `crypto.subtle`，前端密钥派生在发请求前就抛错 | 启用 HTTPS（§3.4）；可在浏览器控制台执行 `typeof crypto.subtle` 确认（应为 `"function"`） |
| 恢复备份后数据未变化 | 恢复为暂存机制，尚未应用 | 重启服务端（启动时应用 `data/lit-aoss.db.restore`） |

### 7.2 调试模式

设置环境变量开启调试日志:

```bash
export GIN_MODE=debug
./lit-aoss-server
```
