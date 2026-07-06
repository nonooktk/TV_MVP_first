"""通話文脈の収集とラベリング用プロンプトの組み立て（共通プロンプトビルダー）。

第2段（render）で確定した5枚の memories と call から「通話文脈」
（通話日時・会話の言葉・感情ワード・撮影のきっかけ）を組み立て、
vision ラベリング（OpenAI／Azure OpenAI 共用）のプロンプトを生成する。

- 純粋関数群として実装し、単体でテスト可能にする。
- 文脈の欠けている行はプロンプトから省略する（stt 無し等でも成立する）。
- Fallback（定型ラベル）はこのモジュールを使わない（labels.py 参照）。
"""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

# JST（日本標準時）。通話日時の表示・時間帯判定に使う。
JST = timezone(timedelta(hours=9))

# 会話抜粋（stt_text 連結）の最大文字数。
STT_EXCERPT_MAX_CHARS = 200

# trigger_reason → 日本語表現（撮影のきっかけの内訳表示）。
_TRIGGER_LABELS = {
    "rms": "声の盛り上がり",
    "stt": "感情ワード",
    "face": "表情",
}


@dataclass(frozen=True)
class CallContext:
    """ラベリングに渡す通話文脈。

    Attributes:
        datetime_label: 「YYYY年M月D日・朝/昼/夕方/夜」形式の通話日時。
        stt_excerpt: 会話から聞き取れた言葉（重複除去・最大200字）。無ければ None。
        stt_labels: 検知した感情ワード（uniq・出現順）。無ければ空タプル。
        trigger_summary: 撮影のきっかけの内訳（例: 声の盛り上がり3回・感情ワード1回）。
            trigger_reason が1件も無ければ None。
    """

    datetime_label: str
    stt_excerpt: str | None = None
    stt_labels: tuple[str, ...] = ()
    trigger_summary: str | None = None


def time_of_day_label(dt: datetime) -> str:
    """JST の時刻から時間帯ラベルを返す（5-11朝・11-16昼・16-19夕方・19-5夜）。

    naive な datetime は UTC とみなして JST へ変換する
    （DB は timestamptz なので通常は aware で渡ってくる）。
    """
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    hour = dt.astimezone(JST).hour
    if 5 <= hour < 11:
        return "朝"
    if 11 <= hour < 16:
        return "昼"
    if 16 <= hour < 19:
        return "夕方"
    return "夜"


def format_call_datetime(dt: datetime) -> str:
    """「YYYY年M月D日・朝/昼/夕方/夜」形式へ整形する（日付も JST 基準）。"""
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    jst = dt.astimezone(JST)
    return f"{jst.year}年{jst.month}月{jst.day}日・{time_of_day_label(dt)}"


def _collect_stt_excerpt(metas: list[dict]) -> str | None:
    """metadata.stt_text を出現順に重複除去して連結する（最大200字）。"""
    seen: set[str] = set()
    parts: list[str] = []
    for meta in metas:
        text = meta.get("stt_text")
        if not isinstance(text, str):
            continue
        text = text.strip()
        if not text or text in seen:
            continue
        seen.add(text)
        parts.append(text)
    if not parts:
        return None
    joined = "／".join(parts)
    return joined[:STT_EXCERPT_MAX_CHARS]


def _collect_stt_labels(metas: list[dict]) -> tuple[str, ...]:
    """metadata.stt_labels を出現順に uniq して返す。"""
    seen: set[str] = set()
    labels: list[str] = []
    for meta in metas:
        raw = meta.get("stt_labels")
        if not isinstance(raw, (list, tuple)):
            continue
        for label in raw:
            if not isinstance(label, str):
                continue
            label = label.strip()
            if not label or label in seen:
                continue
            seen.add(label)
            labels.append(label)
    return tuple(labels)


def _collect_trigger_summary(metas: list[dict]) -> str | None:
    """metadata.trigger_reason の内訳を「声の盛り上がり3回・感情ワード1回」形式にする。

    未知の reason はそのままの文字列で数える。1件も無ければ None。
    表示順は rms → stt → face → その他（出現順）。
    """
    counts: Counter[str] = Counter()
    order: list[str] = []
    for meta in metas:
        reason = meta.get("trigger_reason")
        if not isinstance(reason, str) or not reason.strip():
            continue
        reason = reason.strip()
        if reason not in counts:
            order.append(reason)
        counts[reason] += 1
    if not counts:
        return None

    known = [r for r in ("rms", "stt", "face") if r in counts]
    others = [r for r in order if r not in _TRIGGER_LABELS]
    parts = [
        f"{_TRIGGER_LABELS.get(r, r)}{counts[r]}回" for r in known + others
    ]
    return "・".join(parts)


def build_call_context(call_date: datetime, metas: list[dict]) -> CallContext:
    """通話日時と確定写真の metadata 群から CallContext を組み立てる。

    Args:
        call_date: 通話日時（call.started_at。無ければ created_at）。
        metas: 確定5枚の memories の metadata（dict）のリスト。
    """
    return CallContext(
        datetime_label=format_call_datetime(call_date),
        stt_excerpt=_collect_stt_excerpt(metas),
        stt_labels=_collect_stt_labels(metas),
        trigger_summary=_collect_trigger_summary(metas),
    )


def build_prompt(context: CallContext) -> str:
    """CallContext からラベリング用プロンプトを組み立てる。

    データの無い文脈行（会話の言葉・感情ワード・撮影のきっかけ）は省略する。
    """
    context_lines = [f"- 通話日時: {context.datetime_label}"]
    if context.stt_excerpt:
        context_lines.append(
            f"- 会話から聞き取れた言葉（抜粋）: {context.stt_excerpt}"
        )
    if context.stt_labels:
        context_lines.append(
            f"- 検知した感情ワード: {'、'.join(context.stt_labels)}"
        )
    if context.trigger_summary:
        context_lines.append(f"- 撮影のきっかけ: {context.trigger_summary}")

    return (
        "あなたは家族のフォトアルバムの編集者です。"
        "高齢の親と家族のビデオ通話から選ばれた写真と、通話の文脈をもとに、"
        "日本語で温かみのあるタイトルとキャプションを作ってください。\n"
        "\n"
        "文脈:\n"
        + "\n".join(context_lines)
        + "\n"
        "\n"
        "要件:\n"
        "- タイトルは15字以内。「家族の◯◯」のような汎用表現を避け、"
        "この通話ならではの言葉・場面を反映する\n"
        "- キャプションは30字以内。写真から分かる表情・場面も反映する\n"
        "- 固有名詞は推測しない\n"
        '- JSON {"title": "...", "caption": "..."} のみを返す'
    )
