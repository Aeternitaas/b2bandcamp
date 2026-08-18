# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Stage 1: build the React app.
# The frontend is built entirely on its own: it has no knowledge of Go and
# produces plain static files. That is what keeps the two halves decoupled.
# ---------------------------------------------------------------------------
FROM node:22-alpine AS web

WORKDIR /web

# Copy manifests first so dependency installation is cached independently of
# source changes. The bracket glob makes the lockfile optional.
COPY web/package.json web/package-lock.jso[n] ./
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi

COPY web/ ./
RUN npm run build


# ---------------------------------------------------------------------------
# Stage 2: build the Go server.
# ---------------------------------------------------------------------------
FROM golang:1.23-alpine AS server

WORKDIR /src

COPY server/go.mod server/go.su[m] ./
RUN go mod download

COPY server/ ./

# Static binary: no libc dependency, so the runtime image can stay minimal.
RUN CGO_ENABLED=0 GOOS=linux go build \
      -trimpath \
      -ldflags="-s -w" \
      -o /out/b2bandcamp .


# ---------------------------------------------------------------------------
# Stage 3: runtime.
# ---------------------------------------------------------------------------
FROM alpine:3.20

# ca-certificates is required for the outbound HTTPS calls to Bandcamp.
RUN apk add --no-cache ca-certificates tzdata wget \
    && adduser -D -H -u 10001 app

WORKDIR /app

COPY --from=server /out/b2bandcamp /app/b2bandcamp
COPY --from=web /web/dist /app/web

USER app

ENV PORT=9185 \
    WEB_DIR=/app/web

EXPOSE 9185

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:9185/api/health || exit 1

ENTRYPOINT ["/app/b2bandcamp"]
