// Package version 持有后端版本号。
// 仅在凭证/会话验证通过后返回给客户端（登录成功响应），匿名接口
//（health/setup/salt 等）与所有 4xx 错误响应都不携带，防止未登录指纹识别。
// 构建时可覆盖: go build -ldflags "-X lit-aoss/internal/version.Version=v1.5.3"
package version

// Version 后端版本号，与 docs/development-log.md 的版本条目保持一致。
var Version = "v1.5.3"
