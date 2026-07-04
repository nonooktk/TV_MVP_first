"""ワーカーのラベルプロバイダ選択ロジック（get_label_provider）のユニットテスト。

- LABEL_PROVIDER による明示指定（openai / azure / fallback・不正値・必須env欠落）
- 未指定時の自動判定の優先順（openai 優先 → azure → fallback。MVP 暫定方針）
- vision 版 generate の共通挙動（画像なし→定型／API失敗→定型／成功時のパース）

実 API キー・実 API 呼び出しは使わない（クライアント生成をモックする）。
"""

from __future__ import annotations

import sys
from datetime import datetime, timezone
from pathlib import Path

import pytest

_WORKER_ROOT = Path(__file__).resolve().parents[2] / "worker"
if str(_WORKER_ROOT) not in sys.path:
    sys.path.insert(0, str(_WORKER_ROOT))

from stages.labels import (  # noqa: E402
    AzureOpenAILabelProvider,
    FallbackLabelProvider,
    OpenAILabelProvider,
    get_label_provider,
)

_CALL_DATE = datetime(2026, 7, 4, 10, 0, tzinfo=timezone.utc)

# 選択ロジックが参照する環境変数（各テストの前提を明確にするため毎回すべて消す）。
_ENV_KEYS = [
    "LABEL_PROVIDER",
    "OPENAI_API_KEY",
    "OPENAI_MODEL",
    "AZURE_OPENAI_ENDPOINT",
    "AZURE_OPENAI_API_KEY",
    "AZURE_OPENAI_DEPLOYMENT",
    "AZURE_OPENAI_API_VERSION",
]


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch: pytest.MonkeyPatch):
    """ラベル関連の環境変数をすべて未設定にした状態から各テストを始める。"""
    for key in _ENV_KEYS:
        monkeypatch.delenv(key, raising=False)


def _set_azure_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AZURE_OPENAI_ENDPOINT", "https://example.openai.azure.com/")
    monkeypatch.setenv("AZURE_OPENAI_API_KEY", "azure-test-key")
    monkeypatch.setenv("AZURE_OPENAI_DEPLOYMENT", "gpt-4o")


# ---------------------------------------------------------------------------
# 明示指定（LABEL_PROVIDER）
# ---------------------------------------------------------------------------


