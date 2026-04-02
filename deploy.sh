#!/usr/bin/env bash
# Deploy PatentQ backend to Cloud Run under the patent-research-tool project.
# All secrets are stored in Secret Manager (patent-research-tool project).
set -euo pipefail

PROJECT="patent-research-tool"
REGION="us-central1"
SERVICE="patent-api"
IMAGE="gcr.io/${PROJECT}/${SERVICE}"

echo "==> Fetching secrets from Secret Manager..."
EPO_KEY=$(gcloud secrets versions access latest --secret=EPO_CONSUMER_KEY --project="${PROJECT}")
EPO_SECRET=$(gcloud secrets versions access latest --secret=EPO_CONSUMER_SECRET --project="${PROJECT}")
USPTO_KEY=$(gcloud secrets versions access latest --secret=USPTO_ODP_API_KEY --project="${PROJECT}")
SA_JSON=$(gcloud secrets versions access latest --secret=FIREBASE_SERVICE_ACCOUNT_JSON --project="${PROJECT}")

echo "==> Building and pushing Docker image to ${IMAGE}..."
gcloud builds submit \
  --tag "${IMAGE}" \
  --project "${PROJECT}" \
  .

echo "==> Deploying ${SERVICE} to Cloud Run (${REGION})..."
gcloud run deploy "${SERVICE}" \
  --image "${IMAGE}" \
  --platform managed \
  --region "${REGION}" \
  --project "${PROJECT}" \
  --allow-unauthenticated \
  --memory 1Gi \
  --timeout 300 \
  --set-env-vars "FIREBASE_SERVICE_ACCOUNT_JSON=${SA_JSON}" \
  --set-env-vars "EPO_CONSUMER_KEY=${EPO_KEY}" \
  --set-env-vars "EPO_CONSUMER_SECRET=${EPO_SECRET}" \
  --set-env-vars "USPTO_ODP_API_KEY=${USPTO_KEY}" \
  --set-env-vars "FLASK_DEBUG=false"

# Get the new service URL and set PATENT_DOC_PROXY_BASE
SERVICE_URL=$(gcloud run services describe "${SERVICE}" \
  --region "${REGION}" \
  --project "${PROJECT}" \
  --format "value(status.url)")

echo "==> Updating PATENT_DOC_PROXY_BASE to ${SERVICE_URL}..."
gcloud run services update "${SERVICE}" \
  --region "${REGION}" \
  --project "${PROJECT}" \
  --update-env-vars "PATENT_DOC_PROXY_BASE=${SERVICE_URL}"

echo ""
echo "==> Deployment complete!"
echo "    Service URL: ${SERVICE_URL}"
echo "    Project:     ${PROJECT}"
