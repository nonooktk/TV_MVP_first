"use client";

// 初回ワンタイムリンク登録画面（内製）
// クエリ ?token=... を POST /devices/register に渡し、device_token を localStorage 保存後
// /elder/standby へ遷移する。失敗時は大きな文字でエラー表示する（高齢者側は文字を大きく）。

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ApiError, registerDevice, setDeviceToken } from "../../../lib/api-client";

export default function ElderRegisterPage() {
  // useSearchParams() は Suspense boundary 配下でのみ使用できるため分離する。
  return (
    <Suspense fallback={<div className="elder-shell" />}>
      <ElderRegisterPageInner />
    </Suspense>
  );
}

function ElderRegisterPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const token = searchParams.get("token");

  const [status, setStatus] = useState<"loading" | "error" | "done">("loading");
  const [message, setMessage] = useState<string>("とうろく しています…");

  useEffect(() => {
    if (!token) {
      setStatus("error");
      setMessage("とうろくリンクが みつかりません");
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await registerDevice(token);
        setDeviceToken(res.device_token);
        if (!cancelled) {
          setStatus("done");
          setMessage("とうろく できました");
          setTimeout(() => {
            if (!cancelled) router.push("/elder/standby");
          }, 1200);
        }
      } catch (e) {
        if (!cancelled) {
          setStatus("error");
          setMessage(
            e instanceof ApiError
              ? "とうろくに しっぱいしました（リンクの きげんぎれ かもしれません）"
              : "つうしんエラーが おきました"
          );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token, router]);

  return (
    <div className="elder-shell">
      <div style={{ fontSize: "6vw", fontWeight: 700 }}>{message}</div>
      {status === "error" && (
        <div style={{ marginTop: 24, fontSize: "2.5vw", color: "#ffb0a0" }}>
          かぞくの かたに れんらくして、もう いちど リンクを もらってください
        </div>
      )}
    </div>
  );
}
