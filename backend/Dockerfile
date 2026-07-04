# backend（FastAPI）本番イメージ。
# ビルドコンテキストはリポジトリ直下（TV_MVP/）。az acr build で参照する Dockerfile。
#   例: az acr build -r acrtvmvp<sfx> -f backend/Dockerfile -t tvmvp-api:latest .
FROM python:3.11-slim

# uvicorn の待受ポート（Container Apps の ingress targetPort と一致させる）。
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PORT=8000

WORKDIR /app

# 依存だけ先に入れてレイヤキャッシュを効かせる。
COPY backend/requirements.txt /app/backend/requirements.txt
RUN pip install --no-cache-dir -r /app/backend/requirements.txt

# backend 一式をコピー（.env は .gitignore 済みでビルドコンテキストに含めない）。
COPY backend/ /app/backend/

# app.* を import できるよう backend/ を作業ディレクトリにする。
WORKDIR /app/backend

EXPOSE 8000

# 環境変数 PORT を尊重して uvicorn を起動する。
CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000}"]
