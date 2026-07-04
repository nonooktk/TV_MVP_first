"""通話後パイプライン 統合デモ（Phase 2 検証用）。

ダミー画像生成 → API 経由でメディア登録 → worker（--once）で score →
候補提示確認 → 選択確定 → worker（--once）で render → 動画検証（ffprobe）まで通す。
さらに auto_confirm 経路（選択せず自動確定 → render）も検証する。

前提（docs/dev-setup.md）:
- docker compose（postgres@5433・Azurite）起動済み
- backend にマイグレーション適用済み・seed 済み
- backend サーバが起動済み（既定 http://localhost:8000）。
  別 URL を使う場合は環境変数 DEMO_BASE_URL で上書きする。
- ffmpeg / ffprobe がローカルにある

実行（リポジトリ直下・backend/.venv の python）:
    cd /Users/mitsuru/Desktop/MyDocs/outputs/TV_MVP
    backend/.venv/bin/python scripts/demo_pipeline.py

ダミー画像は drawtext 非搭載 ffmpeg でも番号入りにできるよう、システム python3 の
PIL（Pillow）で生成する。PIL が無い場合は ffmpeg の単色画像へフォールバックする。
"""

from __future__ import annotations

import os
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path
from uuid import UUID

# --- パス整備 -----------------------------------------------------------------
_REPO_ROOT = Path(__file__).resolve().parents[1]
_BACKEND_ROOT = _REPO_ROOT / "backend"
if str(_BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(_BACKEND_ROOT))

import httpx  # noqa: E402
from sqlalchemy import select  # noqa: E402

from app.core.config import get_settings  # noqa: E402
from app.db.models import Device, Family  # noqa: E402
from app.db.session import SessionLocal  # noqa: E402

BASE_URL = os.environ.get("DEMO_BASE_URL", "http://localhost:8000")
FAMILY_TOKEN = get_settings().DEV_FAMILY_TOKEN
FAMILY_HEADERS = {"Authorization": f"Bearer {FAMILY_TOKEN}"}
DEVICE_TOKEN = "dev-device-token"
DEVICE_HEADERS = {"X-Device-Token": DEVICE_TOKEN}

WORKER_MAIN = _REPO_ROOT / "worker" / "main.py"
PYTHON = sys.executable  # backend/.venv/bin/python で実行される前提


# --- ログ補助 -----------------------------------------------------------------

def _step(msg: str) -> None:
    print(f"\n=== {msg} ===", flush=True)


def _ok(msg: str) -> None:
    print(f"  [OK] {msg}", flush=True)


def _info(msg: str) -> None:
    print(f"  - {msg}", flush=True)


# --- 準備 ---------------------------------------------------------------------

def _get_seed_ids() -> tuple[UUID, UUID]:
    """seed 済みの family_id / active device_id を取得する。"""
    db = SessionLocal()
    try:
        family = db.scalars(
            select(Family).where(Family.name == "テスト家族")
        ).first()
        if family is None:
            raise SystemExit(
                "seed 未実行です。先に backend/scripts/seed.py を実行してください。"
            )
        device = db.scalars(
            select(Device).where(
                Device.family_id == family.id, Device.status == "active"
            )
        ).first()
        if device is None:
            raise SystemExit("active デバイスがありません。seed を確認してください。")
        return family.id, device.id
    finally:
        db.close()


def _purge_queue() -> None:
    """pipeline-jobs キューの未処理メッセージを全消去する（デモの再現性確保）。"""
    from azure.storage.queue import QueueClient

    s = get_settings()
    q = QueueClient.from_connection_string(
        s.AZURE_STORAGE_CONNECTION_STRING, s.QUEUE_NAME
    )
    try:
        q.clear_messages()
        _info("キューをクリアしました（前回の遅延メッセージを掃除）")
    except Exception as e:  # noqa: BLE001
        _info(f"キュークリアをスキップ: {e}")


