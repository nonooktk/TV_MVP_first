"""通話文脈ビルダー（worker/stages/call_context.py）のユニットテスト。

- 時間帯判定（JST 変換・境界値 5/11/16/19 時）
- 通話日時ラベルの整形
- stt_text の重複除去・連結・200字切り詰め
- stt_labels の uniq（出現順保持）
- trigger_reason の内訳集計（rms/stt/face の日本語化・未知値・欠落）
- build_prompt の行省略（文脈あり/なし）と固定文言
- タイトルの詩的文体（2026-07-28・S4）: 歌人ロール・文体指示・例示の存在と、
  例示そのものが制約（15字以内・現代仮名遣い）を満たすこと
- trigger_source（声トリガーの両側化・2026-07-10 追加）による has_family_trigger の判定と
  build_prompt への軽い反映（「家族側の反応」行）
"""

from __future__ import annotations

import sys
from datetime import datetime, timezone
from pathlib import Path

import pytest

_WORKER_ROOT = Path(__file__).resolve().parents[2] / "worker"
if str(_WORKER_ROOT) not in sys.path:
    sys.path.insert(0, str(_WORKER_ROOT))

from stages.call_context import (  # noqa: E402
    JST,
    STT_EXCERPT_MAX_CHARS,
    TITLE_STYLE_EXAMPLES,
    CallContext,
    build_call_context,
    build_prompt,
    format_call_datetime,
    time_of_day_label,
)

# 旧仮名遣い（歴史的仮名遣い）で典型的に現れる字。プロンプトの例示に混ざっていないことを検証する。
_OLD_KANA_CHARS = ("ゐ", "ヰ", "ゑ", "ヱ", "ゝ", "ゞ")


def _jst(hour: int, minute: int = 0) -> datetime:
    """JST の 2026-07-04 hour:minute を返す。"""
    return datetime(2026, 7, 4, hour, minute, tzinfo=JST)


# ---------------------------------------------------------------------------
# 時間帯判定・日時ラベル
# ---------------------------------------------------------------------------


class TestTimeOfDay:
    @pytest.mark.parametrize(
        ("hour", "expected"),
        [
            (5, "朝"),  # 境界: 5時ちょうどは朝
            (10, "朝"),
            (11, "昼"),  # 境界: 11時ちょうどは昼
            (15, "昼"),
            (16, "夕方"),  # 境界: 16時ちょうどは夕方
            (18, "夕方"),
            (19, "夜"),  # 境界: 19時ちょうどは夜
            (23, "夜"),
            (0, "夜"),
            (4, "夜"),  # 境界: 5時前は夜
        ],
    )
    def test_boundaries_jst(self, hour: int, expected: str):
        assert time_of_day_label(_jst(hour)) == expected

    def test_utc_converted_to_jst(self):
        """UTC 22:00 = JST 翌7:00 → 朝（JST 変換が効いている）。"""
        dt = datetime(2026, 7, 3, 22, 0, tzinfo=timezone.utc)
        assert time_of_day_label(dt) == "朝"

    def test_naive_treated_as_utc(self):
        """naive は UTC とみなす（naive 0:00 = JST 9:00 → 朝）。"""
        assert time_of_day_label(datetime(2026, 7, 4, 0, 0)) == "朝"

    def test_format_call_datetime_uses_jst_date(self):
        """日付も JST 基準（UTC 7/3 22:00 → 7月4日・朝）。"""
        dt = datetime(2026, 7, 3, 22, 0, tzinfo=timezone.utc)
        assert format_call_datetime(dt) == "2026年7月4日・朝"


# ---------------------------------------------------------------------------
# 文脈収集（build_call_context）
# ---------------------------------------------------------------------------


