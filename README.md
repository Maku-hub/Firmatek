# Firmatek – Komunikator Firmowy

Desktopowy komunikator dla firm z czatem, kodem, screenshotami i P2P transferem plików.

## Funkcje

- Kanały grupowe i wiadomości bezpośrednie (DM)
- Wyszukiwanie wiadomości (Ctrl+F) – full-text search po wszystkich kanałach użytkownika
- Syntax highlighting kodu (15+ języków, Shiki)
- Transfer plików P2P przez WebRTC (bez obciążania serwera)
- Obrazki inline (< 200KB) przez WebSocket
- Integracja z Active Directory / LDAP
- Endpoint CI/CD (`POST /api/notify`) do powiadomień z pipeline'ów
- Skalowanie UI (75–200%) – CSS zoom z fallbackiem na transform
- Dźwięk powiadomienia przy nowej wiadomości (Web Audio API)
- Jedna instancja + minimalizacja do zasobnika systemowego (tray)
- Wskaźnik pisania (typing indicator)

---

## Szybki start

```bash
# Serwer
cp .env.example .env && nano .env
docker compose up -d

# Klient (dev)
cd client && npm install && npm run tauri:dev

# Klient (produkcja)
cd client && npm install && npm run tauri:build
```

---

## Porty i firewall

### Serwer – porty które MUSZĄ być otwarte

| Port | Protokół | Kierunek | Opis |
|------|----------|----------|------|
| 8080 | TCP | przychodzący | Główny port API + WebSocket klientów |
| 443  | TCP | przychodzący | HTTPS przez nginx (gdy używasz SSL) |
| 80   | TCP | przychodzący | HTTP → redirect na 443 (gdy używasz SSL) |

Polecenie na serwerze z `firewalld` (Oracle Linux / RHEL):
```bash
firewall-cmd --permanent --add-port=8080/tcp
firewall-cmd --permanent --add-service=http
firewall-cmd --permanent --add-service=https
firewall-cmd --reload
```

Na serwerze z `ufw` (Ubuntu / Debian):
```bash
ufw allow 8080/tcp
ufw allow 80/tcp
ufw allow 443/tcp
```

### Porty wewnętrzne (nie wystawiać na zewnątrz!)

Domyślnie są już bindowane tylko na `127.0.0.1` w docker-compose:

| Port | Usługa |
|------|--------|
| 5432 | PostgreSQL |
| 6379 | Redis |
| 9000 | MinIO API (opcjonalny – profil `storage`) |
| 9001 | MinIO Console (opcjonalny – profil `storage`) |

> **MinIO jest opcjonalny.** Domyślnie `docker compose up -d` uruchamia tylko PostgreSQL, Redis i serwer Go.
> Jeśli potrzebujesz bufora offline (MinIO): `docker compose --profile storage up -d`

### Klient – porty wychodzące

Klient inicjuje połączenia wychodzące, nie wymaga otwierania portów przychodzących po stronie klienta.

| Port | Protokół | Opis |
|------|----------|------|
| 8080 lub 443 | TCP | Połączenie z serwerem Firmatek |
| Efemeryczne UDP | UDP | WebRTC P2P (automatycznie przez NAT) |

---

## Nginx jako reverse proxy z HTTPS

### Wymagania

```bash
# Ubuntu/Debian
apt install nginx certbot python3-certbot-nginx

# Oracle Linux / RHEL
dnf install nginx certbot python3-certbot-nginx
```

### Krok 1 – konfiguracja nginx

Utwórz plik `/etc/nginx/sites-available/firmatek` (Debian/Ubuntu)
lub `/etc/nginx/conf.d/firmatek.conf` (RHEL/Oracle):

```nginx
# Redirect HTTP → HTTPS
server {
    listen 80;
    server_name firmatek.firma.local;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name firmatek.firma.local;

    # Certyfikaty SSL (Let's Encrypt lub własne)
    ssl_certificate     /etc/letsencrypt/live/firmatek.firma.local/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/firmatek.firma.local/privkey.pem;

    # Bezpieczne ustawienia SSL
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;
    ssl_session_cache shared:SSL:10m;
    ssl_session_timeout 10m;

    # Proxy do Go serwera
    location / {
        proxy_pass         http://127.0.0.1:8080;
        proxy_http_version 1.1;

        # Wymagane dla WebSocket
        proxy_set_header Upgrade    $http_upgrade;
        proxy_set_header Connection "upgrade";

        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # Długi timeout dla WebSocket (podtrzymuje połączenie)
        proxy_read_timeout  3600s;
        proxy_send_timeout  3600s;

        # Rozmiar uploadu plików
        client_max_body_size 100M;
    }
}
```

### Krok 2 – aktywuj i certyfikat

```bash
# Debian/Ubuntu
ln -s /etc/nginx/sites-available/firmatek /etc/nginx/sites-enabled/

# Sprawdź konfigurację
nginx -t

# Let's Encrypt (publiczna domena)
certbot --nginx -d firmatek.firma.local

# Lub certyfikat własny (self-signed dla sieci firmowej)
openssl req -x509 -nodes -days 3650 -newkey rsa:2048 \
  -keyout /etc/ssl/private/firmatek.key \
  -out /etc/ssl/certs/firmatek.crt \
  -subj "/CN=firmatek.firma.local/O=Firma/C=PL"

# Uruchom nginx
systemctl enable --now nginx
```

