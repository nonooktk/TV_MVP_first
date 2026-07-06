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

    # 家族側の固定 Bearer トークン（開発用の裏口。Entra 有効時も併存させる）。
    # テスト家族限定のため、本番前に無効化する（CLAUDE.md 認証節に課題として記録）。
    DEV_FAMILY_TOKEN: str

    # Entra ID（家族側ログイン本実装）。アプリ登録の「アプリケーション（クライアント）ID」。
    # 空（アプリ登録未作成）なら Entra 検証は行わず、dev トークンのみで動作する（二段構え）。
    # 非空なら dev トークン以外の Bearer を Entra の v2.0 アクセストークンとして検証する
    # （app.core.entra.verify_entra_token）。deps.require_family で切替。
    # aud は `api://{ENTRA_CLIENT_ID}` または `{ENTRA_CLIENT_ID}` を許容する。
    ENTRA_CLIENT_ID: str = ""

    # Google アカウント認証（家族側ログインのマルチプロバイダ化）。OAuth クライアントID。
    # 空（未有効化）なら Google 検証は行わない（二段構え。Entra と対称）。
    # 非空なら iss が Google の Bearer を Google の ID トークンとして検証する
    # （app.core.google.verify_google_token）。deps.require_family で iss を見て振り分ける。
    # aud は `{GOOGLE_CLIENT_ID}` に一致することを要求する。公開値（コミット可）。
    GOOGLE_CLIENT_ID: str = ""

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