class TestBuildCallContext:
    def test_empty_metas_yields_datetime_only(self):
        ctx = build_call_context(_jst(14), [])
        assert ctx.datetime_label == "2026年7月4日・昼"
        assert ctx.stt_excerpt is None
        assert ctx.stt_labels == ()
        assert ctx.trigger_summary is None

    def test_stt_text_dedup_and_join(self):
        """stt_text は出現順に重複除去して連結する。"""
        metas = [
            {"stt_text": "かわいいね"},
            {"stt_text": "かわいいね"},  # 重複（連写で共有）
            {"stt_text": "また来てね 元気でね"},
            {"stt_text": "  "},  # 空白のみは無視
            {},  # 無いものは無視
        ]
        ctx = build_call_context(_jst(9), metas)
        assert ctx.stt_excerpt == "かわいいね／また来てね 元気でね"

    def test_stt_text_truncated_to_200(self):
        """連結結果は最大200字に切り詰める。"""
        metas = [{"stt_text": "あ" * 150}, {"stt_text": "い" * 150}]
        ctx = build_call_context(_jst(9), metas)
        assert ctx.stt_excerpt is not None
        assert len(ctx.stt_excerpt) == STT_EXCERPT_MAX_CHARS
        assert ctx.stt_excerpt.startswith("あ" * 150 + "／")

    def test_stt_labels_uniq_preserves_order(self):
        metas = [
            {"stt_labels": ["かわいい", "うれしい"]},
            {"stt_labels": ["うれしい", "たのしい"]},
        ]
        ctx = build_call_context(_jst(9), metas)
        assert ctx.stt_labels == ("かわいい", "うれしい", "たのしい")

    def test_trigger_summary_counts_and_labels(self):
        """rms→声の盛り上がり・stt→感情ワードの内訳（表示順は rms→stt→face）。"""
        metas = [
            {"trigger_reason": "stt"},
            {"trigger_reason": "rms"},
            {"trigger_reason": "rms"},
            {"trigger_reason": "rms"},
        ]
        ctx = build_call_context(_jst(9), metas)
        assert ctx.trigger_summary == "声の盛り上がり3回・感情ワード1回"

    def test_trigger_summary_unknown_reason_kept_raw(self):
        metas = [{"trigger_reason": "manual"}, {"trigger_reason": "face"}]
        ctx = build_call_context(_jst(9), metas)
        assert ctx.trigger_summary == "表情1回・manual1回"

    def test_trigger_summary_includes_centroid_label(self):
        """centroid（スペクトル重心トリガー・改良2）→ 声色の変化。表示順は rms→stt→face→centroid。"""
        metas = [
            {"trigger_reason": "centroid"},
            {"trigger_reason": "rms"},
            {"trigger_reason": "centroid"},
        ]
        ctx = build_call_context(_jst(9), metas)
        assert ctx.trigger_summary == "声の盛り上がり1回・声色の変化2回"

    def test_trigger_summary_none_when_absent(self):
        ctx = build_call_context(_jst(9), [{}, {"trigger_reason": ""}])
        assert ctx.trigger_summary is None

    # --- 声トリガーの両側化（trigger_source・2026-07-10 追加）--------------------

    def test_has_family_trigger_true_when_any_photo_is_family(self):
        """1枚でも trigger_source == "family" があれば True。"""
        metas = [
            {"trigger_reason": "rms", "trigger_source": "elder"},
            {"trigger_reason": "centroid", "trigger_source": "family"},
        ]
        ctx = build_call_context(_jst(9), metas)
        assert ctx.has_family_trigger is True

    def test_has_family_trigger_false_when_all_elder(self):
        metas = [
            {"trigger_reason": "rms", "trigger_source": "elder"},
            {"trigger_reason": "rms", "trigger_source": "elder"},
        ]
        ctx = build_call_context(_jst(9), metas)
        assert ctx.has_family_trigger is False

    def test_has_family_trigger_false_when_absent(self):
        """trigger_source 未設定（過去データ）は elder 扱いで False のまま。"""
        metas = [{"trigger_reason": "rms"}, {}]
        ctx = build_call_context(_jst(9), metas)
        assert ctx.has_family_trigger is False

    # --- 顔検知の家族側化・両側連写（Phase 2）--------------------------------

    def test_has_face_trigger_true_when_any_photo_is_face(self):
        """1枚でも trigger_reason == "face" があれば True（顔トリガー・Phase 2）。"""
        metas = [{"trigger_reason": "rms"}, {"trigger_reason": "face"}]
        ctx = build_call_context(_jst(9), metas)
        assert ctx.has_face_trigger is True

    def test_has_face_trigger_false_when_absent(self):
        metas = [{"trigger_reason": "rms"}, {"trigger_reason": "centroid"}]
        ctx = build_call_context(_jst(9), metas)
        assert ctx.has_face_trigger is False

    def test_has_family_stream_true_when_any_photo_is_family(self):
        """1枚でも stream == "family" があれば True（両側連写・Phase 2）。"""
        metas = [{"stream": "elder"}, {"stream": "family"}]
        ctx = build_call_context(_jst(9), metas)
        assert ctx.has_family_stream is True

    def test_has_family_stream_false_when_absent(self):
        """stream 未設定（過去データ）は elder 扱いで False のまま。"""
        metas = [{"stream": "elder"}, {}]
        ctx = build_call_context(_jst(9), metas)
        assert ctx.has_family_stream is False


