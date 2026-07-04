# FFmpeg 定型コマンド仕様書

支給物A10。ワーカー第2段（`worker/stages/stage2_video.py`）で、確定したベスト5枚（JPEG）＋
BGM（支給音源）から30秒のハイライト動画（MP4）を生成するための定型コマンドを定義する。

## 1. 目的と適用範囲

- 通話後パイプライン第2段は、家族が選択した5枚の静止画（JPEG）とBGM音源から、
  30秒のハイライト動画（静止画スライドショー。実映像クリップは扱わない）を生成する。
- 本書は、そのFFmpeg実行コマンドを固定する定型仕様書である。
- 出力パスは `docs/data-contract.md` のパス規約に準拠する: DB（`albums.video_storage_key`）には
  コンテナ名 `media` を除いたフルパス `families/{family_id}/calls/{call_id}/albums/v{version}.mp4`
  を格納し、実体のBlob格納・ローカル一時生成パスもこれに従う。

## 2. 前提

| 項目 | 値 |
| --- | --- |
| FFmpeg バージョン | 6系（`ffmpeg -version` で `ffmpeg version 6.x` を確認） |
| 入力（画像） | `photo1.jpg` 〜 `photo5.jpg`（家族が選択したベスト5枚。順序=表示順） |
| 入力（音声） | `bgm.mp3`（`worker/assets/bgm/` の支給音源。A12） |
| 出力 | `v{version}.mp4`（解像度 1920x1080・映像 H.264 / yuv420p・音声 AAC 128k・30fps・尺 約30秒） |

- 画像の縦横比は端末・撮影状況によりまちまちであるため、**アスペクト比を保ったまま
  1920x1080にレターボックス化**する（`scale` + `pad`）。引き伸ばしによる歪みは発生させない。
- 出力ファイル名の `{version}` は `albums.version`（int）と一致させる。再生成時は上書きせず
  新しい `v{version}.mp4` を新規作成する（`docs/data-contract.md` 参照）。

## 3. 基本形（クロスフェード版）

各画像を約7秒表示し、隣接する画像同士を1秒のクロスフェード（`xfade`）でつなぐ。5枚・
4回のクロスフェードで合計出力尺は約31秒になり、最終的に `-t 30` で30秒に固定する。
BGMは30秒に整え、末尾2秒をフェードアウトする。

### 3.1 offset計算（xfadeの累積計算）

`xfade` の `offset` は「それまでの累積クリップ（1本目の入力）の先頭からの、フェード開始位置（秒）」
であり、`offset = 直前までの累積出力長 − フェード長` で求める。各画像クリップは
`-t 7 -loop 1`（7秒）で用意し、フェード長は1秒とする。

| ステップ | 直前までの累積長 | offset | 処理後の累積長（= 累積長 + 7 − 1） |
| --- | --- | --- | --- |
| xfade 1（photo1→photo2） | 7 | 6 | 13 |
| xfade 2（→photo3） | 13 | 12 | 19 |
| xfade 3（→photo4） | 19 | 18 | 25 |
| xfade 4（→photo5） | 25 | 24 | 31 |

→ 4回のxfade後、映像の合計尺は **31秒**。最終出力は `-t 30` で30秒に切り詰める
（末尾1秒は5枚目の表示末尾が削れるのみで、クロスフェード自体には影響しない）。

### 3.2 完全な実行コマンド

```bash
ffmpeg -y \
  -loop 1 -t 7 -i photo1.jpg \
  -loop 1 -t 7 -i photo2.jpg \
  -loop 1 -t 7 -i photo3.jpg \
  -loop 1 -t 7 -i photo4.jpg \
  -loop 1 -t 7 -i photo5.jpg \
  -i bgm.mp3 \
  -filter_complex "\
[0:v]scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p,fps=30[v0]; \
[1:v]scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p,fps=30[v1]; \
[2:v]scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p,fps=30[v2]; \
[3:v]scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p,fps=30[v3]; \
[4:v]scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p,fps=30[v4]; \
[v0][v1]xfade=transition=fade:duration=1:offset=6[x1]; \
[x1][v2]xfade=transition=fade:duration=1:offset=12[x2]; \
[x2][v3]xfade=transition=fade:duration=1:offset=18[x3]; \
[x3][v4]xfade=transition=fade:duration=1:offset=24[vout]; \
[5:a]atrim=0:30,afade=t=out:st=28:d=2,asetpts=PTS-STARTPTS[aout]" \
  -map "[vout]" -map "[aout]" \
  -t 30 \
  -c:v libx264 -pix_fmt yuv420p -r 30 \
  -c:a aac -b:a 128k \
  -shortest \
  v{version}.mp4
```

**各パートの説明**

- `-loop 1 -t 7 -i photoN.jpg`: 各静止画を7秒のクリップとして読み込む（`-loop 1` は静止画を
  映像ストリーム化するための必須オプション）。
- `scale=1920:1080:force_original_aspect_ratio=decrease`: 縦横比を保ったまま1920x1080に
  収まる最大サイズへ縮小拡大する（歪みなし）。
- `pad=1920:1080:(ow-iw)/2:(oh-ih)/2`: scale後の画像を1920x1080キャンバス中央に配置し、
  余白を黒でレターボックス化する。
- `setsar=1`: サンプルアスペクト比を1:1に固定する（表示比の崩れ防止）。
- `format=yuv420p`・`fps=30`: 各クリップの時点でピクセルフォーマットとフレームレートを
  出力仕様に揃えておく（`xfade` はフォーマット・fpsが揃っていないと失敗するため）。
