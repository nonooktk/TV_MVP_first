"""FFmpeg コマンド組み立てと実行（第2段の描画部）。

docs/ffmpeg-commands.md のクロスフェード版に忠実にコマンドを組み立てる。
- 動画は 30 秒・1920x1080・H.264(yuv420p)/AAC・30fps。
- 各画像は 7 秒クリップ、隣接を 1 秒クロスフェード。
- 5枚未満の場合は枚数に応じて xfade の offset を再計算する。
- BGM は 30 秒へ整え、28 秒から 2 秒フェードアウト（無音時は anullsrc）。
- 失敗時は concat 簡易版へフォールバックする。
"""

from __future__ import annotations

import logging
import subprocess
from pathlib import Path

logger = logging.getLogger("worker.ffmpeg")

# 出力仕様（docs/ffmpeg-commands.md §2）。
_W, _H = 1920, 1080
_FPS = 30
_TOTAL_SEC = 30
_CLIP_SEC = 7  # クロスフェード版の各クリップ長
_XFADE_SEC = 1  # クロスフェード長
_FADEOUT_START = 28  # BGM フェードアウト開始秒
_FADEOUT_DUR = 2

# 各クリップ共通の scale+pad+format チェーン。
_VF_CHAIN = (
    f"scale={_W}:{_H}:force_original_aspect_ratio=decrease,"
    f"pad={_W}:{_H}:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p,fps={_FPS}"
)


def _xfade_offsets(n: int) -> list[int]:
    """n 枚（7秒クリップ・1秒xfade）の各 xfade の offset を返す。

    offset(k) = k*(clip - xfade) + (clip - xfade)  ではなく、
    累積長ベースで offset = 直前までの累積長 - xfade。
    1本目: 累積 = clip。以降 累積 += (clip - xfade)。
    docs/ffmpeg-commands.md §3.1 の表と一致する（5枚: 6,12,18,24）。
    """
    offsets: list[int] = []
    cumulative = _CLIP_SEC
    for _ in range(n - 1):
        offsets.append(cumulative - _XFADE_SEC)
        cumulative += _CLIP_SEC - _XFADE_SEC
    return offsets


def build_xfade_command(
    photos: list[Path],
    bgm: Path | None,
    output: Path,
) -> list[str]:
    """クロスフェード版の ffmpeg コマンド（引数リスト）を組み立てる。

    Args:
        photos: 表示順の画像パス（1〜5枚）。
        bgm: BGM 音源パス。None なら無音（anullsrc）。
        output: 出力 mp4 パス。
    """
    n = len(photos)
    if n < 1:
        raise ValueError("画像が1枚もありません")

    cmd: list[str] = ["ffmpeg", "-y"]
    for p in photos:
        cmd += ["-loop", "1", "-t", str(_CLIP_SEC), "-i", str(p)]

    # 音声入力: BGM があればファイル、無ければ anullsrc（無音）。
    # BGM が30秒未満でも尺不足にならないよう -stream_loop -1 で無限ループさせ、
    # 後段の atrim=0:30 で30秒に切り詰める（docs/ffmpeg-commands.md §4 の下ごしらえ相当）。
    if bgm is not None:
        cmd += ["-stream_loop", "-1", "-i", str(bgm)]
        audio_input_idx = n
        audio_src = f"[{audio_input_idx}:a]"
    else:
        # 無音ソースを lavfi で用意する。
        cmd += ["-f", "lavfi", "-t", str(_TOTAL_SEC), "-i", "anullsrc=r=44100:cl=stereo"]
        audio_input_idx = n
        audio_src = f"[{audio_input_idx}:a]"

    # 映像フィルタチェーンを構築。
    parts: list[str] = []
    for i in range(n):
        parts.append(f"[{i}:v]{_VF_CHAIN}[v{i}]")

    if n == 1:
        # 1枚のみ: xfade なし。単一クリップを vout とする。
        video_out = "[v0]"
    else:
        offsets = _xfade_offsets(n)
        prev = "[v0]"
        for k in range(1, n):
            out_label = "[vout]" if k == n - 1 else f"[x{k}]"
            parts.append(
                f"{prev}[v{k}]xfade=transition=fade:"
                f"duration={_XFADE_SEC}:offset={offsets[k - 1]}{out_label}"
            )
            prev = out_label
        video_out = "[vout]"

    # 音声: 30秒トリム＋末尾2秒フェードアウト。
    parts.append(
        f"{audio_src}atrim=0:{_TOTAL_SEC},"
        f"afade=t=out:st={_FADEOUT_START}:d={_FADEOUT_DUR},"
        f"asetpts=PTS-STARTPTS[aout]"
    )

    filter_complex = "; ".join(parts)
    cmd += [
        "-filter_complex", filter_complex,
        "-map", video_out,
        "-map", "[aout]",
        "-t", str(_TOTAL_SEC),
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-r", str(_FPS),
        "-c:a", "aac", "-b:a", "128k",
        "-shortest",
        str(output),
    ]
    return cmd


