// 認証エラーの可視化・復旧ヘルパーの単体テスト（サインイン不具合の原因特定用）。
//
// formatAuthError / isInteractionInProgressError は純粋関数。
// clearMsalInteractionState は sessionStorage / localStorage を触るため、
// node 環境向けに最小の Storage 実装を globalThis.window へ差し込んで検証する。

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearMsalInteractionState,
  formatAuthError,
  isInteractionInProgressError,
} from "../src/lib/auth";

describe("formatAuthError", () => {
  it("MSAL エラー（name / errorCode / errorMessage）を全文まとめて整形する", () => {
    const err = {
      name: "ServerError",
      errorCode: "invalid_grant",
      errorMessage:
        "AADSTS9002313: Invalid request. Request is malformed or invalid.",
    };
    const out = formatAuthError(err);
    expect(out).toContain("ServerError");
    expect(out).toContain("code=invalid_grant");
    // AADSTS コードが取りこぼされないこと（原因特定の要）。
    expect(out).toContain("AADSTS9002313");
  });

  it("標準 Error は name と message を残す", () => {
    const out = formatAuthError(new Error("何かが壊れました"));
    expect(out).toContain("Error");
    expect(out).toContain("何かが壊れました");
  });

  it("文字列はそのまま返す", () => {
    expect(formatAuthError("生の文字列エラー")).toBe("生の文字列エラー");
  });

  it("null / undefined は既定メッセージを返す", () => {
    expect(formatAuthError(null)).toBe("不明なエラー");
    expect(formatAuthError(undefined)).toBe("不明なエラー");
  });
});

describe("isInteractionInProgressError", () => {
  it("errorCode が interaction_in_progress なら true", () => {
    expect(
      isInteractionInProgressError({ errorCode: "interaction_in_progress" })
    ).toBe(true);
  });

  it("別の errorCode や非エラー値は false", () => {
    expect(isInteractionInProgressError({ errorCode: "invalid_grant" })).toBe(
      false
    );
    expect(isInteractionInProgressError(new Error("x"))).toBe(false);
    expect(isInteractionInProgressError(null)).toBe(false);
    expect(isInteractionInProgressError("interaction_in_progress")).toBe(false);
  });
});

describe("clearMsalInteractionState", () => {
  // node 環境向けの最小 Storage 実装。
  class FakeStorage {
    private map = new Map<string, string>();
    get length(): number {
      return this.map.size;
    }
    key(i: number): string | null {
      return Array.from(this.map.keys())[i] ?? null;
    }
    getItem(k: string): string | null {
      return this.map.get(k) ?? null;
    }
    setItem(k: string, v: string): void {
      this.map.set(k, v);
    }
    removeItem(k: string): void {
      this.map.delete(k);
    }
    clear(): void {
      this.map.clear();
    }
  }

  let session: FakeStorage;
  let local: FakeStorage;

  beforeEach(() => {
    session = new FakeStorage();
    local = new FakeStorage();
    (globalThis as unknown as { window?: unknown }).window = {
      sessionStorage: session,
      localStorage: local,
    };
  });

  afterEach(() => {
    delete (globalThis as unknown as { window?: unknown }).window;
  });

  it("msal. で始まり interaction を含むキーだけを消す", () => {
    session.setItem("msal.interaction.status", "interaction_in_progress");
    session.setItem("msal.account.keys", "keep");
    session.setItem("other.interaction.flag", "keep");
    local.setItem("msal.xxx.interaction.status", "interaction_in_progress");
    local.setItem("msal.token.cache", "keep");

    clearMsalInteractionState();

    // interaction 関連は削除。
    expect(session.getItem("msal.interaction.status")).toBeNull();
    expect(local.getItem("msal.xxx.interaction.status")).toBeNull();
    // それ以外（アカウント・トークン・他社キー）は温存。
    expect(session.getItem("msal.account.keys")).toBe("keep");
    expect(session.getItem("other.interaction.flag")).toBe("keep");
    expect(local.getItem("msal.token.cache")).toBe("keep");
  });

  it("window 不在（SSR/ビルド時）でも例外を投げない", () => {
    delete (globalThis as unknown as { window?: unknown }).window;
    expect(() => clearMsalInteractionState()).not.toThrow();
  });
});
