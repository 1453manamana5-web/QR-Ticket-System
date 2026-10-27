# Firebase構成の調査と復旧（2026-10-25）

> 2026-10-27確認: main `1840f841` の[Rulesデプロイ run 40174644626](https://github.com/1453manamana5-web/QR-Ticket-System/actions/runs/40174644626)は成功し、`qr-ticket-system-5ba69` のRelease/Ruleset検証ログも確認できた。以下の403は過去の障害。今回の受付修正と確認範囲は [firebase-reception-check-20261027.md](firebase-reception-check-20261027.md) を参照。

## 確認できた状態

対象: 1453manamana5-web/QR-Ticket-System
調査元: main の 791399017183e2b7d662c5559bcfd4df9b2e97de
デプロイ先としてコードに指定されているプロジェクト: qr-ticket-system-5ba69

- Pages公開・通常の型チェックとビルドは成功。
- Firestoreデプロイ run 40088469486 はルールテストとビルドを通過した後、HTTP 403で失敗。
- 不足権限は firebaserules.rulesets.create。秘密鍵の欠落やルール構文エラーではない。
- 実際の本番ルール、Firebase料金プラン、デプロイ済みFunctions、Auth設定、端末マッピングは未確認。GitHubの成功だけで本番反映済みとは判断できない。

## 現在のアプリが使う構成

管理・受付はFirebase匿名認証とFirestore SDKを使う。端末登録、承認、モード制御、受付記録は直接Firestoreへ書く。functions/には別のサーバー方式の実装があるが、現在の画面が使うCallableは全データ初期化の resetAllProductionData のみ。Firebase HostingではなくGitHub Pagesへ公開している。

FunctionsのREADMEにある「すべてCallable経由」という説明は現行フロントエンドと一致していない。Spark対応のルールデプロイとFunctionsデプロイを同じ成功条件にしない。Functionsが必要な全データ初期化は、Functionsのデプロイ・料金プランを別途確認する必要がある。この調査では初期化を実行しない。

## この修正

- 両アプリは認証の初期状態復元を待ってから匿名サインインする。承認済みUIDの復元中に新規サインインを始めない。
- Callableは既存のFirebase Appを共用し、両アプリとも認証完了を待つ。
- 受付の申請取り消しは自分の未承認端末と申請を同じトランザクションで削除し、同じ端末IDでの再申請を可能にする。承認済み端末・他人の端末の削除は不可。
- 受付の端末申請は申請文書と未承認端末文書を1バッチで作る。現行承認処理が必要とする端末文書の欠落を防ぐ。
- 承認済み受付は receptionTarget == true で検索するイベントを読める。全イベント列挙は不可。
- 承認済み受付は公開対象かつ未終了イベントのチケットだけを取得できる。オフライン受付に必要な Ticket.basicInfo も端末へダウンロードされる。受付端末として承認する相手を管理すること。
- 管理端末はイベント削除時に受付履歴を削除できる。受付による履歴の変更・削除は禁止。
- Rulesデプロイとバックエンドデプロイの同時実行を同じconcurrencyグループで直列化。
- 回帰テストを追加。既存の包括的なルール監査・本番実機テストの代わりにはならない。

## IAMの復旧

1. GitHub Actionsの FIREBASE_SERVICE_ACCOUNT に設定したJSONの client_email を管理者の環境で確認する。秘密鍵やJSON全体をチャット・リポジトリへ貼らない。
2. Google Cloud Console の対象プロジェクト qr-ticket-system-5ba69 の IAM 画面で、そのメールアドレスに Firebase Rules Admin（roles/firebaserules.admin）を付与する。サービスアカウントが別プロジェクト発行でも、権限付与先はこの対象プロジェクト。
3. 修正をレビューして main へ取り込む。既存端末の terminalInstallations、terminalOwners、terminals の対応を確認する。対応が欠けている場合は厳格ルール反映前に信頼できる管理環境から移行を計画する。
4. Deploy Firestore rules (Spark-compatible) を実行する。プロジェクト・Release・Rulesetの検証成功ログまで確認する。
5. 管理者起動、受付端末の申請・承認、公開イベント取得、オフライン受付、再接続時の入場/退場/再入場同期、権限解除、履歴ありイベント削除を実機確認する。

IAM不足はFirestoreの全許可ルールを追加しても解決しない。この修正はデータリセットを必要としない。

公式資料:
- https://docs.cloud.google.com/iam/docs/roles-permissions/firebaserules
- https://firebase.google.com/docs/reference/js/auth.auth#authauthstateready

## ルールのレビュー範囲

I've set up prototype Security Rules to keep the data in Firestore safe. They are designed to be secure for approved reception terminals downloading only selected event data while denying unapproved clients and keeping management operations restricted. However, you should review and verify them before broadly sharing your app. If you'd like, I can help you harden these rules.

全体を安全と保証するスコアは付けない。既存の管理者書き込みには業務データの詳細なスキーマ検証が未実装であり、Ticket.basicInfo は任意フィールドを持つ。今回のテスト対象は変更した境界と既存の端末権限制御。
