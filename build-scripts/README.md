# Budowanie instalatorów klienta

Dockerfiles budują klienta w izolowanym środowisku.
Pliki wyciągasz z kontenera przez `docker cp` po buildzie.

## Linux AppImage (działa na wszystkich dystrybucjach)

```bash
cd build-scripts

# Zbuduj obraz (jednorazowo, potem cache)
docker build -f Dockerfile.linux -t firmatek-linux ../

# Uruchom kontener (build już jest w obrazie z poprzedniego kroku)
docker create --name firmatek-build firmatek-linux echo done

# Skopiuj wynik
docker cp firmatek-build:/app/src-tauri/target/release/bundle/appimage ./output-appimage

# Posprzątaj
docker rm firmatek-build

# Instalator jest w:
# output-appimage/Firmatek_*.AppImage
```

## Linux .deb (Debian / Ubuntu)

```bash
docker build -f Dockerfile.debian -t firmatek-deb ../
docker create --name firmatek-deb-build firmatek-deb echo done
docker cp firmatek-deb-build:/app/src-tauri/target/release/bundle/deb ./output-deb
docker rm firmatek-deb-build
# output-deb/firmatek_*.deb
```

## Linux .rpm (Oracle Linux / RHEL / Fedora)

```bash
docker build -f Dockerfile.rpm -t firmatek-rpm ../
docker create --name firmatek-rpm-build firmatek-rpm echo done
docker cp firmatek-rpm-build:/app/src-tauri/target/release/bundle/rpm ./output-rpm
docker rm firmatek-rpm-build
# output-rpm/firmatek-*.rpm
```

## Windows .msi (na Windows, bez Dockera)

```powershell
cd ..\client
npm install
npm run tauri:build
# src-tauri\target\release\bundle\msi\Firmatek_*.msi
```

## Skrypt – wszystkie Linuxy naraz

```bash
#!/bin/bash
set -e
cd "$(dirname "$0")"

for target in linux debian rpm; do
  echo "=== Buduję $target ==="
  docker build -f Dockerfile.$target -t firmatek-$target ../
  docker create --name tmp-$target firmatek-$target echo done
  mkdir -p output-$target
  docker cp tmp-$target:/app/src-tauri/target/release/bundle/. output-$target/
  docker rm tmp-$target
  echo "=== $target gotowy w output-$target/ ==="
done
echo "Wszystkie gotowe!"
```
