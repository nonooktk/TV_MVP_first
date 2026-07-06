"""タイトル・キャプション生成（LabelProvider）。

第2段（render）でハイライト動画に付与するタイトル・キャプションを決めるための
抽象インターフェースと、その実装を提供する。

- タイトル・キャプションは動画に焼き込まない（docs/ffmpeg-commands.md §6）。
  album.title / album.caption としてDBに保存し、閲覧UIがテキスト表示する。
- 既定は定型フォールバック（FallbackLabelProvider）。
- vision 版は2実装ある。いずれも選択画像と**通話文脈**（stages/call_context.py の
  CallContext。stage2 が確定5枚の metadata から組み立てて渡す）を vision 対応モデルへ
  渡して、この通話ならではのタイトル・キャプションを日本語で生成し、API 呼び出しが
  失敗した場合は定型フォールバックへ委譲する（挙動は共通・接続先だけが異なる）。
  応答は JSON {"title","caption"} を第一とし、失敗時のみ従来形式を緩くパースする。
  - AzureOpenAILabelProvider: Azure OpenAI 版（Regional Standard。本番はこちら）
  - OpenAILabelProvider:      直 OpenAI API 版（MVP 期間中の暫定。支給キーを利用）

プロバイダの選択は get_label_provider が行う（優先順位は同関数の docstring 参照）。

Azure 版に必要な環境変数（A1 で worker に設定済み）:
- AZURE_OPENAI_ENDPOINT     例: https://oai-tvmvp-xxxx.openai.azure.com/
- AZURE_OPENAI_API_KEY      キー
- AZURE_OPENAI_DEPLOYMENT   デプロイ名（例: gpt-4o）
- AZURE_OPENAI_API_VERSION  省略時は 2024-08-01-preview

直 OpenAI 版に必要な環境変数（キーはユーザーが設定する。リポジトリには置かない）:
- OPENAI_API_KEY            支給された OpenAI API キー
- OPENAI_MODEL              省略時は gpt-4o-mini
"""

from __future__ import annotations

import base64
import json
import logging
import os
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Protocol

from stages.call_context import CallContext, build_call_context, build_prompt

logger = logging.getLogger("worker.labels")

_DEFAULT_API_VERSION = "2024-08-01-preview"
_DEFAULT_OPENAI_MODEL = "gpt-4o-mini"
# vision に渡す最大枚数（コスト・レイテンシ配慮。5枚選択のうち先頭数枚）。
_MAX_VISION_IMAGES = 3


@dataclass(frozen=True)
class Labels:
    """生成されたタイトルとキャプション。"""

    title: str
    caption: str


class LabelProvider(Protocol):
    """タイトル・キャプションを決めるプロバイダのインターフェース。"""

    def generate(
        self,
        call_date: datetime,
        photo_count: int,
        photo_paths: list[Path] | None = None,
        context: CallContext | None = None,
    ) -> Labels:
        """通話日・採用枚数（・任意で画像パス・通話文脈）からタイトル・キャプションを生成する。"""
        ...


class FallbackLabelProvider:
    """定型フォールバック実装（既定）。

    - title:   「YYYY年MM月DD日の思い出」（call の日付）
    - caption: 「{N}枚のベストショット」
    - 通話文脈（context）は使わない（定型のみ）。
    """

    def generate(
        self,
        call_date: datetime,
        photo_count: int,
        photo_paths: list[Path] | None = None,
        context: CallContext | None = None,
    ) -> Labels:
        title = f"{call_date.year}年{call_date.month}月{call_date.day}日の思い出"
        caption = f"{photo_count}枚のベストショット"
        return Labels(title=title, caption=caption)


def _encode_image(path: Path) -> str | None:
    """画像を data URL（base64）へ変換する。読めなければ None。"""
    try:
        data = path.read_bytes()
    except OSError as e:
        logger.warning("画像読み込みに失敗: %s err=%s", path, e)
        return None
    b64 = base64.b64encode(data).decode("ascii")
    return f"data:image/jpeg;base64,{b64}"


