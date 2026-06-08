FROM golang:1.22-alpine AS builder

WORKDIR /app

# Zależności systemu do kompilacji
RUN apk add --no-cache git ca-certificates tzdata

# Kopiuj cały kod źródłowy
COPY . .

# Wygeneruj go.sum i pobierz zależności na podstawie faktycznego kodu
RUN go mod tidy && go mod download

# Zbuduj binarny plik
RUN CGO_ENABLED=0 GOOS=linux go build -a -installsuffix cgo \
    -ldflags="-w -s" \
    -o firmatek-server ./cmd/server

# --- Finalny obraz ---
FROM alpine:3.19

RUN apk add --no-cache ca-certificates tzdata curl

WORKDIR /app

COPY --from=builder /app/firmatek-server .

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
    CMD curl -f http://localhost:8080/health || exit 1

CMD ["./firmatek-server"]
