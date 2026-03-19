#!/usr/bin/env bash
# Deploy Flask backend to Cloud Run.
# Run once after enabling billing: bash deploy.sh
set -euo pipefail

PROJECT="patent-research-tool"
REGION="us-central1"
SERVICE="patent-api"
IMAGE="gcr.io/${PROJECT}/${SERVICE}"

echo "==> Building and pushing Docker image..."
gcloud builds submit \
  --tag "${IMAGE}" \
  --project "${PROJECT}" \
  .

echo "==> Reading service account JSON..."
SA_JSON=$(cat firebase-service-account.json | python3 -c "import sys,json; print(json.dumps(json.load(sys.stdin)))")

echo "==> Deploying to Cloud Run..."
gcloud run deploy "${SERVICE}" \
  --image "${IMAGE}" \
  --platform managed \
  --region "${REGION}" \
  --project "${PROJECT}" \
  --allow-unauthenticated \
  --memory 1Gi \
  --timeout 300 \
  --set-env-vars "FIREBASE_SERVICE_ACCOUNT_JSON=${SA_JSON}" \
  --set-env-vars "EPO_CONSUMER_KEY=$(grep EPO_CONSUMER_KEY .env | cut -d= -f2)" \
  --set-env-vars "EPO_CONSUMER_SECRET=$(grep EPO_CONSUMER_SECRET .env | cut -d= -f2)" \
  --set-env-vars "DEEPL_API_KEY=$(grep DEEPL_API_KEY .env | cut -d= -f2)" \
  --set-env-vars "FLASK_DEBUG=false"

echo ""
echo "==> Deploy complete. Service URL:"
gcloud run services describe "${SERVICE}" \
  --region "${REGION}" \
  --project "${PROJECT}" \
  --format "value(status.url)"
