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

// AuthenticateLDAP – weryfikuje użytkownika przez AD/LDAP
// Zwraca dane użytkownika z AD lub błąd
func AuthenticateLDAP(cfg *config.LDAPConfig, username, password string) (*LDAPUserInfo, error) {
	if password == "" {
		return nil, fmt.Errorf("puste hasło")
	}

	// Połącz z serwerem LDAP
	var l *ldap.Conn
	var err error

	if strings.HasPrefix(cfg.URL, "ldaps://") {
		l, err = ldap.DialURL(cfg.URL, ldap.DialWithTLSConfig(&tls.Config{
			InsecureSkipVerify: false, // Produkcja: false; jeśli self-signed cert: true
		}))
	} else {
		l, err = ldap.DialURL(cfg.URL)
		if err == nil {
			// Spróbuj STARTTLS dla bezpieczeństwa
			_ = l.StartTLS(&tls.Config{InsecureSkipVerify: true})
		}
	}
	if err != nil {
		return nil, fmt.Errorf("błąd połączenia z AD: %w", err)
	}
	defer l.Close()

	// Bind service account (do wyszukiwania DN użytkownika)
	if cfg.BindUser != "" {
		if err := l.Bind(cfg.BindUser, cfg.BindPassword); err != nil {
			return nil, fmt.Errorf("błąd bind service account: %w", err)
		}
	}

	// Znajdź DN użytkownika
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
		return nil, fmt.Errorf("błąd wyszukiwania użytkownika: %w", err)
	}
	if len(sr.Entries) == 0 {
		return nil, fmt.Errorf("użytkownik nie znaleziony w AD")
	}

	userDN := sr.Entries[0].DN

	// Bind jako użytkownik – weryfikacja hasła
	if err := l.Bind(userDN, password); err != nil {
		return nil, fmt.Errorf("nieprawidłowe hasło")
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
