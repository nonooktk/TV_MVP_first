"""アプリ設定（pydantic-settings で .env を読み込む）。

ローカル開発は backend/.env の値を使う。本番は Key Vault＋マネージドIDへ差し替える
（その場合も同じフィールド名で環境変数から供給できる形にしておく）。
"""

from __future__ import annotations

from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """環境変数／.env から読み込むアプリ設定。"""

    # DB 接続URL（同期 psycopg2 ドライバ）
    DATABASE_URL: str

    # Azure Storage（ローカルは Azurite の接続文字列）
    AZURE_STORAGE_CONNECTION_STRING: str
    MEDIA_CONTAINER: str = "media"
    QUEUE_NAME: str = "pipeline-jobs"

    # 家族側の固定 Bearer トークン（スタブ。将来 Entra に差し替え）
    DEV_FAMILY_TOKEN: str

    # Agora（A2）。両方が非空なら Real プロバイダ、どちらか欠けたら Fake を使う
    # （deps.get_agora_provider で切替。既存のデモ環境を壊さないため）。
    # AGORA_APP_ID は公開値（トークン応答にも含める）。
    # AGORA_APP_CERTIFICATE は秘密値（.env のみ。コミット・ログ出力禁止）。
    AGORA_APP_ID: str = ""
    AGORA_APP_CERTIFICATE: str = ""

    # Azure Speech STT（削減ラダー②解除）。両方が非空なら Real（STS の短命トークン発行）、
    # どちらか欠けたら Fake を使う（deps.get_speech_provider で切替。Agora と同じパターン）。
    # AZURE_SPEECH_KEY は秘密値（.env のみ。コミット・ログ出力禁止）。
    # AZURE_SPEECH_REGION は公開値（例: japaneast）。
    AZURE_SPEECH_KEY: str = ""
    AZURE_SPEECH_REGION: str = ""

    # 登録リンク生成に使うフロントエンドのベースURL
    FRONTEND_BASE_URL: str = "http://localhost:3000"

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )


@lru_cache
def get_settings() -> Settings:
    """設定のシングルトンを返す（プロセス内でキャッシュ）。"""
    return Settings()
