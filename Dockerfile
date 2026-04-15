FROM python:3.11-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends gcc \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Only copy application code — secrets are injected via env vars at runtime
COPY app.py tracker.py ai_engine.py notifications.py ./

ENV PORT=8080
ENV FLASK_DEBUG=false

EXPOSE 8080

CMD ["python", "app.py"]
