FROM golang:1.25-alpine AS builder

WORKDIR /app

# System dependencies for compilation
RUN apk add --no-cache git ca-certificates tzdata

# Download dependencies first (cached layer) using the committed go.mod/go.sum
COPY go.mod go.sum ./
RUN go mod download

# Copy the rest of the source tree
COPY . .

# Build the binary
RUN CGO_ENABLED=0 GOOS=linux go build -a -installsuffix cgo \
    -ldflags="-w -s" \
    -o firmatek-server ./cmd/server

# --- Final image ---
FROM alpine:3.19

RUN apk add --no-cache ca-certificates tzdata curl

# Run as a non-root user
RUN adduser -D -u 10001 appuser

WORKDIR /app

COPY --from=builder /app/firmatek-server .

USER appuser

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
    CMD curl -f http://localhost:8080/health || exit 1

CMD ["./firmatek-server"]