# ---------------------------------------------------------------------------
# プロンプト組み立て（build_prompt）
# ---------------------------------------------------------------------------


class TestBuildPrompt:
    def test_full_context_prompt(self):
        ctx = CallContext(
            datetime_label="2026年7月4日・夕方",
            stt_excerpt="かわいいね／また来てね",
            stt_labels=("かわいい",),
            trigger_summary="声の盛り上がり3回・感情ワード1回",
        )
        prompt = build_prompt(ctx)
        assert "あなたは歌人の趣を持つ、家族のフォトアルバムの編集者です。" in prompt
        assert "- 通話日時: 2026年7月4日・夕方" in prompt
        assert "- 会話から聞き取れた言葉（抜粋）: かわいいね／また来てね" in prompt
        assert "- 検知した感情ワード: かわいい" in prompt
        assert "- 撮影のきっかけ: 声の盛り上がり3回・感情ワード1回" in prompt
        assert "- タイトルは15字以内。「家族の◯◯」のような汎用表現を避け" in prompt
        assert "- キャプションは30字以内。" in prompt
        assert "- 固有名詞は推測しない" in prompt
        assert '- JSON {"title": "...", "caption": "..."} のみを返す' in prompt

    def test_missing_lines_are_omitted(self):
        """文脈の無い行（会話・感情ワード・きっかけ・家族側の反応・孫の表情・写真の構成）は省略される。"""
        ctx = CallContext(datetime_label="2026年7月4日・夜")
        prompt = build_prompt(ctx)
        assert "- 通話日時: 2026年7月4日・夜" in prompt
        assert "会話から聞き取れた言葉" not in prompt
        assert "検知した感情ワード" not in prompt
        assert "撮影のきっかけ" not in prompt
        assert "家族側の反応" not in prompt
        assert "孫の表情" not in prompt
        assert "写真の構成" not in prompt
        # 要件ブロックは常にある。
        assert '- JSON {"title": "...", "caption": "..."} のみを返す' in prompt

    def test_face_trigger_note_included_when_present(self):
        """顔検知の家族側化（Phase 2）: has_face_trigger=True で「孫の笑顔・変顔」行が足される。"""
        ctx = CallContext(datetime_label="2026年7月4日・夜", has_face_trigger=True)
        prompt = build_prompt(ctx)
        assert "- 孫の表情: 孫の笑顔・変顔がこの瞬間のきっかけになった" in prompt

    def test_family_stream_note_included_when_present(self):
        """両側連写（Phase 2）: has_family_stream=True で写真の構成行が足される。"""
        ctx = CallContext(datetime_label="2026年7月4日・夜", has_family_stream=True)
        prompt = build_prompt(ctx)
        assert "- 写真の構成: 家族（孫）側のカメラで撮れた写真も含まれる" in prompt

    def test_family_trigger_note_included_when_present(self):
        """声トリガーの両側化（2026-07-10）: has_family_trigger=True で文脈行が1つ足される。"""
        ctx = CallContext(datetime_label="2026年7月4日・夜", has_family_trigger=True)
        prompt = build_prompt(ctx)
        assert (
            "- 家族側の反応: 家族側の歓声や声の盛り上がりもこの瞬間のきっかけになった"
            in prompt
        )

    def test_family_trigger_note_omitted_when_absent(self):
        ctx = CallContext(datetime_label="2026年7月4日・夜", has_family_trigger=False)
        prompt = build_prompt(ctx)
        assert "家族側の反応" not in prompt


# ---------------------------------------------------------------------------
# タイトルの詩的文体（2026-07-28・S4）
# ---------------------------------------------------------------------------


