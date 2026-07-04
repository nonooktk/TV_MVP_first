# frontend

Next.js製の家族側スマホWebアプリ＋高齢者側待受ページ。Chrome限定。

## ページ構成とワイヤーフレームの対応

| パス | 対応WF | 担当 |
| --- | --- | --- |
| `src/app/page.tsx` | WF-04 発信ホーム | 内製 |
| `src/app/call/page.tsx` | WF-02 通話画面 | 委託コア①連携 |
| `src/app/select/page.tsx` | ベストショット選択（5枚） | 内製 |
| `src/app/album/page.tsx` | WF-05 閲覧（日付＋5枚一覧・拡大） | 内製 |
| `src/app/elder/register/page.tsx` | 初回ワンタイムリンク登録 | 内製 |
| `src/app/elder/standby/page.tsx` | WF-01 待受・着信「でる」・動画再生 | 内製（通話部分は委託コア①連携） |

## モジュール

`src/modules/` は委託コアモジュールの差し込み口。
- `call/`: 委託コア①（通話基盤）
- `detection/`: 委託コア②（検知キャプチャ）
- `sync/`: 委託コア③（通話後Blob同期・クライアント側）

## セットアップ

npm install / npm run dev は各自実行（本READMEでは手順記載のみ）。