class TestExplicitSelection:
    def test_openai_explicit(self, monkeypatch: pytest.MonkeyPatch):
        """LABEL_PROVIDER=openai ＋キーありで直 OpenAI 版になる。"""
        monkeypatch.setenv("LABEL_PROVIDER", "openai")
        monkeypatch.setenv("OPENAI_API_KEY", "sk-test")
        provider = get_label_provider()
        assert isinstance(provider, OpenAILabelProvider)
        # モデルは既定 gpt-4o-mini。
        assert provider._model == "gpt-4o-mini"

    def test_openai_explicit_model_override(self, monkeypatch: pytest.MonkeyPatch):
        """OPENAI_MODEL でモデルを上書きできる。"""
        monkeypatch.setenv("LABEL_PROVIDER", "openai")
        monkeypatch.setenv("OPENAI_API_KEY", "sk-test")
        monkeypatch.setenv("OPENAI_MODEL", "gpt-4o")
        provider = get_label_provider()
        assert isinstance(provider, OpenAILabelProvider)
        assert provider._model == "gpt-4o"

    def test_azure_explicit(self, monkeypatch: pytest.MonkeyPatch):
        """LABEL_PROVIDER=azure ＋設定ありで Azure 版になる。
        OPENAI_API_KEY があっても明示指定が優先される（本番切り戻し手順の要）。"""
        monkeypatch.setenv("LABEL_PROVIDER", "azure")
        monkeypatch.setenv("OPENAI_API_KEY", "sk-test")  # あっても無視される
        _set_azure_env(monkeypatch)
        assert isinstance(get_label_provider(), AzureOpenAILabelProvider)

    def test_fallback_explicit(self, monkeypatch: pytest.MonkeyPatch):
        """LABEL_PROVIDER=fallback は他の設定が揃っていても定型を使う。"""
        monkeypatch.setenv("LABEL_PROVIDER", "fallback")
        monkeypatch.setenv("OPENAI_API_KEY", "sk-test")
        _set_azure_env(monkeypatch)
        assert isinstance(get_label_provider(), FallbackLabelProvider)

    def test_openai_explicit_without_key_falls_back(
        self, monkeypatch: pytest.MonkeyPatch
    ):
        """LABEL_PROVIDER=openai でもキーが無ければ（Azure に流れず）定型になる。"""
        monkeypatch.setenv("LABEL_PROVIDER", "openai")
        _set_azure_env(monkeypatch)  # Azure が揃っていても切り替えない
        assert isinstance(get_label_provider(), FallbackLabelProvider)

    def test_azure_explicit_without_env_falls_back(
        self, monkeypatch: pytest.MonkeyPatch
    ):
        """LABEL_PROVIDER=azure でも AZURE_OPENAI_* が不足なら定型になる。"""
        monkeypatch.setenv("LABEL_PROVIDER", "azure")
        monkeypatch.setenv("OPENAI_API_KEY", "sk-test")  # openai に流れないこと
        monkeypatch.setenv("AZURE_OPENAI_ENDPOINT", "https://example.openai.azure.com/")
        # API_KEY / DEPLOYMENT が欠けている
        assert isinstance(get_label_provider(), FallbackLabelProvider)

    def test_unknown_value_falls_back(self, monkeypatch: pytest.MonkeyPatch):
        """LABEL_PROVIDER が不正値なら定型になる。"""
        monkeypatch.setenv("LABEL_PROVIDER", "gemini")
        monkeypatch.setenv("OPENAI_API_KEY", "sk-test")
        assert isinstance(get_label_provider(), FallbackLabelProvider)

    def test_case_insensitive(self, monkeypatch: pytest.MonkeyPatch):
        """明示指定は大文字小文字を区別しない。"""
        monkeypatch.setenv("LABEL_PROVIDER", "OpenAI")
        monkeypatch.setenv("OPENAI_API_KEY", "sk-test")
        assert isinstance(get_label_provider(), OpenAILabelProvider)


# ---------------------------------------------------------------------------
# 自動判定（LABEL_PROVIDER 未指定）
# ---------------------------------------------------------------------------


class TestAutoSelection:
    def test_openai_preferred_over_azure(self, monkeypatch: pytest.MonkeyPatch):
        """両方の設定が揃っていれば openai を優先する（MVP 暫定方針）。"""
        monkeypatch.setenv("OPENAI_API_KEY", "sk-test")
        _set_azure_env(monkeypatch)
        assert isinstance(get_label_provider(), OpenAILabelProvider)

    def test_openai_key_only(self, monkeypatch: pytest.MonkeyPatch):
        """OPENAI_API_KEY のみで直 OpenAI 版になる。"""
        monkeypatch.setenv("OPENAI_API_KEY", "sk-test")
        assert isinstance(get_label_provider(), OpenAILabelProvider)

    def test_azure_when_no_openai_key(self, monkeypatch: pytest.MonkeyPatch):
        """OPENAI_API_KEY が無く Azure 3変数が揃っていれば Azure 版（従来挙動）。"""
        _set_azure_env(monkeypatch)
        assert isinstance(get_label_provider(), AzureOpenAILabelProvider)

    def test_fallback_when_nothing_set(self):
        """どちらの設定も無ければ定型フォールバック。"""
        assert isinstance(get_label_provider(), FallbackLabelProvider)

    def test_azure_partial_env_falls_back(self, monkeypatch: pytest.MonkeyPatch):
        """Azure 3変数が一部欠けていれば定型フォールバック（従来挙動）。"""
        monkeypatch.setenv("AZURE_OPENAI_ENDPOINT", "https://example.openai.azure.com/")
        monkeypatch.setenv("AZURE_OPENAI_API_KEY", "azure-test-key")
        # DEPLOYMENT が欠けている
        assert isinstance(get_label_provider(), FallbackLabelProvider)

    def test_blank_openai_key_ignored(self, monkeypatch: pytest.MonkeyPatch):
        """空白だけの OPENAI_API_KEY は未設定として扱う。"""
        monkeypatch.setenv("OPENAI_API_KEY", "   ")
        _set_azure_env(monkeypatch)
        assert isinstance(get_label_provider(), AzureOpenAILabelProvider)


