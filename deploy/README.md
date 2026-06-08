# Firmatek – Wdrożenie serwera

Ten folder zawiera **tylko to co potrzebne do uruchomienia serwera**.
Kod źródłowy klienta nie jest tu potrzebny.

## Struktura na serwerze

```
/opt/firmatek/
├── server/              ← skopiuj z repozytorium
├── docker-compose.yml   ← ten plik
├── .env                 ← uzupełniony .env.example
├── coturn/
│   └── turnserver.conf
└── data/                ← tworzy się automatycznie
    ├── postgres/
    └── redis/
```

## Kroki wdrożenia

```bash
# 1. Na maszynie deweloperskiej – spakuj serwer
cd /ścieżka/do/firmatek_clean
tar -czf firmatek-server.tar.gz server/ deploy/ docker-compose.yml .env.example coturn/

# 2. Wgraj na serwer
scp firmatek-server.tar.gz user@serwer:/opt/firmatek/

# 3. Na serwerze
ssh user@serwer
cd /opt/firmatek
tar -xzf firmatek-server.tar.gz
cp .env.example .env
nano .env    # uzupełnij hasła i konfigurację LDAP

# 4. Uruchom
docker compose up -d

# 5. Sprawdź
docker compose ps
docker compose logs -f server
```

## Backup danych

Dane są w folderze `./data/` – wystarczy go zbackupować:
```bash
tar -czf backup-$(date +%Y%m%d).tar.gz data/
```

## Aktualizacja serwera

```bash
docker compose down
# wgraj nowy kod server/
docker compose up -d --build
```