def _parse_labels_json(text: str) -> tuple[str, str] | None:
    """JSON {"title": "...", "caption": "..."} 形式をパースする。

    コードフェンス（```json ... ```）や前後の説明文が混ざっていても、
    最初の '{' から最後の '}' までを JSON として読む。
    パースできない・title が無い場合は None（呼び出し側で緩いパースへフォールバック）。
    """
    start = text.find("{")
    end = text.rfind("}")
    if start == -1 or end == -1 or end <= start:
        return None
    try:
        data = json.loads(text[start : end + 1])
    except ValueError:
        return None
    if not isinstance(data, dict):
        return None
    title = data.get("title")
    caption = data.get("caption")
    if not isinstance(title, str) or not title.strip():
        return None
    caption = caption.strip() if isinstance(caption, str) else ""
    return title.strip(), caption


def _parse_labels(text: str) -> tuple[str, str]:
    """「タイトル: ...」「キャプション: ...」形式を緩くパースする。"""
    title = ""
    caption = ""
    for line in text.splitlines():
        line = line.strip()
        for key in ("タイトル", "title", "Title"):
            if line.startswith(key):
                title = line.split(":", 1)[-1].split("：", 1)[-1].strip()
                break
        for key in ("キャプション", "caption", "Caption"):
            if line.startswith(key):
                caption = line.split(":", 1)[-1].split("：", 1)[-1].strip()
                break
    # 形式に沿わない場合は先頭行をタイトルとして使う。
    if not title:
        stripped = [ln.strip() for ln in text.splitlines() if ln.strip()]
        if stripped:
            title = stripped[0][:20]
    return title, caption


class _VisionLabelProviderBase:
    """vision チャット補完でタイトル・キャプションを生成する共通実装。

    サブクラスは `_provider_name`（ログ用）と `_create_client()`
    （openai クライアントとモデル名を返す）だけを実装する。
    画像が渡されない・API が失敗した場合は定型フォールバックへ委譲する。
    """

    _provider_name = "vision"

    def __init__(self) -> None:
        self._fallback = FallbackLabelProvider()

    def _create_client(self) -> tuple[Any, str]:
        """openai クライアントとモデル名（デプロイ名）を返す。

        openai ライブラリの import はここで遅延して行う
        （フォールバック運用時にライブラリ未導入でも動くようにするため）。
        """
        raise NotImplementedError

    def generate(
        self,
        call_date: datetime,
        photo_count: int,
        photo_paths: list[Path] | None = None,
        context: CallContext | None = None,
    ) -> Labels:
        fallback = self._fallback.generate(call_date, photo_count, photo_paths)
        if not photo_paths:
            # 画像が無ければ vision を使う意味がないので定型で返す。
            return fallback

        # 画像を data URL 化（先頭数枚）。
        image_urls: list[str] = []
        for p in photo_paths[:_MAX_VISION_IMAGES]:
            url = _encode_image(p)
            if url:
                image_urls.append(url)
        if not image_urls:
            return fallback

        try:
            client, model = self._create_client()
            # 通話文脈が渡されなければ日時のみの最小文脈を作る（共通ビルダーを常用）。
            if context is None:
                context = build_call_context(call_date, [])
            prompt = build_prompt(context)
            content: list[dict] = [{"type": "text", "text": prompt}]
            for url in image_urls:
                content.append(
                    {"type": "image_url", "image_url": {"url": url, "detail": "low"}}
                )

            resp = client.chat.completions.create(
                model=model,
                messages=[{"role": "user", "content": content}],
                max_tokens=120,
                temperature=0.7,
            )
            text = (resp.choices[0].message.content or "").strip()
            # JSON 形式を第一とし、失敗時のみ従来の緩いパースへフォールバック。
            parsed = _parse_labels_json(text)
            if parsed is None:
                parsed = _parse_labels(text)
            title, caption = parsed
            if not title:
                return fallback
            return Labels(
                title=title,
                caption=caption or fallback.caption,
            )
        except Exception as e:  # noqa: BLE001
            # 認証・課金・レート制限・パース失敗など、あらゆる失敗で定型に退避する。
            logger.warning(
                "%s ラベリングに失敗、定型へフォールバック: %s", self._provider_name, e
            )
            return fallback


class AzureOpenAILabelProvider(_VisionLabelProviderBase):
    """Azure OpenAI（vision）版。本番はこちらを使う（Regional Standard）。"""

    _provider_name = "Azure OpenAI"

    def __init__(
        self,
        endpoint: str,
        api_key: str,
        deployment: str,
        api_version: str = _DEFAULT_API_VERSION,
    ) -> None:
        super().__init__()
        self._endpoint = endpoint
        self._api_key = api_key
        self._deployment = deployment
        self._api_version = api_version

    def _create_client(self) -> tuple[Any, str]:
        from openai import AzureOpenAI

        client = AzureOpenAI(
            azure_endpoint=self._endpoint,
            api_key=self._api_key,
            api_version=self._api_version,
        )
        return client, self._deployment


