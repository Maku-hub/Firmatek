# Firmatek – Server deployment

Deployment instructions for running just the server. The canonical
`docker-compose.yml`, `.env.example` and `coturn/turnserver.conf` live at the
**repository root** (single source of truth) — this folder holds only these
instructions, not copies of those files.

## Layout on the server

```
/opt/firmatek/
├── server/              ← copy from the repository
├── docker-compose.yml   ← this file
├── .env                 ← a filled-in .env.example
├── coturn/
│   └── turnserver.conf
└── data/                ← created automatically
    ├── postgres/
    └── redis/
```

## Deployment steps

```bash
# 1. On the development machine – package the server (root files only)
cd /path/to/firmatek
tar -czf firmatek-server.tar.gz server/ docker-compose.yml .env.example coturn/

# 2. Upload to the server
scp firmatek-server.tar.gz user@server:/opt/firmatek/

# 3. On the server
ssh user@server
cd /opt/firmatek
tar -xzf firmatek-server.tar.gz
cp .env.example .env
nano .env    # fill in the passwords and LDAP configuration

# 4. Start
docker compose up -d

# 5. Verify
docker compose ps
docker compose logs -f server
```

## Data backup

All data lives in the `./data/` folder – just back it up:
```bash
tar -czf backup-$(date +%Y%m%d).tar.gz data/
```

## Updating the server

```bash
docker compose down
# upload the new server/ code
docker compose up -d --build
```
