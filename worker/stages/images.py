"""画像生成ユーティリティ（サムネイル・コラージュ）。

Pillow で軽量サムネイル（第1段）と1枚コラージュ（第2段）を生成する純関数群。
DB / Blob には依存しない（呼び出し側が bytes を受け取ってアップロードする）。

参照: docs/data-contract.md §2（Blobパス規約に thumbs/ とコラージュのパスを定義）
"""

from __future__ import annotations

import io
import logging

from PIL import Image

logger = logging.getLogger("worker.images")

# サムネイル仕様（軽量化の本命）。
THUMB_WIDTH = 320
THUMB_QUALITY = 70

# コラージュ仕様。
COLLAGE_WIDTH = 1600
COLLAGE_MARGIN = 24  # 白余白（外周・セル間で共通）
COLLAGE_QUALITY = 85
COLLAGE_BG = (255, 255, 255)  # 白背景


def make_thumbnail(image_bytes: bytes) -> bytes:
    """原画像 bytes から幅 THUMB_WIDTH・JPEG品質 THUMB_QUALITY のサムネ bytes を返す。

    - 幅を THUMB_WIDTH に固定し、高さはアスペクト維持。
      元画像が THUMB_WIDTH 以下なら拡大せずそのまま（幅維持）。
    - RGBA/パレット等は RGB へ変換（JPEG 保存のため）。

    Raises:
        呼び出し側で握りつぶす前提。Pillow が開けない bytes では例外を送出する。
    """
    with Image.open(io.BytesIO(image_bytes)) as img:
        img = img.convert("RGB")
        w, h = img.size
        if w > THUMB_WIDTH:
            new_h = max(1, round(h * THUMB_WIDTH / w))
            img = img.resize((THUMB_WIDTH, new_h), Image.LANCZOS)
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=THUMB_QUALITY)
        return buf.getvalue()


def _crop_to_cell(img: Image.Image, cell_w: int, cell_h: int) -> Image.Image:
    """画像をセル寸法にアスペクト維持でクロップ（センタークロップ）する。"""
    src_w, src_h = img.size
    if src_w == 0 or src_h == 0:
        return img.resize((cell_w, cell_h), Image.LANCZOS)
    # セルを埋める倍率（cover）。はみ出す分を中央クロップする。
    scale = max(cell_w / src_w, cell_h / src_h)
    resized_w = max(1, round(src_w * scale))
    resized_h = max(1, round(src_h * scale))
    resized = img.resize((resized_w, resized_h), Image.LANCZOS)
    left = (resized_w - cell_w) // 2
    top = (resized_h - cell_h) // 2
    return resized.crop((left, top, left + cell_w, top + cell_h))


def make_collage(image_bytes_list: list[bytes]) -> bytes:
    """確定5枚から1枚のコラージュ JPEG bytes を生成する。

    レイアウト: 横 COLLAGE_WIDTH・2行グリッド（上段2枚・下段3枚）・白余白。
    各セルはアスペクト維持クロップ（cover）。5枚に満たない場合は在る分だけ配置し、
    空セルは白余白のままにする。

    Args:
        image_bytes_list: 表示順の原画像 bytes（1〜5枚想定）。

    Returns:
        コラージュ JPEG の bytes。
    """
    if not image_bytes_list:
        raise ValueError("コラージュ生成には画像が1枚以上必要です")

    imgs: list[Image.Image] = []
    for b in image_bytes_list[:5]:
        with Image.open(io.BytesIO(b)) as im:
            imgs.append(im.convert("RGB"))

    m = COLLAGE_MARGIN
    # 上段2枚・下段3枚。列数の最大は3。セル幅は下段（3列）基準で決める。
    inner_w = COLLAGE_WIDTH - m * 2
    # 下段3セル + セル間余白2つ。
    bottom_cell_w = (inner_w - m * 2) // 3
    # 上段2セル + セル間余白1つ。
    top_cell_w = (inner_w - m) // 2
    # セル高さは共通（下段セル幅の 3:2 相当を目安に、上段幅とのバランスで決める）。
    cell_h = round(bottom_cell_w * 2 / 3)

    total_h = m + cell_h + m + cell_h + m
    canvas = Image.new("RGB", (COLLAGE_WIDTH, total_h), COLLAGE_BG)

    # 配置座標（左上原点）。上段は2枚、下段は3枚。
    positions: list[tuple[int, int, int, int]] = []  # (x, y, w, h)
    # 上段（y=m）: 2枚。
    top_y = m
    positions.append((m, top_y, top_cell_w, cell_h))
    positions.append((m + top_cell_w + m, top_y, top_cell_w, cell_h))
    # 下段（y=m+cell_h+m）: 3枚。
    bottom_y = m + cell_h + m
    for c in range(3):
        x = m + c * (bottom_cell_w + m)
        positions.append((x, bottom_y, bottom_cell_w, cell_h))

    for img, (x, y, w, h) in zip(imgs, positions):
        cell = _crop_to_cell(img, w, h)
        canvas.paste(cell, (x, y))

    for im in imgs:
        im.close()

    buf = io.BytesIO()
    canvas.save(buf, format="JPEG", quality=COLLAGE_QUALITY)
    return buf.getvalue()
