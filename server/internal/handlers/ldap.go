package handlers

import (
	"crypto/tls"
	"fmt"
	"strings"

	"firmatek/server/internal/config"
	ldap "github.com/go-ldap/ldap/v3"
)

type LDAPUserInfo struct {
	Username    string
	DisplayName string
	Email       string
}

// AuthenticateLDAP – verifies a user against AD/LDAP
// Returns the user's data from AD or an error
func AuthenticateLDAP(cfg *config.LDAPConfig, username, password string) (*LDAPUserInfo, error) {
	if password == "" {
		return nil, fmt.Errorf("empty password")
	}

	// Connect to the LDAP server
	var l *ldap.Conn
	var err error

	// TLS verification is on by default; set LDAP_TLS_SKIP_VERIFY=true only for a
	// self-signed AD certificate.
	tlsConf := &tls.Config{InsecureSkipVerify: cfg.TLSSkipVerify} //nolint:gosec // opt-in via config

	if strings.HasPrefix(cfg.URL, "ldaps://") {
		l, err = ldap.DialURL(cfg.URL, ldap.DialWithTLSConfig(tlsConf))
	} else {
		l, err = ldap.DialURL(cfg.URL)
		if err == nil {
			// Attempt STARTTLS for security. If it fails (server doesn't offer
			// it, or demands a client certificate), the connection is left in a
			// broken state, so reconnect with a fresh plain connection rather
			// than failing all authentication.
			if tlsErr := l.StartTLS(tlsConf); tlsErr != nil {
				l.Close()
				l, err = ldap.DialURL(cfg.URL)
			}
		}
	}
	if err != nil {
		return nil, fmt.Errorf("failed to connect to AD: %w", err)
	}
	defer l.Close()

	// Bind the service account (to look up the user's DN)
	if cfg.BindUser != "" {
		if err := l.Bind(cfg.BindUser, cfg.BindPassword); err != nil {
			return nil, fmt.Errorf("service account bind error: %w", err)
		}
	}

	// Find the user's DN
	filter := fmt.Sprintf(cfg.UserFilter, ldap.EscapeFilter(username))
	searchReq := ldap.NewSearchRequest(
		cfg.BaseDN,
		ldap.ScopeWholeSubtree,
		ldap.NeverDerefAliases,
		1, 30, false,
		filter,
		[]string{"dn", "displayName", "mail", "sAMAccountName"},
		nil,
	)

	sr, err := l.Search(searchReq)
	if err != nil {
		return nil, fmt.Errorf("user search error: %w", err)
	}
	if len(sr.Entries) == 0 {
		return nil, fmt.Errorf("user not found in AD")
	}

	userDN := sr.Entries[0].DN

	// Bind as the user – password verification
	if err := l.Bind(userDN, password); err != nil {
		return nil, fmt.Errorf("invalid password")
	}

	displayName := sr.Entries[0].GetAttributeValue("displayName")
	if displayName == "" {
		displayName = username
	}

	return &LDAPUserInfo{
		Username:    strings.ToLower(username),
		DisplayName: displayName,
		Email:       sr.Entries[0].GetAttributeValue("mail"),
	}, nil
}