### Krok 3 – zaktualizuj adres w kliencie

W aplikacji w polu "Adres serwera" wpisz:
```
https://firmatek.firma.local
```

---

## CI/CD – wysyłanie powiadomień

Firmatek ma dedykowany endpoint do integracji z pipeline'ami.
Nie wymaga logowania – używa osobnego tokenu `NOTIFY_TOKEN` z `.env`.

### Konfiguracja

W `.env` ustaw:
```
NOTIFY_TOKEN=twoj_tajny_token_cicd
```

### Użycie

#### curl
```bash
curl -X POST https://firmatek.firma.local/api/notify \
  -H "Content-Type: application/json" \
  -H "X-Notify-Token: twoj_tajny_token_cicd" \
  -d '{
    "channel": "ogólny",
    "title": "Deploy zakończony",
    "message": "Aplikacja wdrożona na produkcję: v1.2.3",
    "level": "success",
    "footer": "Pipeline #142 | main | 2m 34s"
  }'
```

#### Python
```python
import requests

FIRMATEK_URL = "https://firmatek.firma.local"
NOTIFY_TOKEN = "twoj_tajny_token_cicd"

def notify(channel: str, message: str, title: str = "", level: str = "info", footer: str = ""):
    resp = requests.post(
        f"{FIRMATEK_URL}/api/notify",
        headers={"X-Notify-Token": NOTIFY_TOKEN},
        json={"channel": channel, "message": message, "title": title, "level": level, "footer": footer},
        timeout=10,
    )
    resp.raise_for_status()
    return resp.json()

# Przykład użycia w pipeline
notify(
    channel="cicd",
    title="Deploy zakończony",
    message="Środowisko: produkcja\nWersja: v1.2.3\nCommit: abc1234",
    level="success",
    footer=f"Pipeline #{pipeline_id} | {branch}"
)
```

#### GitLab CI (.gitlab-ci.yml)
```yaml
notify_success:
  stage: notify
  image: curlimages/curl:latest
  script:
    - |
      curl -s -X POST "$FIRMATEK_URL/api/notify" \
        -H "Content-Type: application/json" \
        -H "X-Notify-Token: $FIRMATEK_TOKEN" \
        -d "{
          \"channel\": \"cicd\",
          \"title\": \"Deploy $CI_PROJECT_NAME\",
          \"message\": \"Branch: $CI_COMMIT_REF_NAME\\nCommit: $CI_COMMIT_SHORT_SHA\\n$CI_COMMIT_MESSAGE\",
          \"level\": \"success\",
          \"footer\": \"Pipeline #$CI_PIPELINE_ID\"
        }"
  when: on_success
```

#### GitHub Actions
```yaml
- name: Notify Firmatek
  run: |
    curl -s -X POST "${{ secrets.FIRMATEK_URL }}/api/notify" \
      -H "Content-Type: application/json" \
      -H "X-Notify-Token: ${{ secrets.FIRMATEK_TOKEN }}" \
      -d '{
        "channel": "cicd",
        "title": "Build ${{ github.repository }}",
        "message": "Branch: ${{ github.ref_name }}\nCommit: ${{ github.sha }}",
        "level": "success",
        "footer": "Run #${{ github.run_number }}"
      }'
```

Poziomy (`level`): `info` | `success` | `warning` | `error`

---

## Active Directory / LDAP

W `.env`:
```
LDAP_ENABLED=true
LDAP_URL=ldap://dc.firma.local:389
LDAP_DOMAIN=firma.local
LDAP_BASE_DN=DC=firma,DC=local
LDAP_BIND_USER=svc_firmatek@firma.local
LDAP_BIND_PASSWORD=haslo
LDAP_USER_FILTER=(sAMAccountName=%s)
ENABLE_REGISTRATION=false
```

Gdy `ENABLE_REGISTRATION=false` – ekran logowania nie pokazuje zakładki "Rejestracja".

---

## API – wyszukiwanie wiadomości

```
GET /api/messages/search?q=tekst&limit=50
Authorization: Bearer <JWT>
```

Wyszukuje wiadomości we wszystkich kanałach użytkownika. Parametry:
- `q` (wymagany) – fraza do wyszukania (ILIKE + full-text search)
- `limit` (opcjonalny, domyślnie 50, max 200) – liczba wyników

Zwraca tablicę obiektów Message z dodatkowym `channel_name` i `is_direct`.

---

## Budowanie instalatorów

```bash
# Windows (.msi) – na Windows
cd client && npm install && npm run tauri:build

# Linux AppImage (wszystkie dystrybucje) – przez Docker
cd build-scripts
docker build -f Dockerfile.linux -t firmatek-linux ../
docker run --rm -v "$(pwd)/output:/output" firmatek-linux

# Debian .deb
docker build -f Dockerfile.debian -t firmatek-deb ../
docker run --rm -v "$(pwd)/output:/output" firmatek-deb

# Oracle Linux / RHEL .rpm
docker build -f Dockerfile.rpm -t firmatek-rpm ../
docker run --rm -v "$(pwd)/output:/output" firmatek-rpm
```

---

## Backup

Dane są w `./data/` – wystarczy jeden folder:
```bash
tar -czf backup-$(date +%Y%m%d).tar.gz data/
```

