#!/usr/bin/env bash
set -Eeuo pipefail

INSTALL_DIR="${CRAVELENS_HOME:-$HOME/.cravelens}"
ENV_FILE="$INSTALL_DIR/.env"
COMPOSE_FILE="$INSTALL_DIR/docker-compose.yaml"

info() { printf '\n\033[1;36mCraveLens:\033[0m %s\n' "$*"; }
fail() { printf '\n\033[1;31mCraveLens install failed:\033[0m %s\n' "$*" >&2; exit 1; }
prompt() { local value; printf '%s' "$1" > /dev/tty; IFS= read -r value < /dev/tty; printf '%s' "$value"; }
prompt_secret() { local value; printf '%s' "$1" > /dev/tty; IFS= read -r -s value < /dev/tty; printf '\n' > /dev/tty; printf '%s' "$value"; }

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

collect_configuration() {
  local provider model api_key default_model
  while true; do
    provider="$(prompt 'Model provider (gemini/openai) [gemini]: ')"
    provider="${provider:-gemini}"
    case "$provider" in gemini|openai) break ;; *) printf 'Please enter either gemini or openai.\n' > /dev/tty ;; esac
  done
  if [ "$provider" = "gemini" ]; then default_model="gemini-flash-latest"; else default_model="gpt-5.5"; fi
  model="$(prompt "Model name [$default_model]: ")"
  model="${model:-$default_model}"
  while true; do
    api_key="$(prompt_secret 'Model API key: ')"
    [ -n "$api_key" ] && break
    printf 'The API key cannot be empty.\n' > /dev/tty
  done
  mkdir -p "$INSTALL_DIR"
  umask 077
  {
    printf 'AGENT_MODEL_PROVIDER=%s\n' "$provider"
    printf 'AGENT_MODEL_NAME=%s\n' "$model"
    printf 'AGENT_MODEL_API_KEY=%s\n' "$api_key"
  } > "$ENV_FILE"
  chmod 600 "$ENV_FILE"
}

write_compose_file() {
  cat > "$COMPOSE_FILE" <<'COMPOSE'
services:
  db:
    image: mongodb
    restart: unless-stopped
    ports:
      - "27017:27017"
    environment:
      MONGO_INITDB_ROOT_USERNAME: admin
      MONGO_INITDB_ROOT_PASSWORD: admin
  server:
    image: nishithp/cravelens-server
    restart: unless-stopped
    ports:
      - "8787:8787"
    environment:
      MONGODB_URI: mongodb://admin:admin@db:27017
      MONGODB_DATABASE: cravelens
      PORT: 8787
    env_file:
      - ./.env
    depends_on:
      - db
COMPOSE
}

main() {
  [ -r /dev/tty ] || fail "An interactive terminal is required."
  install_docker
  wait_for_docker
  collect_configuration
  write_compose_file
  info "Pulling CraveLens images and starting the services..."
  docker compose --project-directory "$INSTALL_DIR" -f "$COMPOSE_FILE" pull
  docker compose --project-directory "$INSTALL_DIR" -f "$COMPOSE_FILE" up -d
  info "CraveLens is running at http://localhost:8787"
  printf 'Configuration is stored securely in %s\n' "$ENV_FILE"
}

main "$@"
