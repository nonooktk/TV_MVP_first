"""pytest 共通フィクスチャ。

テスト用DB（tvmvp_test）を docker の postgres 内に用意して使う。
- スキーマは models.Base.metadata から作成する（ENUM も含めて生成される）。
- Blob/Queue はフェイクへDI差し替えする（実 Azurite に依存しない）。
- 各テストはトランザクションのロールバックで隔離せず、テーブルを都度作り直す方式にする
  （ENUM ネイティブ型を含むためシンプルに drop_all→create_all）。

TEST_DATABASE_URL 環境変数で接続先を上書きできる。既定は
postgresql://tvmvp:tvmvp_dev_password@localhost:5433/tvmvp_test。
"""

from __future__ import annotations

import os
from datetime import datetime, timezone

import pytest

# --- テスト用の環境変数を import 前に設定する ---------------------------------
_TEST_DB_URL = os.environ.get(
    "TEST_DATABASE_URL",
    "postgresql://tvmvp:tvmvp_dev_password@localhost:5433/tvmvp_test",
)
os.environ["DATABASE_URL"] = _TEST_DB_URL
os.environ.setdefault(
    "AZURE_STORAGE_CONNECTION_STRING",
    "DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;"
    "AccountKey=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/"
    "K1SZFPTOtr/KBHBeksoGMGw==;"
    "BlobEndpoint=http://127.0.0.1:10000/devstoreaccount1;"
    "QueueEndpoint=http://127.0.0.1:10001/devstoreaccount1;",
)
os.environ.setdefault("DEV_FAMILY_TOKEN", "dev-fixed-token")
os.environ.setdefault("MEDIA_CONTAINER", "media")
os.environ.setdefault("QUEUE_NAME", "pipeline-jobs")
os.environ.setdefault("FRONTEND_BASE_URL", "http://localhost:3000")
# Agora はテストでは常に Fake を使う（backend/.env に実クレデンシャルがあっても
# 環境変数が .env より優先されるため、空で上書きして Real への切替を防ぐ）。
os.environ["AGORA_APP_ID"] = ""
os.environ["AGORA_APP_CERTIFICATE"] = ""
# Azure Speech も同様に常に Fake（dev-setup §13-7 で backend/.env に実キーを
# 追記する運用になったため、Agora と同じく空で上書きして Real への切替を防ぐ）。
os.environ["AZURE_SPEECH_KEY"] = ""
os.environ["AZURE_SPEECH_REGION"] = ""

from fastapi.testclient import TestClient  # noqa: E402

from app.api.deps import get_blob_service, get_queue_service  # noqa: E402
from app.core.security import sha256_hex  # noqa: E402
from app.db.models import Base, Device, Family, User  # noqa: E402
from app.db.session import SessionLocal, engine  # noqa: E402
from app.main import app  # noqa: E402
from app.services.queue import FakeQueueService  # noqa: E402

FAMILY_TOKEN = os.environ["DEV_FAMILY_TOKEN"]
DEVICE_TOKEN = "dev-device-token"


class FakeBlobService:
    """テスト用フェイク Blob。SAS URL はダミー文字列を返す。

    削除検証のため、存在する Blob 名を集合で保持できる（既定は空。テストが
    `store` に事前投入することで delete_blob / delete_prefix の呼び出しを観測する）。
    """

    container = "media"

    def __init__(self) -> None:
        # 存在する Blob 名の集合（テストで事前投入して削除を検証する）。
        self.store: set[str] = set()
        # 削除呼び出しの記録（キー名）。
        self.deleted: list[str] = []

    def ensure_container(self) -> None:  # noqa: D102
        pass

    def view_sas_url(self, storage_key: str) -> str:  # noqa: D102
        return f"https://fake.blob/{self.container}/{storage_key}?sig=view"

    def upload_sas_url(self, storage_key: str, call_prefix: str) -> str:  # noqa: D102
        return f"https://fake.blob/{self.container}/{storage_key}?sig=upload"

    def upload(self, storage_key: str, data: bytes, content_type=None) -> None:  # noqa: D102
        self.store.add(storage_key)

    def delete_blob(self, storage_key: str) -> bool:  # noqa: D102
        self.deleted.append(storage_key)
        if storage_key in self.store:
            self.store.discard(storage_key)
            return True
        return False

    def delete_prefix(self, prefix: str) -> int:  # noqa: D102
        targets = [k for k in self.store if k.startswith(prefix)]
        for k in targets:
            self.deleted.append(k)
            self.store.discard(k)
        return len(targets)