- `xfade=transition=fade:duration=1:offset=N`: 1秒のクロスフェード（ディゾルブ）で
  前段の出力と次の画像クリップをつなぐ。`offset` は3.1の計算値を使用する。
- `[5:a]atrim=0:30`: BGM（6番目の入力＝index 5）を30秒にトリムする（BGM素材が30秒未満の場合は
  事前にループ結合してから渡す。4章参照）。
- `afade=t=out:st=28:d=2`: 28秒地点から2秒かけてフェードアウトする（30秒尺の末尾2秒）。
- `-map "[vout]" -map "[aout]"`: フィルタ出力の映像・音声のみを出力にマップする
  （入力の音声トラック等を誤って拾わないため）。
- `-t 30`: 出力尺を30秒に固定する（xfade後の映像は31秒になるため、ここで切り詰める）。
- `-c:v libx264 -pix_fmt yuv420p -r 30`: H.264・yuv420p・30fpsで出力する。
- `-c:a aac -b:a 128k`: AAC 128kbpsで出力する。
- `-shortest`: 映像・音声のどちらかが短い方に合わせて終了する（30秒ぴったりに揃っていれば
  実質的に効果はないが、丸め誤差による尺のずれを防ぐ保険として付与する）。

## 4. BGM素材が30秒未満の場合の下ごしらえ（事前ステップ）

支給されるBGM素材（A12）が30秒に満たない場合は、3章のコマンドを実行する前に
BGMをループ結合して30秒以上に伸ばしておく。

```bash
ffmpeg -y -stream_loop -1 -i bgm.mp3 -t 30 -c copy bgm_30s.mp3
```

- `-stream_loop -1`: 入力を無限ループする。
- `-t 30`: 30秒でカットする。
- 生成した `bgm_30s.mp3` を3章・5章のコマンドの `bgm.mp3` の代わりに使用する。

## 5. 簡易フォールバック版（xfade無し・concatデマルチプレクサ）

クロスフェード版でエラーが出た場合や、原因切り分けのためにまず映像だけを素早く
組み立てたい場合のフォールバック手順。xfadeの `filter_complex` を使わず、
**concatデマルチプレクサ**（リストファイル方式）でつなぐため構造が単純でデバッグしやすい。
各画像は6秒表示（xfadeの重なり分がないため、5枚×6秒=30秒ちょうど）。

### 5.1 ステップ1: 画像から個別クリップを生成し、リストファイルでconcat

まず各画像をレターボックス化した6秒クリップに変換する。

```bash
for i in 1 2 3 4 5; do
  ffmpeg -y -loop 1 -t 6 -i photo${i}.jpg \
    -vf "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p" \
    -r 30 -c:v libx264 -pix_fmt yuv420p \
    clip${i}.mp4
done
```

次に、つなぐ順序を記述したリストファイル `concat_list.txt` を作成する。

```
file 'clip1.mp4'
file 'clip2.mp4'
file 'clip3.mp4'
file 'clip4.mp4'
file 'clip5.mp4'
```

concatデマルチプレクサで映像のみを結合する（`-c copy` で再エンコードなし・高速）。

```bash
ffmpeg -y -f concat -safe 0 -i concat_list.txt -c copy video_only.mp4
```

### 5.2 ステップ2: BGMをミックスして最終出力

```bash
ffmpeg -y -i video_only.mp4 -i bgm.mp3 \
  -filter_complex "[1:a]atrim=0:30,afade=t=out:st=28:d=2,asetpts=PTS-STARTPTS[aout]" \
  -map 0:v -map "[aout]" \
  -t 30 \
  -c:v libx264 -pix_fmt yuv420p -r 30 \
  -c:a aac -b:a 128k \
  -shortest \
  v{version}.mp4
```

- ステップを2つに分けることで、「画像の並び・レターボックスが正しいか」と
  「BGMのトリム・フェードが正しいか」を個別に確認できる。障害時の切り分けに有効。
- BGM素材が30秒未満の場合は4章の下ごしらえを先に行う。

## 6. 注意事項

- **タイトル・キャプションは動画に焼き込まない**。閲覧UI（`frontend/src/app/album/`）側で
  テキスト表示する。`drawtext` フィルタでの焼き込みは、フォント配布（サーバー環境での
  日本語フォント同梱）の問題が発生するため採用しない。焼き込みが必要になった場合は
  発注側と協議する。
- 出力は `docs/data-contract.md` のパス規約に従い、`families/{family_id}/calls/{call_id}/albums/v{version}.mp4`
  に保存する（`{version}` は `albums.version` と一致させ、再生成時は上書きせず新規作成する）。
- **`-shortest` と `-t 30` の両方を指定**し、映像・音声いずれの側の丸め誤差が生じても
  出力尺が30秒を超えないようにする。
- **`yuv420p` は必須**（`format=yuv420p` によるフィルタ内指定と `-pix_fmt yuv420p` の
  両方を明記する）。`yuv444p` 等ではブラウザ（Chrome）のネイティブ再生と互換性がない
  場合があるため。
- 入力画像の解像度・向き（縦/横）が5枚でバラバラでも、`scale` + `pad` により
  1920x1080に統一されるため個別対応は不要。
- 本書のコマンドは仕様として机上で整合性を確認したものであり、実行検証は行っていない。
  実装時は少数サンプルで動作確認のうえ、パイプライン（`stage2_video.py`）に組み込むこと。
