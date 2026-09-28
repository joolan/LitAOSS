package api

import (
	"bytes"
	"encoding/json"
	"log"
	"net/http"
	"time"
)

// maybeAlertLoginFailure 同一 IP 在锁定窗口内失败次数达到阈值时向配置的 webhook
// 异步 POST 告警；冷却期内同一 IP 不重复发送。webhook_url 为空 = 功能关闭。
// 任何错误只记日志，不影响登录流程。
func (h *Handler) maybeAlertLoginFailure(ip string) {
	ac := h.config.Alert
	if ac.WebhookURL == "" {
		return
	}
	threshold := ac.FailThreshold
	if threshold <= 0 {
		threshold = 5
	}
	cooldown := time.Duration(ac.CooldownSeconds) * time.Second
	if ac.CooldownSeconds <= 0 {
		cooldown = 10 * time.Minute
	}

	window := time.Duration(h.config.Auth.LockoutDuration) * time.Second
	if window <= 0 {
		window = 15 * time.Minute
	}
	count, err := h.db.GetFailedLoginCountByIP(ip, window)
	if err != nil || count < threshold {
		return
	}

	h.alertMu.Lock()
	if last, seen := h.alertLast[ip]; seen && time.Since(last) < cooldown {
		h.alertMu.Unlock()
		return
	}
	h.alertLast[ip] = time.Now()
	h.alertMu.Unlock()

	payload := map[string]any{
		"event":     "login_failed",
		"app":       "LitAOSS",
		"ip":        ip,
		"count":     count,
		"threshold": threshold,
		"time":      time.Now().Format(time.RFC3339),
	}
	go postWebhook(ac.WebhookURL, payload)
}

// postWebhook 5 秒超时的 JSON POST；状态码 >=300 视为失败并记日志
func postWebhook(url string, payload map[string]any) {
	body, err := json.Marshal(payload)
	if err != nil {
		log.Printf("alert webhook marshal: %v", err)
		return
	}
	client := &http.Client{Timeout: 5 * time.Second}
	resp, err := client.Post(url, "application/json", bytes.NewReader(body))
	if err != nil {
		log.Printf("alert webhook post failed: %v", err)
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		log.Printf("alert webhook returned status %d", resp.StatusCode)
	}
}
