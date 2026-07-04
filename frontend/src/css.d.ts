// CSS side-effect import 用の型宣言。
// 環境依存（TypeScript 6系 + Next.js 14.2.0 の組み合わせ）で next 標準の
// CSS モジュール型解決が効かない事象を確認したため、プロジェクト側で明示する。
declare module "*.css";