def _make_dummy_images(dest: Path, count: int) -> list[Path]:
    """番号入りダミー JPEG を count 枚生成する（1280x720）。

    PIL があれば番号を描画。無ければ ffmpeg の単色画像へフォールバック。
    """
    dest.mkdir(parents=True, exist_ok=True)
    paths = [dest / f"dummy{i}.jpg" for i in range(1, count + 1)]
    try:
        from PIL import Image, ImageDraw, ImageFont  # type: ignore

        try:
            font = ImageFont.truetype("/System/Library/Fonts/Helvetica.ttc", 400)
        except Exception:
            font = ImageFont.load_default()
        colors = [
            (200, 80, 80), (80, 180, 80), (80, 80, 200), (200, 200, 80),
            (200, 80, 200), (80, 200, 200), (150, 150, 150), (230, 140, 40),
        ]
        for i, p in enumerate(paths, start=1):
            img = Image.new("RGB", (1280, 720), colors[(i - 1) % len(colors)])
            d = ImageDraw.Draw(img)
            d.text((540, 120), str(i), fill="white", font=font)
            img.save(p, "JPEG", quality=90)
        _info(f"PIL で番号入り画像 {count} 枚を生成")
    except ImportError:
        # ffmpeg フォールバック（単色・番号なし）。
        for i, p in enumerate(paths, start=1):
            hue = (i * 37) % 360
            subprocess.run(
                [
                    "ffmpeg", "-y", "-f", "lavfi",
                    "-i", f"color=c=0x{(i*30)%256:02x}{(i*50)%256:02x}{(i*70)%256:02x}:s=1280x720:d=1",
                    "-frames:v", "1", str(p),
                ],
                check=True, capture_output=True,
            )
        _info(f"ffmpeg 単色画像 {count} 枚を生成（PIL 不在のため番号なし）")
    return paths


# --- API 操作 -----------------------------------------------------------------

def _create_call(client: httpx.Client, device_id: UUID) -> UUID:
    r = client.post("/calls", headers=FAMILY_HEADERS, json={"device_id": str(device_id)})
    r.raise_for_status()
    return UUID(r.json()["id"])


def _upload_candidates(
    client: httpx.Client,
    call_id: UUID,
    images: list[Path],
) -> list[tuple[str, dict]]:
    """upload-sas → 実 PUT で画像を投入し、(storage_key, metadata) 列を返す。

    metadata は rms_rise・face_score にバラつきを持たせる。
    先頭1枚は face_score=0.05 で無表情ゲート確認用にする。
    """
    from uuid import uuid4

    filenames = [f"candidates/{uuid4()}.jpg" for _ in images]
    r = client.post(
        "/media/upload-sas",
        headers=FAMILY_HEADERS,
        json={"call_id": str(call_id), "filenames": filenames},
    )
    r.raise_for_status()
    items = r.json()["items"]

    results: list[tuple[str, dict]] = []
    for idx, (img, item) in enumerate(zip(images, items)):
        # SAS URL へ直接 PUT（Azure Blob 要件: x-ms-blob-type）。
        put = httpx.put(
            item["upload_url"],
            content=img.read_bytes(),
            headers={"x-ms-blob-type": "BlockBlob", "Content-Type": "image/jpeg"},
        )
        put.raise_for_status()

        # metadata: rms_rise を段階的に、face_score をばらつかせる。
        if idx == 0:
            meta = {"rms_rise": 2.0, "face_score": 0.05}  # 無表情ゲート対象
        else:
            meta = {
                "rms_rise": float(idx * 2),
                "face_score": round(0.3 + 0.08 * idx, 3),
            }
        results.append((item["storage_key"], meta))
    return results


def _register_media(
    client: httpx.Client,
    call_id: UUID,
    keyed_meta: list[tuple[str, dict]],
) -> None:
    items = [
        {
            "type": "photo",
            "storage_key": key,
            "captured_at": datetime.now(timezone.utc).isoformat(),
            "metadata": meta,
        }
        for key, meta in keyed_meta
    ]
    r = client.post(
        "/media/register",
        headers=FAMILY_HEADERS,
        json={"call_id": str(call_id), "items": items},
    )
    r.raise_for_status()