@pytest.fixture(scope="session", autouse=True)
def _schema() -> None:
    """テスト用DBのスキーマを一度だけ作り直す。

    ENUM はネイティブ型（create_type=False）のため metadata.create_all では作られない。
    そこで各テーブルの前に明示的に ENUM を作成し、その後 create_all する。
    （0001_initial マイグレーションと同じ順序。）
    """
    from sqlalchemy import text

    from app.db.models import (
        album_status_enum,
        call_status_enum,
        device_status_enum,
        memory_status_enum,
        memory_type_enum,
        user_role_enum,
    )

    # まっさらな状態から作り直す（既存の型・テーブルを含めて破棄）。
    with engine.begin() as conn:
        conn.execute(text("DROP SCHEMA public CASCADE"))
        conn.execute(text("CREATE SCHEMA public"))

    enums = [
        user_role_enum,
        device_status_enum,
        call_status_enum,
        memory_type_enum,
        memory_status_enum,
        album_status_enum,
    ]
    with engine.begin() as conn:
        for e in enums:
            e.create(conn, checkfirst=True)
    Base.metadata.create_all(engine)
    yield


@pytest.fixture(autouse=True)
def _clean_tables() -> None:
    """各テスト前に全テーブルを空にする（依存の逆順で TRUNCATE）。"""
    with engine.begin() as conn:
        from sqlalchemy import text

        conn.execute(
            text(
                "TRUNCATE albums, memories, calls, devices, users, families "
                "RESTART IDENTITY CASCADE"
            )
        )
    yield


@pytest.fixture
def db():
    """テスト用の DB セッション。"""
    session = SessionLocal()
    try:
        yield session
    finally:
        session.close()


@pytest.fixture
def fake_queue() -> FakeQueueService:
    return FakeQueueService()


@pytest.fixture
def fake_blob() -> FakeBlobService:
    """テスト全体で共有する Fake Blob（削除・アップロードを観測できる）。"""
    return FakeBlobService()


@pytest.fixture
def client(fake_queue: FakeQueueService, fake_blob: FakeBlobService) -> TestClient:
    """DI をフェイクへ差し替えた TestClient（Blob は fake_blob を共有）。"""
    app.dependency_overrides[get_queue_service] = lambda: fake_queue
    app.dependency_overrides[get_blob_service] = lambda: fake_blob
    with TestClient(app) as c:
        yield c
    app.dependency_overrides.clear()


@pytest.fixture
def seeded(db):
    """family＋owner＋active デバイスをシードして各IDとトークンを返す。"""
    family = Family(name="テスト家族")
    db.add(family)
    db.flush()
    owner = User(family_id=family.id, role="owner", auth_id="dev-owner")
    db.add(owner)
    db.flush()
    device = Device(
        family_id=family.id,
        fixed_contact_user_id=owner.id,
        status="active",
        device_token_hash=sha256_hex(DEVICE_TOKEN),
        registered_at=datetime.now(timezone.utc),
    )
    db.add(device)
    db.commit()
    return {
        "family_id": family.id,
        "owner_id": owner.id,
        "device_id": device.id,
        "device_token": DEVICE_TOKEN,
        "family_token": FAMILY_TOKEN,
    }


@pytest.fixture
def family_headers() -> dict:
    return {"Authorization": f"Bearer {FAMILY_TOKEN}"}


@pytest.fixture
def device_headers() -> dict:
    return {"X-Device-Token": DEVICE_TOKEN}
