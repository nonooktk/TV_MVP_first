"use client";

// サムネイル表示の共通コンポーネント（内製・v0.5.0 フィードバック改善 第2段）
//
// thumb_sas_url（幅320px サムネ）を優先表示し、読み込み失敗時（thumb 未生成の
// 過去データ等）は onError で原寸 sas_url へ自動フォールバックする。
// SAS はパス規約から導出されて発行され Blob の存在保証がないため、
// このフォールバックは契約上の前提（openapi.yaml v0.5.0）。
// 一覧系での帯域節約のため loading="lazy" を既定にする。

import { ImgHTMLAttributes, useEffect, useState } from "react";

interface ThumbImageProps
  extends Omit<ImgHTMLAttributes<HTMLImageElement>, "src" | "onError"> {
  /** サムネイル SAS URL（null なら最初から fallbackSrc を使う） */
  thumbSrc: string | null | undefined;
  /** 原寸（候補画像）SAS URL。thumb 失敗時のフォールバック先 */
  fallbackSrc: string;
  alt: string;
}

export default function ThumbImage({
  thumbSrc,
  fallbackSrc,
  alt,
  loading = "lazy",
  ...rest
}: ThumbImageProps) {
  const [src, setSrc] = useState(thumbSrc || fallbackSrc);

  // 一覧の再取得などで props の URL が変わったら表示もリセットする。
  useEffect(() => {
    setSrc(thumbSrc || fallbackSrc);
  }, [thumbSrc, fallbackSrc]);

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt={alt}
      loading={loading}
      onError={() => {
        // thumb が 404 等で読めない場合は原寸へ1回だけフォールバックする。
        if (src !== fallbackSrc) setSrc(fallbackSrc);
      }}
      {...rest}
    />
  );
}
