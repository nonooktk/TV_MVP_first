# backend

FastAPIによるAPIサーバー。

## 役割

トークン発行、着信状態管理、メディア登録、候補提示、選択確定、ハイライト取得、SAS発行を担う。

## 起動方法

```
uvicorn app.main:app --reload
```

（依存関係は各自 `pip install -r requirements.txt` で導入。本READMEでは手順記載のみ）

## 担当区分

委託コア①③（通話トークン発行・通話後パイプライン連携部分）。
API仕様は `docs/api/openapi.yaml` を正とする。
