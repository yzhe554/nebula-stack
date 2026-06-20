#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$REPO_ROOT/.env.local"
TERRAFORM_PLUGIN_CACHE_DIR="$REPO_ROOT/.terraform-plugin-cache"
TERRAFORM_PROVIDER_MIRROR_DIR="$REPO_ROOT/.terraform-provider-mirror"
TERRAFORM_CLI_CONFIG_FILE="$REPO_ROOT/.terraformrc.local"

mkdir -p "$TERRAFORM_PLUGIN_CACHE_DIR" "$TERRAFORM_PROVIDER_MIRROR_DIR"

if [[ -d "$TERRAFORM_PLUGIN_CACHE_DIR/registry.terraform.io" && ! -d "$TERRAFORM_PROVIDER_MIRROR_DIR/registry.terraform.io" ]]; then
  cp -R "$TERRAFORM_PLUGIN_CACHE_DIR/registry.terraform.io" "$TERRAFORM_PROVIDER_MIRROR_DIR/"
fi

cat > "$TERRAFORM_CLI_CONFIG_FILE" <<EOF_TERRAFORMRC
plugin_cache_dir = "$TERRAFORM_PLUGIN_CACHE_DIR"

provider_installation {
  filesystem_mirror {
    path    = "$TERRAFORM_PROVIDER_MIRROR_DIR"
    include = ["registry.terraform.io/hashicorp/aws"]
  }

  direct {
    exclude = ["registry.terraform.io/hashicorp/aws"]
  }
}
EOF_TERRAFORMRC

upsert_env_var() {
  local name="$1"
  local value="$2"

  if [[ -f "$ENV_FILE" ]] && grep -q "^$name=" "$ENV_FILE"; then
    tmp_file="$(mktemp)"
    sed "s|^$name=.*|$name=$value|" "$ENV_FILE" > "$tmp_file"
    mv "$tmp_file" "$ENV_FILE"
    return
  fi

  {
    if [[ -f "$ENV_FILE" && -s "$ENV_FILE" ]]; then
      echo
    fi
    echo "$name=$value"
  } >> "$ENV_FILE"
}

upsert_env_var "TF_PLUGIN_CACHE_DIR" "$TERRAFORM_PLUGIN_CACHE_DIR"
upsert_env_var "TF_CLI_CONFIG_FILE" "$TERRAFORM_CLI_CONFIG_FILE"

cat <<MSG
Local repo setup complete.

Terraform provider cache:
  $TERRAFORM_PLUGIN_CACHE_DIR

Terraform provider mirror:
  $TERRAFORM_PROVIDER_MIRROR_DIR

Environment file updated:
  $ENV_FILE

Terraform CLI config:
  $TERRAFORM_CLI_CONFIG_FILE

For this shell, run:
  export TF_PLUGIN_CACHE_DIR="$TERRAFORM_PLUGIN_CACHE_DIR"
  export TF_CLI_CONFIG_FILE="$TERRAFORM_CLI_CONFIG_FILE"

Future platform scripts load .env.local automatically.
MSG
