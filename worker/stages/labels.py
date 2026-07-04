"""タイトル・キャプション生成（LabelProvider）。

第2段（render）でハイライト動画に付与するタイトル・キャプションを決めるための
抽象インターフェースと、その MVP 実装を提供する。

- タイトル・キャプションは動画に焼き込まない（docs/ffmpeg-commands.md §6）。
  album.title / album.caption としてDBに保存し、閲覧UIがテキスト表示する。
- MVP は定型フォールバック（FallbackLabelProvider）を使う。
- Azure OpenAI（vision）版は未実装スタブ（AzureOpenAILabelProvider）。
  環境変数 AZURE_OPENAI_ENDPOINT があれば切替の分岐だけ用意する（get_label_provider）。
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from datetime import datetime
from typing import Protocol


@dataclass(frozen=True)
class Labels:
    """生成されたタイトルとキャプション。"""

    title: str
    caption: str


class LabelProvider(Protocol):
    """タイトル・キャプションを決めるプロバイダのインターフェース。"""

    def generate(self, call_date: datetime, photo_count: int) -> Labels:
        """通話日と採用枚数からタイトル・キャプションを生成する。"""
        ...


class FallbackLabelProvider:
    """定型フォールバック実装（MVP 既定）。

    - title:   「YYYY年MM月DD日の思い出」（call の日付）
    - caption: 「{N}枚のベストショット」
    """

    def generate(self, call_date: datetime, photo_count: int) -> Labels:
        title = f"{call_date.year}年{call_date.month}月{call_date.day}日の思い出"
        caption = f"{photo_count}枚のベストショット"
        return Labels(title=title, caption=caption)


class AzureOpenAILabelProvider:
    """Azure OpenAI（vision）版。未実装スタブ。

    実装時は選択5枚の画像を vision モデルへ渡し、情景に応じたタイトル・
    キャプションを生成する。MVP では未実装のため呼ばれてもフォールバックへ委譲する。
    """

    def __init__(self, endpoint: str) -> None:
        self._endpoint = endpoint
        self._fallback = FallbackLabelProvider()

    def generate(self, call_date: datetime, photo_count: int) -> Labels:
        # TODO(A11): Azure OpenAI vision でのラベリングを実装する。
        # 未実装のうちはフォールバックの定型ラベルを返す。
        return self._fallback.generate(call_date, photo_count)


def get_label_provider() -> LabelProvider:
    """環境に応じた LabelProvider を返す。

    AZURE_OPENAI_ENDPOINT が設定されていれば Azure 版（現状はスタブ）を、
    未設定なら定型フォールバックを返す。
    """
    endpoint = os.environ.get("AZURE_OPENAI_ENDPOINT")
    if endpoint:
        return AzureOpenAILabelProvider(endpoint)
    return FallbackLabelProvider()
