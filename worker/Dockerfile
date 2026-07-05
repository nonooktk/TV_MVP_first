# worker（通話後パイプライン）本番イメージ。
# ビルドコンテキストはリポジトリ直下（TV_MVP/）。
#   例: az acr build -r acrtvmvp<sfx> -f worker/Dockerfile -t tvmvp-worker:latest .
#
# worker は backend の資産（app.db.models・app.core.config 等）を再利用する。
# bootstrap.py は「worker/ の親（parents[1]）/backend」を sys.path に足すため、
# コンテナ内でも /app/worker と /app/backend を兄弟に配置する。
# FFmpeg（ffmpeg / ffprobe）が render に必須なので apt で導入する。
FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

# FFmpeg 導入（render の subprocess が PATH 上の ffmpeg/ffprobe を呼ぶ）。
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 依存だけ先に入れてキャッシュを効かせる（backend/requirements.txt を流用。
# worker はこの依存で動く。openai は labels 本実装で追加。
# Pillow はサムネイル・コラージュ生成に必須（worker/requirements.txt にも記載）。
COPY backend/requirements.txt /app/backend/requirements.txt
RUN pip install --no-cache-dir -r /app/backend/requirements.txt \
    && pip install --no-cache-dir "openai>=1.30" "Pillow>=10.0"

# backend の app 一式（モデル・設定・サービス）と worker 一式をコピー。
COPY backend/ /app/backend/
COPY worker/ /app/worker/

# BGM（Morning.mp3 等）はビルドコンテキストに含まれていれば worker/assets/bgm/ にコピー済み。
# 常駐ポーリングで起動する（KEDA でキューが空ならスケール to 0）。
CMD ["python", "/app/worker/main.py"]
