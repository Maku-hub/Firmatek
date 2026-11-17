FROM golang:1.25-alpine AS builder

WORKDIR /src

# Dependencies first so this layer stays cached until go.mod/go.sum change
COPY go.mod go.sum ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/firmatek-server ./cmd/server

FROM alpine:3.22

RUN apk add --no-cache ca-certificates tzdata \
    && adduser -D -u 10001 appuser

WORKDIR /app
COPY --from=builder /out/firmatek-server .

USER appuser
ENV SERVER_PORT=8080
EXPOSE 8080

# busybox wget is enough for the health probe, no need to install curl
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -q -O /dev/null "http://127.0.0.1:${SERVER_PORT}/health" || exit 1

CMD ["./firmatek-server"]
