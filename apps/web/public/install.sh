#!/usr/bin/env bash
set -Eeuo pipefail

INSTALL_DIR="${CRAVELENS_HOME:-$HOME/.cravelens}"
ENV_FILE="$INSTALL_DIR/.env"
COMPOSE_FILE="$INSTALL_DIR/docker-compose.yaml"
MODEL_DIR="$INSTALL_DIR/models"

info() { printf '\n\033[1;36mCraveLens:\033[0m %s\n' "$*"; }
fail() { printf '\n\033[1;31mCraveLens install failed:\033[0m %s\n' "$*" >&2; exit 1; }
prompt() { local value; printf '%s' "$1" > /dev/tty; IFS= read -r value < /dev/tty; printf '%s' "$value"; }
prompt_secret() { local value; printf '%s' "$1" > /dev/tty; IFS= read -r -s value < /dev/tty; printf '\n' > /dev/tty; printf '%s' "$value"; }

show_banner() {
  cat <<'BANNER'

[0;37;40m▄▀▀▀▄                         ▀█▀                   [0m
[0;37;40m█     ▀█▄▀▄ ▀▀▀▄  █   █ ▄▀▀▀▄  █    ▄▀▀▀▄ █▄▀▀▄ ▄▀▀▀[0m
[0;37;40m█   ▄  █  ▀ ▄▀▀█  ▀▄ ▄▀ █▀▀▀▀  █  ▄ █▀▀▀▀ █   █  ▀▀▄[0m
[0;37;40m ▀▀▀  ▀▀▀    ▀▀ ▀   ▀    ▀▀▀  ▀▀▀▀▀  ▀▀▀  ▀   ▀ ▀▀▀ [0m

BANNER
}

install_docker() {
  if command -v docker >/dev/null 2>&1; then
    info "Docker is already installed."
    return
  fi
  info "Docker was not found; installing it now."
  case "$(uname -s)" in
    Darwin)
      command -v brew >/dev/null 2>&1 || fail "Homebrew is required to install Docker Desktop on macOS. Install it from https://brew.sh and run this command again."
      brew install --cask docker
      open -a Docker
      ;;
    Linux)
      command -v curl >/dev/null 2>&1 || fail "curl is required to install Docker."
      curl -fsSL https://get.docker.com | sh
      if command -v systemctl >/dev/null 2>&1; then sudo systemctl enable --now docker; fi
      ;;
    *) fail "Automatic Docker installation is supported on macOS and Linux." ;;
  esac
}

wait_for_docker() {
  local attempts=0
  info "Waiting for the Docker engine to become ready..."
  until docker info >/dev/null 2>&1; do
    attempts=$((attempts + 1))
    [ "$attempts" -lt 60 ] || fail "Docker is installed, but its engine is not running. Start Docker and run the installer again."
    sleep 2
  done
}

prepare_model_directory() {
  mkdir -p "$MODEL_DIR"
  info "Skipping server-side Gemma downloads. LiteRT orchestration models and Gemma 3n VLM download directly into the extension's browser cache when selected."
}

collect_configuration() {
  local provider model api_key default_model redis_password encryption_key signing_key configure_hosted
  configure_hosted="$(prompt 'Configure an optional hosted fallback now? (y/N): ')"
  provider=""; model=""; api_key=""
  if [[ "$configure_hosted" =~ ^[Yy]$ ]]; then
    while true; do
      provider="$(prompt 'Hosted provider (gemini/openai) [gemini]: ')"; provider="${provider:-gemini}"
      case "$provider" in gemini|openai) break ;; *) printf 'Please enter either gemini or openai.\n' > /dev/tty ;; esac
    done
    if [ "$provider" = "gemini" ]; then default_model="gemini-2.5-flash"; else default_model="gpt-4o-mini"; fi
    model="$(prompt "Model name [$default_model]: ")"; model="${model:-$default_model}"
    while [ -z "$api_key" ]; do api_key="$(prompt_secret 'Model API key: ')"; done
  fi
  command -v openssl >/dev/null 2>&1 || fail "openssl is required to generate local security keys."
  redis_password="$(openssl rand -hex 32)"
  encryption_key="$(openssl rand -hex 32)"
  signing_key="$(openssl rand -base64 48 | tr -d '\n')"
  mkdir -p "$INSTALL_DIR"
  umask 077
  {
    printf 'REDIS_PASSWORD=%s\n' "$redis_password"
    printf 'CREDENTIAL_ENCRYPTION_KEY=%s\n' "$encryption_key"
    printf 'DEVICE_SESSION_SIGNING_KEY=%s\n' "$signing_key"
    printf 'OLLAMA_BASE_URL=http://localhost:11434\n'
    [ -n "$provider" ] && printf 'AGENT_MODEL_PROVIDER=%s\nAGENT_MODEL_NAME=%s\nAGENT_MODEL_API_KEY=%s\n' "$provider" "$model" "$api_key"
  } > "$ENV_FILE"
  chmod 600 "$ENV_FILE"
}

write_compose_file() {
  cat > "$COMPOSE_FILE" <<'COMPOSE'
services:
  db:
    image: mongo
    restart: unless-stopped
    ports:
      - "27017:27017"
    environment:
      MONGO_INITDB_ROOT_USERNAME: admin
      MONGO_INITDB_ROOT_PASSWORD: admin
  redis:
    image: redis:8.8.1-alpine
    restart: unless-stopped
    command: ["redis-server", "--appendonly", "yes", "--requirepass", "${REDIS_PASSWORD}"]
    environment:
      REDIS_PASSWORD: ${REDIS_PASSWORD}
    volumes:
      - redis_data:/data
    healthcheck:
      test: ["CMD-SHELL", "REDISCLI_AUTH=\"$$REDIS_PASSWORD\" redis-cli ping | grep PONG"]
      interval: 5s
      timeout: 3s
      retries: 20
  server:
    image: nishithp/cravelens-server
    restart: unless-stopped
    ports:
      - "8787:8787"
    environment:
      MONGODB_URI: mongodb://admin:admin@db:27017
      MONGODB_DATABASE: cravelens
      PORT: 8787
      LOCAL_MODEL_DIRECTORY: /app/apps/server/models
      REDIS_URL: redis://:${REDIS_PASSWORD}@redis:6379/0
    env_file:
      - ./.env
    volumes:
      - ./models:/app/apps/server/models:ro
    depends_on:
      db:
        condition: service_started
      redis:
        condition: service_healthy
volumes:
  redis_data:
COMPOSE
}

main() {
  [ -r /dev/tty ] || fail "An interactive terminal is required."
  show_banner
  install_docker
  wait_for_docker
  prepare_model_directory
  collect_configuration
  write_compose_file
  docker compose --project-directory "$INSTALL_DIR" -f "$COMPOSE_FILE" config >/dev/null || fail "Generated Docker Compose configuration is invalid."
  info "Pulling CraveLens images and starting the services..."
  docker compose --project-directory "$INSTALL_DIR" -f "$COMPOSE_FILE" pull
  docker compose --project-directory "$INSTALL_DIR" -f "$COMPOSE_FILE" up -d
  docker compose --project-directory "$INSTALL_DIR" -f "$COMPOSE_FILE" exec -T redis sh -c 'REDISCLI_AUTH="$REDIS_PASSWORD" redis-cli ping' | grep -q PONG || fail "Redis did not become healthy."
  info "CraveLens is running at http://localhost:8787"
  printf 'Configuration is stored securely in %s\n' "$ENV_FILE"
}

main "$@"