def _clip_seconds_concat(n: int) -> int:
    """concat 簡易版の1枚あたり表示秒。合計 30 秒になるよう均等割り。"""
    # 5枚なら6秒。端数は切り上げ（-t 30 で最終的に30秒へ丸める）。
    return max(1, -(-_TOTAL_SEC // max(1, n)))  # ceil(30/n)


def build_concat_commands(
    photos: list[Path],
    bgm: Path | None,
    output: Path,
    workdir: Path,
) -> list[list[str]]:
    """concat 簡易版（フォールバック）のコマンド列を組み立てる。

    各画像を個別クリップにエンコード → concat で結合 → BGM をミックス。
    docs/ffmpeg-commands.md §5 準拠。戻り値は順に実行すべきコマンドのリスト。
    """
    n = len(photos)
    per = _clip_seconds_concat(n)
    commands: list[list[str]] = []

    clip_paths: list[Path] = []
    for i, p in enumerate(photos, start=1):
        clip = workdir / f"clip{i}.mp4"
        clip_paths.append(clip)
        vf = (
            f"scale={_W}:{_H}:force_original_aspect_ratio=decrease,"
            f"pad={_W}:{_H}:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p"
        )
        commands.append(
            [
                "ffmpeg", "-y", "-loop", "1", "-t", str(per), "-i", str(p),
                "-vf", vf, "-r", str(_FPS),
                "-c:v", "libx264", "-pix_fmt", "yuv420p",
                str(clip),
            ]
        )

    # concat リストファイル。
    list_file = workdir / "concat_list.txt"
    list_file.write_text(
        "".join(f"file '{c.name}'\n" for c in clip_paths), encoding="utf-8"
    )
    video_only = workdir / "video_only.mp4"
    commands.append(
        [
            "ffmpeg", "-y", "-f", "concat", "-safe", "0",
            "-i", str(list_file), "-c", "copy", str(video_only),
        ]
    )

    # BGM ミックス（無音時は anullsrc）。BGM は -stream_loop -1 で30秒未満に対応。
    if bgm is not None:
        commands.append(
            [
                "ffmpeg", "-y", "-i", str(video_only),
                "-stream_loop", "-1", "-i", str(bgm),
                "-filter_complex",
                f"[1:a]atrim=0:{_TOTAL_SEC},"
                f"afade=t=out:st={_FADEOUT_START}:d={_FADEOUT_DUR},"
                f"asetpts=PTS-STARTPTS[aout]",
                "-map", "0:v", "-map", "[aout]",
                "-t", str(_TOTAL_SEC),
                "-c:v", "libx264", "-pix_fmt", "yuv420p", "-r", str(_FPS),
                "-c:a", "aac", "-b:a", "128k", "-shortest",
                str(output),
            ]
        )
    else:
        commands.append(
            [
                "ffmpeg", "-y", "-i", str(video_only),
                "-f", "lavfi", "-t", str(_TOTAL_SEC),
                "-i", "anullsrc=r=44100:cl=stereo",
                "-filter_complex",
                f"[1:a]afade=t=out:st={_FADEOUT_START}:d={_FADEOUT_DUR}[aout]",
                "-map", "0:v", "-map", "[aout]",
                "-t", str(_TOTAL_SEC),
                "-c:v", "libx264", "-pix_fmt", "yuv420p", "-r", str(_FPS),
                "-c:a", "aac", "-b:a", "128k", "-shortest",
                str(output),
            ]
        )
    return commands


def _run(cmd: list[str]) -> subprocess.CompletedProcess:
    """ffmpeg を実行し、失敗時は stderr 付きで例外を送出する。"""
    logger.debug("run: %s", " ".join(cmd))
    return subprocess.run(cmd, capture_output=True, text=True, check=True)


def render(
    photos: list[Path],
    bgm: Path | None,
    output: Path,
    workdir: Path,
) -> str:
    """動画を生成する。クロスフェード版→失敗時 concat 簡易版へフォールバック。

    Returns:
        使用した方式（"xfade" / "concat"）。
    """
    try:
        cmd = build_xfade_command(photos, bgm, output)
        _run(cmd)
        return "xfade"
    except subprocess.CalledProcessError as e:
        logger.warning(
            "クロスフェード版に失敗。concat 簡易版へフォールバックする。stderr=\n%s",
            e.stderr,
        )
        for cmd in build_concat_commands(photos, bgm, output, workdir):
            _run(cmd)
        return "concat"