def _run_worker_once(env_extra: dict | None = None) -> None:
    """worker を --once で実行し、キューが空になるまで処理させる。

    worker は pydantic-settings で backend/.env を読むため、cwd を backend/ にして起動する
    （env_file=".env" は cwd 相対のため）。デモ短縮用の env は上書きで渡す。
    """
    env = os.environ.copy()
    # backend の設定値を確実に渡す（cwd に依存せず解決できるようにする）。
    s = get_settings()
    env.setdefault("DATABASE_URL", s.DATABASE_URL)
    env.setdefault("AZURE_STORAGE_CONNECTION_STRING", s.AZURE_STORAGE_CONNECTION_STRING)
    env.setdefault("DEV_FAMILY_TOKEN", s.DEV_FAMILY_TOKEN)
    env.setdefault("MEDIA_CONTAINER", s.MEDIA_CONTAINER)
    env.setdefault("QUEUE_NAME", s.QUEUE_NAME)
    if env_extra:
        env.update(env_extra)
    r = subprocess.run(
        [PYTHON, str(WORKER_MAIN), "--once"],
        cwd=str(_BACKEND_ROOT),
        env=env, capture_output=True, text=True,
    )
    if r.returncode != 0:
        print(r.stdout)
        print(r.stderr, file=sys.stderr)
        raise SystemExit(f"worker --once 失敗（code={r.returncode}）")
    # ワーカーの主要ログを表示する。
    for line in r.stderr.splitlines():
        if any(k in line for k in ("score 完了", "auto_confirm", "render", "毒メッセージ", "delete_after")):
            _info(line.split(": ", 1)[-1] if ": " in line else line)


def _get_candidates(client: httpx.Client, call_id: UUID) -> dict:
    r = client.get(f"/calls/{call_id}/candidates", headers=FAMILY_HEADERS)
    r.raise_for_status()
    return r.json()


def _submit_selection(client: httpx.Client, call_id: UUID, memory_ids: list[str]) -> dict:
    r = client.post(
        f"/calls/{call_id}/selection",
        headers=FAMILY_HEADERS,
        json={"memory_ids": memory_ids},
    )
    r.raise_for_status()
    return r.json()


def _get_album_by_call(client: httpx.Client, call_id: UUID) -> dict:
    """家族の閲覧一覧（Bearer）から該当 call_id の ready アルバムを取得する。

    /albums/latest は X-Device-Token（デバイス認証）を要するため、デモでは
    家族 Bearer で叩ける /albums 一覧から call_id 一致で引く（video_sas_url を含む）。
    """
    r = client.get("/albums", headers=FAMILY_HEADERS, params={"limit": 100})
    r.raise_for_status()
    for album in r.json()["items"]:
        if album["call_id"] == str(call_id):
            return album
    raise SystemExit(f"call_id={call_id} の ready アルバムが一覧に見つかりません")


def _probe_video(url: str, dest: Path) -> dict:
    """video_sas_url をダウンロードし ffprobe で duration/codec を返す。"""
    resp = httpx.get(url)
    resp.raise_for_status()
    dest.write_bytes(resp.content)
    import json as _json

    out = subprocess.run(
        [
            "ffprobe", "-v", "error",
            "-show_entries", "format=duration:stream=codec_type,codec_name",
            "-of", "json", str(dest),
        ],
        capture_output=True, text=True, check=True,
    )
    data = _json.loads(out.stdout)
    info: dict = {"video_codec": None, "audio_codec": None, "duration": None}
    info["duration"] = float(data.get("format", {}).get("duration", 0.0))
    for stream in data.get("streams", []):
        if stream.get("codec_type") == "video":
            info["video_codec"] = stream.get("codec_name")
        elif stream.get("codec_type") == "audio":
            info["audio_codec"] = stream.get("codec_name")
    return info


# --- シナリオ -----------------------------------------------------------------

