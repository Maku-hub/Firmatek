# Building client installers

These Dockerfiles build the client in an isolated environment.
You extract the files from the container with `docker cp` after the build.

## Linux AppImage (works on all distributions)

```bash
cd build-scripts

# Build the image (once, then cached)
docker build -f Dockerfile.linux -t firmatek-linux ../

# Create a container (the build already lives in the image from the previous step)
docker create --name firmatek-build firmatek-linux echo done

# Copy out the result
docker cp firmatek-build:/app/src-tauri/target/release/bundle/appimage ./output-appimage

# Clean up
docker rm firmatek-build

# The installer is in:
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

## Windows .msi (on Windows, without Docker)

```powershell
cd ..\client
npm install
npm run tauri:build
# src-tauri\target\release\bundle\msi\Firmatek_*.msi
```

## Script – all Linux targets at once

```bash
#!/bin/bash
set -e
cd "$(dirname "$0")"

for target in linux debian rpm; do
  echo "=== Building $target ==="
  docker build -f Dockerfile.$target -t firmatek-$target ../
  docker create --name tmp-$target firmatek-$target echo done
  mkdir -p output-$target
  docker cp tmp-$target:/app/src-tauri/target/release/bundle/. output-$target/
  docker rm tmp-$target
  echo "=== $target ready in output-$target/ ==="
done
echo "All done!"
```
