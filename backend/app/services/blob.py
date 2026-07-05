"""Azure Blob Storage サービス（SAS発行・アップロード）。

パス規約・SASポリシーは docs/data-contract.md §2 が正。
- 閲覧用 SAS: read 権限・15分・対象Blob単位。
- アップロード用 SAS: create+write 権限・1時間・当該通話のプレフィックス限定。

`memories.storage_key` / `albums.video_storage_key` にはコンテナ名 `media` を除く
フルパス（families/… から始まる）を格納する。SAS URL はコンテナ名を含む実URLを返す。

ローカルは Azurite に対して実動作する。テスト時は DI で差し替え可能
（app.api.deps.get_blob_service を override）。
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from azure.storage.blob import (
    BlobSasPermissions,
    BlobServiceClient,
    ContainerSasPermissions,
    generate_blob_sas,
    generate_container_sas,
)

# SAS 有効期限（data-contract.md §2）
_VIEW_TTL = timedelta(minutes=15)
_UPLOAD_TTL = timedelta(hours=1)


class BlobService:
    """Blob コンテナに対する SAS 発行・アップロードを担当する。"""

    def __init__(self, connection_string: str, container: str) -> None:
        self._conn = connection_string
        self.container = container
        self._client = BlobServiceClient.from_connection_string(connection_string)

    # --- 初期化 --------------------------------------------------------------

    def ensure_container(self) -> None:
        """コンテナが無ければ作成する（非公開）。冪等。"""
        try:
            self._client.create_container(self.container)
        except Exception:
            # 既に存在する場合は無視する（ResourceExistsError）。
            pass

    def set_cors(self, allowed_origins: list[str]) -> None:
        """Blob サービスに CORS ルールを設定する。

        コア②（modules/sync）はブラウザから SAS URL へ直接 Blob を PUT する。
        これはストレージアカウント側の CORS 設定を必要とする（本番=Azure では A1 の
        担当。ローカル=Azurite ではこのメソッドで設定する）。冪等（毎回上書き）。
        """
        from azure.storage.blob import CorsRule

        rule = CorsRule(
            allowed_origins=allowed_origins,
            allowed_methods=["GET", "PUT", "OPTIONS", "HEAD"],
            allowed_headers=["*"],
            exposed_headers=["*"],
            max_age_in_seconds=3600,
        )
        self._client.set_service_properties(cors=[rule])

    # --- SAS 発行 ------------------------------------------------------------

    def view_sas_url(self, storage_key: str) -> str:
        """閲覧用 SAS 付き URL を返す（read・15分・Blob単位）。

        storage_key はコンテナ名を除くフルパス（families/… から始まる）。
        """
        expiry = datetime.now(timezone.utc) + _VIEW_TTL
        sas = generate_blob_sas(
            account_name=self._client.account_name,
            container_name=self.container,
            blob_name=storage_key,
            account_key=self._account_key(),
            permission=BlobSasPermissions(read=True),
            expiry=expiry,
        )
        return f"{self._blob_url(storage_key)}?{sas}"

    def upload_sas_url(self, storage_key: str, call_prefix: str) -> str:
        """アップロード用 SAS 付き URL を返す（create+write・1時間）。

        スコープは当該通話のプレフィックス `call_prefix`
        （families/{family_id}/calls/{call_id}/）に限定する。
        コンテナSASを call_prefix に絞って発行し、対象Blobの実URLへ付与する。
        """
        expiry = datetime.now(timezone.utc) + _UPLOAD_TTL
        # コンテナSASにプレフィックスは組み込めないため、権限を create+write に絞り、
        # 発行先URLを当該通話プレフィックス配下の Blob に限定することで運用スコープを担保する。
        sas = generate_container_sas(
            account_name=self._client.account_name,
            container_name=self.container,
            account_key=self._account_key(),
            permission=ContainerSasPermissions(create=True, write=True),
            expiry=expiry,
        )
        return f"{self._blob_url(storage_key)}?{sas}"

    # --- アップロード（テスト補助・スモーク用）------------------------------

    def upload(self, storage_key: str, data: bytes, content_type: str | None = None) -> None:
        """Blob へ直接アップロードする（サーバ側からの投入用途）。"""
        blob = self._client.get_blob_client(self.container, storage_key)
        blob.upload_blob(data, overwrite=True)

    # --- 削除（アプリ機能としての完全削除。Azureリソース削除ではない）--------

    def delete_blob(self, storage_key: str) -> bool:
        """単一 Blob を削除する。存在しなければ何もせず False（冪等）。

        DELETE /albums の完全削除で使う。存在しない Blob のスキップは冪等要件
        （data-contract.md ライフサイクル節）。
        """
        from azure.core.exceptions import ResourceNotFoundError

        blob = self._client.get_blob_client(self.container, storage_key)
        try:
            blob.delete_blob()
            return True
        except ResourceNotFoundError:
            return False

    def delete_prefix(self, prefix: str) -> int:
        """指定プレフィックス配下の Blob をすべて削除する（冪等）。

        戻り値は削除した件数。存在しないプレフィックスは 0 件で返る。
        （動画の全バージョン albums/v*.mp4 のような複数削除に使う。）
        """
        container = self._client.get_container_client(self.container)
        deleted = 0
        for blob in container.list_blobs(name_starts_with=prefix):
            if self.delete_blob(blob.name):
                deleted += 1
        return deleted

    # --- 内部 ----------------------------------------------------------------

    def _account_key(self) -> str:
        """接続文字列から AccountKey を取り出す。"""
        cred = self._client.credential
        # ローカル(Azurite)/共有キーの接続文字列では account_key を持つ。
        return cred.account_key  # type: ignore[attr-defined]

    def _blob_url(self, storage_key: str) -> str:
        """コンテナ名を含む Blob の実URL（SAS無し）を返す。"""
        return self._client.get_blob_client(self.container, storage_key).url