def scenario_manual(client: httpx.Client, device_id: UUID, workdir: Path) -> None:
    """選択経路: 家族が5枚を選んで確定 → render。"""
    _step("経路1（手動選択）: 発信 → メディア登録 → score → 選択 → render")
    images = _make_dummy_images(workdir / "manual", 8)
    call_id = _create_call(client, device_id)
    _info(f"call_id={call_id}")

    keyed = _upload_candidates(client, call_id, images)
    _register_media(client, call_id, keyed)
    _ok(f"候補 {len(keyed)} 枚を Blob 投入＋登録（score 投函済み）")

    _run_worker_once()  # score を処理
    cands = _get_candidates(client, call_id)
    _ok(f"候補提示: {len(cands['candidates'])} 件（auto_confirm_at={cands.get('auto_confirm_at')}）")

    # 無表情ゲート確認: face_score=0.05 の候補（先頭 storage_key）は score=0。
    gate_key = keyed[0][0]
    gated = [c for c in cands["candidates"] if c["storage_key"] == gate_key]
    if gated:
        _info(f"無表情ゲート対象 score={gated[0]['score']} status={gated[0]['status']} rank={gated[0]['rank']}")
        assert gated[0]["score"] == 0.0, "無表情ゲートが効いていない"
        _ok("無表情ゲート確認: face_score=0.05 の候補は score=0.0")

    # 上位5枚（rank 1..5）を選択する。
    ranked = sorted(cands["candidates"], key=lambda c: c["rank"])
    top5 = [c["id"] for c in ranked[:5]]
    album = _submit_selection(client, call_id, top5)
    _ok(f"選択確定: status={album['status']} version={album['version']}")
    assert album["status"] == "generating"

    _run_worker_once()  # render を処理
    latest = _get_album_by_call(client, call_id)
    _ok(f"render 完了: status={latest['status']} version={latest['version']} title={latest['title']}")
    assert latest["status"] == "ready"

    info = _probe_video(latest["video_sas_url"], workdir / "manual_out.mp4")
    _ok(f"ffprobe: duration={info['duration']}s video={info['video_codec']} audio={info['audio_codec']}")
    assert 29.0 <= info["duration"] <= 31.0, "尺が30秒付近でない"
    assert info["video_codec"] == "h264"
    assert info["audio_codec"] == "aac"
    _ok("経路1 検証成功（duration≈30・h264/aac）")


def scenario_auto_confirm(client: httpx.Client, device_id: UUID, workdir: Path) -> None:
    """自動確定経路: 選択せず auto_confirm（遅延5秒に短縮）→ render。"""
    _step("経路2（自動確定）: 発信 → 登録 → score → 5秒待ち → auto_confirm → render")
    images = _make_dummy_images(workdir / "auto", 8)
    call_id = _create_call(client, device_id)
    _info(f"call_id={call_id}")

    keyed = _upload_candidates(client, call_id, images)
    _register_media(client, call_id, keyed)
    _ok(f"候補 {len(keyed)} 枚を登録")

    # AUTO_CONFIRM_DELAY_SECONDS=5 で score を処理（auto_confirm を5秒遅延で投函）。
    delay_env = {"AUTO_CONFIRM_DELAY_SECONDS": "5"}
    _run_worker_once(delay_env)
    _ok("score 完了（auto_confirm を5秒遅延で投函）")

    # 選択せずに待つ（可視化遅延5秒＋余裕）。
    _info("6秒待機（auto_confirm メッセージの可視化を待つ）")
    time.sleep(6)

    # auto_confirm → render を続けて処理。
    _run_worker_once(delay_env)

    latest = _get_album_by_call(client, call_id)
    _ok(f"自動確定＋render 完了: status={latest['status']} auto_confirmed={latest['auto_confirmed']}")
    assert latest["status"] == "ready"
    assert latest["auto_confirmed"] is True

    info = _probe_video(latest["video_sas_url"], workdir / "auto_out.mp4")
    _ok(f"ffprobe: duration={info['duration']}s video={info['video_codec']} audio={info['audio_codec']}")
    assert 29.0 <= info["duration"] <= 31.0
    assert info["video_codec"] == "h264"
    assert info["audio_codec"] == "aac"
    _ok("経路2 検証成功（自動確定 → duration≈30・h264/aac）")


def main() -> None:
    print("通話後パイプライン 統合デモ 開始")
    family_id, device_id = _get_seed_ids()
    _info(f"family_id={family_id} device_id={device_id} base={BASE_URL}")

    # 前回実行で残った可視化遅延メッセージ（auto_confirm）を掃除する。
    # 残っていると後続の worker --once が旧メッセージを拾い、実行が長引くため。
    _purge_queue()

    with tempfile.TemporaryDirectory(prefix="tvmvp-demo-") as tmp:
        workdir = Path(tmp)
        with httpx.Client(base_url=BASE_URL, timeout=60.0) as client:
            # サーバ疎通確認。
            try:
                client.get("/healthz").raise_for_status()
            except Exception as e:  # noqa: BLE001
                raise SystemExit(
                    f"backend サーバに接続できません（{BASE_URL}）。"
                    f"uvicorn を起動してください。詳細: {e}"
                )
            scenario_manual(client, device_id, workdir)
            scenario_auto_confirm(client, device_id, workdir)

    print("\n=== すべてのシナリオが成功しました ===")


if __name__ == "__main__":
    main()
