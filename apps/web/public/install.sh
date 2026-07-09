#!/usr/bin/env bash
set -Eeuo pipefail

INSTALL_DIR="${CRAVELENS_HOME:-$HOME/.cravelens}"
ENV_FILE="$INSTALL_DIR/.env"
COMPOSE_FILE="$INSTALL_DIR/docker-compose.yaml"
MODEL_DIR="$INSTALL_DIR/models"
GEMMA_REPO="google/gemma-3n-E2B-it-litert-lm"
GEMMA_MODEL_FILE="gemma-3n-E2B-it-int4-Web.litertlm"
GEMMA_MODEL_PATH="$MODEL_DIR/$GEMMA_MODEL_FILE"
GEMMA_ACCESS_URL="https://huggingface.co/google/gemma-3n-E2B-it-litert-lm"
GEMMA_FILE_URL="$GEMMA_ACCESS_URL/blob/main/$GEMMA_MODEL_FILE"
GEMMA_HF_URI="hf://$GEMMA_REPO/$GEMMA_MODEL_FILE"
GEMMA_TERMS_URL="https://ai.google.dev/gemma/terms"
HF_BIN=""

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

find_hf_cli() {
  if command -v hf >/dev/null 2>&1; then
    HF_BIN="$(command -v hf)"
  elif [ -x "$HOME/.local/bin/hf" ]; then
    HF_BIN="$HOME/.local/bin/hf"
  elif [ -x "$HOME/.cargo/bin/hf" ]; then
    HF_BIN="$HOME/.cargo/bin/hf"
  else
    HF_BIN=""
  fi
}

install_hf_cli() {
  find_hf_cli
  if [ -n "$HF_BIN" ]; then
    info "Hugging Face CLI is already installed."
    return
  fi

  command -v curl >/dev/null 2>&1 || fail "curl is required to install the Hugging Face CLI."
  info "Installing the Hugging Face CLI."
  curl -LsSf https://hf.co/cli/install.sh | bash
  export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"

  find_hf_cli
  [ -n "$HF_BIN" ] || fail "Hugging Face CLI installation finished, but the 'hf' command was not found. Add it to PATH and run the installer again."
}

login_to_hugging_face() {
  if "$HF_BIN" auth whoami >/dev/null 2>&1; then
    info "Hugging Face CLI is already logged in."
    return
  fi

  info "Please log in to Hugging Face so CraveLens can download the gated Gemma 3n model."
  "$HF_BIN" auth login < /dev/tty
}

show_gemma_access_instructions() {
  info "Gemma 3n requires accepting Google's Gemma terms before the model can be downloaded."
  {
    printf '\nGemma terms summary:\n'
    printf '  - Use Gemma only in accordance with the Gemma Terms of Use and applicable law.\n'
    printf '  - Do not use Gemma for restricted uses covered by the Gemma prohibited-use policy.\n'
    printf '  - If you distribute Gemma or derivatives, include the required notices and terms.\n'
    printf '  - You are responsible for generated outputs and how they are used.\n'
    printf '\nFull Gemma Terms of Use:\n  %s\n' "$GEMMA_TERMS_URL"
    printf '\nRequest/accept access to the gated Hugging Face model:\n  %s\n' "$GEMMA_ACCESS_URL"
    printf '\nCraveLens will download only this model file:\n  %s\n\n' "$GEMMA_FILE_URL"
    printf 'Download command:\n  hf download %s\n\n' "$GEMMA_HF_URI"
  } > /dev/tty
  prompt "Press Enter after you have accepted the terms and model access on Hugging Face..."
  printf '\n' > /dev/tty
}

download_gemma_model() {
  if [ -s "$GEMMA_MODEL_PATH" ]; then
    info "Gemma 3n model is already downloaded."
    return
  fi

  local download_dir
  download_dir="$MODEL_DIR/.download"
  mkdir -p "$MODEL_DIR"
  rm -rf "$download_dir"
  mkdir -p "$download_dir"

  info "Downloading Gemma 3n from Hugging Face. This is a large file and may take a while."
  "$HF_BIN" download "$GEMMA_HF_URI" --local-dir "$download_dir" || fail "Unable to download Gemma 3n. Confirm that your Hugging Face account has accepted access at $GEMMA_ACCESS_URL."

  [ -s "$download_dir/$GEMMA_MODEL_FILE" ] || fail "Gemma 3n downloaded, but $GEMMA_MODEL_FILE was not found."
  mv "$download_dir/$GEMMA_MODEL_FILE" "$GEMMA_MODEL_PATH"
  chmod 644 "$GEMMA_MODEL_PATH"
  rm -rf "$download_dir"
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
      LOCAL_MODEL_DIRECTORY: /app/apps/server/models
    env_file:
      - ./.env
    volumes:
      - ./models:/app/apps/server/models:ro
    depends_on:
      - db
COMPOSE
}

main() {
  [ -r /dev/tty ] || fail "An interactive terminal is required."
  install_docker
  wait_for_docker
  install_hf_cli
  login_to_hugging_face
  show_gemma_access_instructions
  download_gemma_model
  collect_configuration
  write_compose_file
  info "Pulling CraveLens images and starting the services..."
  docker compose --project-directory "$INSTALL_DIR" -f "$COMPOSE_FILE" pull
  docker compose --project-directory "$INSTALL_DIR" -f "$COMPOSE_FILE" up -d
  info "CraveLens is running at http://localhost:8787"
  printf 'Configuration is stored securely in %s\n' "$ENV_FILE"
}

main "$@"
