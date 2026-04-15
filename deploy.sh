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
ANTHROPIC_KEY=$(gcloud secrets versions access latest --secret=ANTHROPIC_API_KEY --project="${PROJECT}")
SA_JSON=$(gcloud secrets versions access latest --secret=FIREBASE_SERVICE_ACCOUNT_JSON --project="${PROJECT}")
# Email / notifications — optional, deploy works without them (email features dormant).
MX_SMTP_HOST=$(gcloud secrets versions access latest --secret=MX_SMTP_HOST --project="${PROJECT}" 2>/dev/null || echo "")
MX_SMTP_PORT=$(gcloud secrets versions access latest --secret=MX_SMTP_PORT --project="${PROJECT}" 2>/dev/null || echo "")
MX_SMTP_USER=$(gcloud secrets versions access latest --secret=MX_SMTP_USER --project="${PROJECT}" 2>/dev/null || echo "")
MX_SMTP_PASS=$(gcloud secrets versions access latest --secret=MX_SMTP_PASS --project="${PROJECT}" 2>/dev/null || echo "")
MX_SMTP_FROM=$(gcloud secrets versions access latest --secret=MX_SMTP_FROM --project="${PROJECT}" 2>/dev/null || echo "")
NOTIF_ADMIN_KEY=$(gcloud secrets versions access latest --secret=NOTIFICATIONS_ADMIN_KEY --project="${PROJECT}" 2>/dev/null || echo "")

echo "==> Building and pushing Docker image to ${IMAGE}..."
gcloud builds submit \
  --tag "${IMAGE}" \
  --project "${PROJECT}" \
  .

# Build env-vars YAML — avoids gcloud choking on JSON special chars
ENV_YAML="/tmp/cloudrun-env.yaml"
python3 -c "
import json, sys

sa_json_raw = sys.argv[1]
# Compact JSON, no whitespace
compact = json.dumps(json.loads(sa_json_raw), separators=(',', ':'))
# YAML single-quote escaping: double any internal single quotes
def yq(v):
    return \"'\" + v.replace(\"'\", \"''\") + \"'\"

lines = [
    'FIREBASE_SERVICE_ACCOUNT_JSON: ' + yq(compact),
    'EPO_CONSUMER_KEY: ' + yq(sys.argv[2]),
    'EPO_CONSUMER_SECRET: ' + yq(sys.argv[3]),
    'USPTO_ODP_API_KEY: ' + yq(sys.argv[4]),
    'ANTHROPIC_API_KEY: ' + yq(sys.argv[5]),
    'MX_SMTP_HOST: ' + yq(sys.argv[7]),
    'MX_SMTP_PORT: ' + yq(sys.argv[8] or '465'),
    'MX_SMTP_USER: ' + yq(sys.argv[9]),
    'MX_SMTP_PASS: ' + yq(sys.argv[10]),
    'MX_SMTP_FROM: ' + yq(sys.argv[11]),
    'NOTIFICATIONS_ADMIN_KEY: ' + yq(sys.argv[12]),
    'FLASK_DEBUG: \"false\"',
    'PYTHONUNBUFFERED: \"1\"',
]
with open(sys.argv[6], 'w') as f:
    f.write('\n'.join(lines) + '\n')
print('Wrote', sys.argv[6])
" "${SA_JSON}" "${EPO_KEY}" "${EPO_SECRET}" "${USPTO_KEY}" "${ANTHROPIC_KEY}" "${ENV_YAML}" \
  "${MX_SMTP_HOST}" "${MX_SMTP_PORT}" "${MX_SMTP_USER}" "${MX_SMTP_PASS}" "${MX_SMTP_FROM}" "${NOTIF_ADMIN_KEY}"

echo "==> Deploying ${SERVICE} to Cloud Run (${REGION})..."
gcloud run deploy "${SERVICE}" \
  --image "${IMAGE}" \
  --platform managed \
  --region "${REGION}" \
  --project "${PROJECT}" \
  --allow-unauthenticated \
  --memory 1Gi \
  --timeout 300 \
  --env-vars-file "${ENV_YAML}"

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
