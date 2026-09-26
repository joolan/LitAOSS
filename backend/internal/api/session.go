package api

import (
	"crypto/rand"
	"encoding/hex"
	"sync"
	"time"
)

type Session struct {
	Token              string
	CreatedAt          time.Time
	PendingMFA         bool
	DeleteMFAVerified  bool
}

type SessionStore struct {
	mu       sync.RWMutex
	sessions map[string]*Session
}

func NewSessionStore() *SessionStore {
	return &SessionStore{
		sessions: make(map[string]*Session),
	}
}

func (s *SessionStore) Create() string {
	s.mu.Lock()
	defer s.mu.Unlock()

	b := make([]byte, 32)
	rand.Read(b)
	token := hex.EncodeToString(b)

	s.sessions[token] = &Session{
		Token:     token,
		CreatedAt: time.Now(),
	}
	return token
}

func (s *SessionStore) CreatePendingMFA() string {
	s.mu.Lock()
	defer s.mu.Unlock()

	b := make([]byte, 32)
	rand.Read(b)
	token := hex.EncodeToString(b)

	s.sessions[token] = &Session{
		Token:      token,
		CreatedAt:  time.Now(),
		PendingMFA: true,
	}
	return token
}

func (s *SessionStore) Validate(token string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()

	session, exists := s.sessions[token]
	if !exists {
		return false
	}

	if time.Since(session.CreatedAt) > 24*time.Hour {
		delete(s.sessions, token)
		return false
	}

	return true
}

func (s *SessionStore) IsPendingMFA(token string) bool {
	s.mu.RLock()
	defer s.mu.RUnlock()

	session, exists := s.sessions[token]
	if !exists {
		return false
	}
	return session.PendingMFA
}

func (s *SessionStore) CompleteMFA(token string) {
	s.mu.Lock()
	defer s.mu.Unlock()

	session, exists := s.sessions[token]
	if exists {
		session.PendingMFA = false
	}
}

func (s *SessionStore) IsDeleteMFAVerified(token string) bool {
	s.mu.RLock()
	defer s.mu.RUnlock()

	session, exists := s.sessions[token]
	if !exists {
		return false
	}
	return session.DeleteMFAVerified
}

func (s *SessionStore) MarkDeleteMFAVerified(token string) {
	s.mu.Lock()
	defer s.mu.Unlock()

	session, exists := s.sessions[token]
	if exists {
		session.DeleteMFAVerified = true
	}
}

func (s *SessionStore) Delete(token string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.sessions, token)
}

// DeleteAll 注销所有会话 (改密码后使用)
func (s *SessionStore) DeleteAll() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.sessions = make(map[string]*Session)
}

// DeleteAllExcept 注销除 keep 外的所有会话 (启用 MFA 后踢掉其它会话)
func (s *SessionStore) DeleteAllExcept(keep string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for token := range s.sessions {
		if token != keep {
			delete(s.sessions, token)
		}
	}
}
