#!/usr/bin/env bash
set -euo pipefail

REGION="${REGION:-asia-northeast1}"
SERVICE="${SERVICE:-hanamaru}"

if [[ -z "${1:-}" ]]; then
  echo "Usage: $0 <tag>"
  echo "Example: $0 sha-abc1234"
  exit 1
fi

TAG="$1"

gcloud run services update-traffic "$SERVICE" \
  --region="$REGION" \
  --to-tags="$TAG=100"

echo "Promoted $TAG to 100% traffic on $SERVICE"