class TestPoeticTitleStyle:
    """タイトルを詩的文体にする指示・例示がプロンプトへ確実に入ることを検証する。

    文脈の有無に関わらず常に入る（文脈行のように省略されない）ことが要点。
    """

    @staticmethod
    def _prompts() -> list[str]:
        """文脈なし・文脈ありの両方のプロンプトを返す（常設の指示ブロックを検証するため）。"""
        minimal = CallContext(datetime_label="2026年7月4日・夜")
        full = CallContext(
            datetime_label="2026年7月4日・夕方",
            stt_excerpt="朝顔きれいね",
            stt_labels=("うれしい",),
            trigger_summary="声の盛り上がり2回",
            has_family_trigger=True,
            has_face_trigger=True,
            has_family_stream=True,
        )
        return [build_prompt(minimal), build_prompt(full)]

    def test_role_is_poet_editor(self):
        """ロールが「歌人の趣を持つ、家族のフォトアルバムの編集者」であること。"""
        for prompt in self._prompts():
            assert "あなたは歌人の趣を持つ、家族のフォトアルバムの編集者です。" in prompt

    def test_classical_poetry_style_instructions_present(self):
        """古典詩歌の情緒・季節の気配・余韻・体言止め・大和言葉の指示が入る。"""
        for prompt in self._prompts():
            assert "タイトルの文体:" in prompt
            assert "古典詩歌（和歌・俳句）の情緒" in prompt
            assert "季節の気配" in prompt
            assert "余韻" in prompt
            assert "体言止め" in prompt
            assert "大和言葉" in prompt

    def test_modern_kana_is_required(self):
        """旧仮名遣いを使わせない指示が入る（読みやすさ優先）。

        「ゐ・ゑ」型だけでなく「思ひ出」型（語中のハ行）も具体例で潰していること
        （S4 の実生成で「卓袱台に咲く思ひ出」が出たため補強した）。
        """
        for prompt in self._prompts():
            assert "旧仮名遣い（ゐ・ゑ・けふ・思ひ出 など）は使わず、現代仮名遣いで" in prompt
            assert "「思ひ出」ではなく「思い出」" in prompt

    def test_length_limit_restated_in_style_block(self):
        """詩情を優先しても15字以内を守らせる念押しが入る。"""
        for prompt in self._prompts():
            assert "15字以内は必ず守る" in prompt

    def test_no_hallucination_guard_in_style_block(self):
        """季節・場面を勝手に決めつけさせないガード行が入る。"""
        for prompt in self._prompts():
            assert "分かる範囲にとどめ、無い情報を決めつけない" in prompt

    def test_examples_are_embedded_in_prompt(self):
        """例示（3〜5個）がすべてプロンプトへ箇条書きで埋め込まれる。"""
        assert 3 <= len(TITLE_STYLE_EXAMPLES) <= 5
        for prompt in self._prompts():
            assert "タイトルの例" in prompt
            for example in TITLE_STYLE_EXAMPLES:
                assert f"- {example}" in prompt

    def test_examples_satisfy_title_constraints(self):
        """例示自体が制約（15字以内・現代仮名遣い）を満たす＝見本が破綻していないこと。"""
        for example in TITLE_STYLE_EXAMPLES:
            assert 0 < len(example) <= 15, example
            for char in _OLD_KANA_CHARS:
                assert char not in example, example

    def test_examples_are_not_to_be_copied_verbatim(self):
        """例示の丸写しを禁じる一文が入る（毎回同じタイトルになるのを防ぐガード）。"""
        for prompt in self._prompts():
            assert "そのまま使わず" in prompt

    def test_caption_stays_plain(self):
        """キャプションは平易なまま（詩的にしすぎない）という指示であること。"""
        for prompt in self._prompts():
            assert (
                "- キャプションは30字以内。写真から分かる表情・場面を、"
                "詩的にしすぎず平易な言葉で伝える" in prompt
            )

    def test_caption_forbids_classical_style(self):
        """キャプションは完全に口語（文語調を使わせない）指示が入ること。

        タイトルの詩的文体がキャプションへ滲むのを防ぐ念押し（S4 コーディネーター裁定）。
        """
        for prompt in self._prompts():
            assert (
                "- キャプションでは文語調（〜き・〜なり 等）は使わず、"
                "話し言葉に近い平易な文にする" in prompt
            )

    def test_unchanged_contract_is_kept(self):
        """変更禁止の制約（15字/30字・固有名詞・JSON のみ）が維持されていること。"""
        for prompt in self._prompts():
            assert "- タイトルは15字以内。「家族の◯◯」のような汎用表現を避け" in prompt
            assert "- キャプションは30字以内。" in prompt
            assert "- 固有名詞は推測しない" in prompt
            assert '- JSON {"title": "...", "caption": "..."} のみを返す' in prompt