class OpenAILabelProvider(_VisionLabelProviderBase):
    """直 OpenAI API（vision）版。MVP 期間中の暫定（支給キーを利用）。

    注意: 顔画像が Azure 境界外（OpenAI）へ出るため本番では使わない。
    本番前に LABEL_PROVIDER=azure へ切り替えて Azure OpenAI Regional へ戻す
    （経緯は CLAUDE.md「確定済み設計からの乖離」参照）。
    """

    _provider_name = "OpenAI"

    def __init__(self, api_key: str, model: str = _DEFAULT_OPENAI_MODEL) -> None:
        super().__init__()
        self._api_key = api_key
        self._model = model

    def _create_client(self) -> tuple[Any, str]:
        from openai import OpenAI

        client = OpenAI(api_key=self._api_key)
        return client, self._model


def _openai_provider_from_env() -> OpenAILabelProvider | None:
    """環境変数から直 OpenAI 版を構築する。キーが無ければ None。"""
    api_key = os.environ.get("OPENAI_API_KEY", "").strip()
    if not api_key:
        return None
    model = os.environ.get("OPENAI_MODEL", "").strip() or _DEFAULT_OPENAI_MODEL
    return OpenAILabelProvider(api_key=api_key, model=model)


def _azure_provider_from_env() -> AzureOpenAILabelProvider | None:
    """環境変数から Azure 版を構築する。必須3変数が欠けていれば None。"""
    endpoint = os.environ.get("AZURE_OPENAI_ENDPOINT", "").strip()
    api_key = os.environ.get("AZURE_OPENAI_API_KEY", "").strip()
    deployment = os.environ.get("AZURE_OPENAI_DEPLOYMENT", "").strip()
    api_version = (
        os.environ.get("AZURE_OPENAI_API_VERSION", "").strip() or _DEFAULT_API_VERSION
    )
    if endpoint and api_key and deployment:
        return AzureOpenAILabelProvider(endpoint, api_key, deployment, api_version)
    return None


def get_label_provider() -> LabelProvider:
    """環境に応じた LabelProvider を返す。

    優先順位:
    1. 環境変数 LABEL_PROVIDER による明示指定（openai / azure / fallback）。
       指定されたプロバイダの必須環境変数が欠けている場合・未知の値の場合は、
       警告ログを出して定型フォールバックを返す（誤設定で別プロバイダへ
       静かに切り替わることを避けるため）。
    2. LABEL_PROVIDER 未指定なら自動判定:
       a. OPENAI_API_KEY があれば直 OpenAI 版を優先（MVP 期間中の暫定方針。
          本番前に Azure へ戻す。CLAUDE.md「確定済み設計からの乖離」参照）
       b. 無ければ Azure の必須3変数（ENDPOINT / API_KEY / DEPLOYMENT）が
          揃っていれば Azure 版
       c. どちらも無ければ定型フォールバック
    """
    explicit = os.environ.get("LABEL_PROVIDER", "").strip().lower()
    if explicit:
        if explicit == "fallback":
            return FallbackLabelProvider()
        if explicit == "openai":
            provider = _openai_provider_from_env()
            if provider is None:
                logger.warning(
                    "LABEL_PROVIDER=openai が指定されたが OPENAI_API_KEY が無い。"
                    "定型フォールバックを使う"
                )
                return FallbackLabelProvider()
            return provider
        if explicit == "azure":
            azure = _azure_provider_from_env()
            if azure is None:
                logger.warning(
                    "LABEL_PROVIDER=azure が指定されたが AZURE_OPENAI_* が不足。"
                    "定型フォールバックを使う"
                )
                return FallbackLabelProvider()
            return azure
        logger.warning(
            "LABEL_PROVIDER の値が不正: %r（openai / azure / fallback のいずれか）。"
            "定型フォールバックを使う",
            explicit,
        )
        return FallbackLabelProvider()

    # 未指定: 自動判定（openai 優先は MVP 暫定方針）。
    provider = _openai_provider_from_env()
    if provider is not None:
        return provider
    azure = _azure_provider_from_env()
    if azure is not None:
        return azure
    return FallbackLabelProvider()
