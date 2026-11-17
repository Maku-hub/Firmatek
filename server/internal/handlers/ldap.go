package handlers

import (
	"crypto/tls"
	"errors"
	"fmt"
	"log"
	"net/url"
	"strings"
	"time"

	"firmatek/server/internal/config"

	ldap "github.com/go-ldap/ldap/v3"
)

// errInvalidCredentials means the directory answered and rejected the login.
// Any other error from AuthenticateLDAP is an infrastructure problem.
var errInvalidCredentials = errors.New("invalid credentials")

const ldapTimeout = 10 * time.Second

type LDAPUserInfo struct {
	Username    string
	DisplayName string
	Email       string
}

// AuthenticateLDAP checks the credentials against AD/LDAP and returns the
// user's directory attributes.
func AuthenticateLDAP(cfg *config.LDAPConfig, username, password string) (*LDAPUserInfo, error) {
	if username == "" || password == "" {
		// An empty password would turn the user bind into an unauthenticated
		// bind, which most directories accept.
		return nil, errInvalidCredentials
	}

	l, err := dialLDAP(cfg)
	if err != nil {
		return nil, fmt.Errorf("connect to directory: %w", err)
	}
	defer l.Close()
	l.SetTimeout(ldapTimeout)

	if cfg.BindUser != "" {
		if err := l.Bind(cfg.BindUser, cfg.BindPassword); err != nil {
			return nil, fmt.Errorf("service account bind: %w", err)
		}
	}

	searchReq := ldap.NewSearchRequest(
		cfg.BaseDN,
		ldap.ScopeWholeSubtree,
		ldap.NeverDerefAliases,
		2, int(ldapTimeout.Seconds()), false,
		fmt.Sprintf(cfg.UserFilter, ldap.EscapeFilter(username)),
		[]string{"displayName", "mail", "sAMAccountName"},
		nil,
	)
	sr, err := l.Search(searchReq)
	if err != nil && !ldap.IsErrorWithCode(err, ldap.LDAPResultSizeLimitExceeded) {
		return nil, fmt.Errorf("user search: %w", err)
	}
	if sr == nil || len(sr.Entries) != 1 {
		// Zero matches is a wrong login; more than one means the filter is
		// ambiguous and we must not guess which account to bind as.
		return nil, errInvalidCredentials
	}
	entry := sr.Entries[0]

	if err := l.Bind(entry.DN, password); err != nil {
		if ldap.IsErrorWithCode(err, ldap.LDAPResultInvalidCredentials) {
			return nil, errInvalidCredentials
		}
		return nil, fmt.Errorf("user bind: %w", err)
	}

	displayName := strings.TrimSpace(entry.GetAttributeValue("displayName"))
	if displayName == "" {
		displayName = username
	}
	return &LDAPUserInfo{
		Username:    strings.ToLower(username),
		DisplayName: displayName,
		Email:       entry.GetAttributeValue("mail"),
	}, nil
}

func dialLDAP(cfg *config.LDAPConfig) (*ldap.Conn, error) {
	tlsConf := &tls.Config{InsecureSkipVerify: cfg.TLSSkipVerify} //nolint:gosec // opt-in for self-signed AD certificates
	if host := ldapHost(cfg.URL); host != "" {
		tlsConf.ServerName = host
	}

	if strings.HasPrefix(cfg.URL, "ldaps://") {
		return ldap.DialURL(cfg.URL, ldap.DialWithTLSConfig(tlsConf))
	}

	l, err := ldap.DialURL(cfg.URL)
	if err != nil {
		return nil, err
	}
	// Prefer STARTTLS. A failed handshake leaves the connection unusable, so
	// fall back to a fresh plain connection for servers that do not offer it.
	if err := l.StartTLS(tlsConf); err != nil {
		l.Close()
		log.Printf("ldap: STARTTLS failed, continuing without encryption: %v", err)
		return ldap.DialURL(cfg.URL)
	}
	return l, nil
}

func ldapHost(raw string) string {
	u, err := url.Parse(raw)
	if err != nil {
		return ""
	}
	return u.Hostname()
}