# ---------------------------------------------------------------------------
# vision 版 generate の共通挙動（API はモック。実キー不使用）
# ---------------------------------------------------------------------------


class _FakeChatClient:
    """chat.completions.create が固定テキストを返す（または例外を投げる）フェイク。"""

    def __init__(self, text: str | None = None, error: Exception | None = None):
        self._text = text
        self._error = error
        outer = self

        class _Completions:
            def create(self, **kwargs):
                if outer._error is not None:
                    raise outer._error
                msg = type("Msg", (), {"content": outer._text})()
                choice = type("Choice", (), {"message": msg})()
                return type("Resp", (), {"choices": [choice]})()

        self.chat = type("Chat", (), {"completions": _Completions()})()


class TestVisionGenerate:
    def _photo(self, tmp_path: Path) -> Path:
        p = tmp_path / "photo-1.jpg"
        p.write_bytes(b"\xff\xd8\xff\xe0dummy-jpeg")
        return p

    def test_no_photos_returns_fallback_without_api(self):
        """画像なしなら API を呼ばず定型を返す（クライアント生成もしない）。"""
        provider = OpenAILabelProvider(api_key="sk-test")
        labels = provider.generate(_CALL_DATE, 5, photo_paths=None)
        assert labels.title == "2026年7月4日の思い出"
        assert labels.caption == "5枚のベストショット"

    def test_success_parses_title_and_caption(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ):
        """API 成功時は応答をパースしてタイトル・キャプションを返す。"""
        provider = OpenAILabelProvider(api_key="sk-test")
        fake = _FakeChatClient(text="タイトル: 笑顔の午後\nキャプション: みんなでお茶の時間")
        monkeypatch.setattr(provider, "_create_client", lambda: (fake, "gpt-4o-mini"))
        labels = provider.generate(_CALL_DATE, 5, photo_paths=[self._photo(tmp_path)])
        assert labels.title == "笑顔の午後"
        assert labels.caption == "みんなでお茶の時間"

    def test_api_error_returns_fallback(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ):
        """API 失敗時は定型フォールバックへ退避する（Azure 版と同じ挙動）。"""
        provider = OpenAILabelProvider(api_key="sk-test")
        fake = _FakeChatClient(error=RuntimeError("rate limited"))
        monkeypatch.setattr(provider, "_create_client", lambda: (fake, "gpt-4o-mini"))
        labels = provider.generate(_CALL_DATE, 3, photo_paths=[self._photo(tmp_path)])
        assert labels.title == "2026年7月4日の思い出"
        assert labels.caption == "3枚のベストショット"

    def test_azure_provider_shares_behavior(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ):
        """リファクタ後も Azure 版が同じ共通ロジックで動く（回帰確認）。"""
        provider = AzureOpenAILabelProvider(
            endpoint="https://example.openai.azure.com/",
            api_key="azure-test-key",
            deployment="gpt-4o",
        )
        fake = _FakeChatClient(text="タイトル: 夕方の団らん\nキャプション: 元気な顔が見られた日")
        monkeypatch.setattr(provider, "_create_client", lambda: (fake, "gpt-4o"))
        labels = provider.generate(_CALL_DATE, 5, photo_paths=[self._photo(tmp_path)])
        assert labels.title == "夕方の団らん"
        assert labels.caption == "元気な顔が見られた日"
