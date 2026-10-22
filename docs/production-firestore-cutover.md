# 本番Firestore切り替え・管理者を含む端末リセット

この手順は、厳格なFirestoreルールとCallable Functionsを本番へ反映し、端末登録情報を管理者分も含めて初期化した後、信頼できるCLIから最初の管理者を作り直すためのものです。**コードの変更やCI成功だけではFirebase本番は変更されません。**

## 対象データ

リセット対象は次の端末登録関連コレクションのみです。

- `terminals`
- `terminalOwners`
- `terminalInstallations`
- `devices`（端末別アプリ設定を含む）
- `terminalApplications`
- `terminalHandoffRequests`
- `terminalHandoffRateLimits`

イベント、チケット、受付履歴、分析、部員、イベント設定、公開済みイベントバンドルは削除対象外です。

## 実施順序

### 1. 本番プロジェクトとバックアップを確認

1. Firebase Consoleで対象プロジェクトIDを確認する。
2. Firestore本番データをエクスポートし、少なくとも上記7コレクションと業務データがバックアップに含まれていることを確認する。
3. バックアップの保存先と復元方法を確認する。
4. リセット後に管理者として使用するFirebase Auth UIDを確認する。UIDは、実際に管理画面へログインするアカウントの認証情報から独立して確認し、端末IDやUIDを推測しない。

### 2. Functionsをビルド・テストしてデプロイ

リポジトリのルートで依存関係とテストを確認し、対象プロジェクトを明示してデプロイする。

```sh
npm ci
npm --prefix functions ci
npm --prefix functions run typecheck
npm --prefix functions run build
firebase deploy --only functions --project YOUR_FIREBASE_PROJECT_ID
```

Functionsのデプロイに失敗した場合は先へ進まない。

### 3. Firestoreルールを切り替える

CIとルールテストが成功していることを確認した後、厳格なルールをデプロイする。

```sh
firebase deploy --only firestore:rules --project YOUR_FIREBASE_PROJECT_ID
```

本番ルールに期限付きの全許可ルールが残っていないことを確認する。Firestoreルールのallow条件はOR結合されるため、`match /{document=**} { allow read, write: if request.time < timestamp.date(2026, 11, 4); }` が残っていると、パス別の拒否ルールを迂回できる。全許可ルールを残してはならない。

この時点では管理者を含む端末登録情報がまだ残っている場合でも、リセットは実行しない。まずルールとFunctionsのデプロイ状態を確認する。

### 4. 端末登録情報の全消去をドライラン

```sh
gcloud auth application-default login
npm --prefix functions install
GCLOUD_PROJECT="YOUR_FIREBASE_PROJECT_ID" npm --prefix functions run reset:terminals
```

ドライラン結果のプロジェクトID・件数・対象コレクションを確認する。全消去モードでは管理者端末、所有者マッピング、インストールマッピングも消えるため、リセット後は管理者がゼロになる。

### 5. 管理者を含む端末登録情報をリセット

バックアップ、対象プロジェクト、ドライラン結果を再確認した後にのみ、明示的なフラグで実行する。

```sh
GCLOUD_PROJECT="YOUR_FIREBASE_PROJECT_ID" \
RESET_APPLY=true \
RESET_ALLOW_NO_ADMIN=true \
npm --prefix functions run reset:terminals
```

実行ログで7コレクションの削除件数を記録する。イベントやチケットなどの業務データはこのスクリプトの対象外。

### 6. 最初の管理者を作成

端末リセット後、通常運用を再開する前に、信頼できる管理端末の環境からではなく、管理されたCLI環境とFirebase Admin権限で管理者を作成する。ブラウザから呼び出せる初期管理者作成APIは使用しない。

まずドライランでプロジェクトID・新しい端末ID・確認済みAuth UIDを照合する。

```sh
GCLOUD_PROJECT="YOUR_FIREBASE_PROJECT_ID" \
BOOTSTRAP_ADMIN_TERMINAL_ID="T-REPLACE-WITH-NEW-ID" \
BOOTSTRAP_ADMIN_UID="REPLACE-WITH-VERIFIED-FIREBASE-AUTH-UID" \
npm --prefix functions run bootstrap:admin
```

出力内容を確認した後、同じコマンドに `BOOTSTRAP_ADMIN_APPLY=true` を追加して実行する。実行スクリプトは既存の競合データがある場合、上書きせず停止する。UIDは実際に管理画面へログインするアカウントと一致させる。

### 7. 再登録と動作確認

- 新しい管理者アカウントで管理画面にログインできる。
- 管理端末の承認状態、所有者UID、インストール対応表が一致する。
- 管理画面でイベント作成・編集・削除、チケット保存・公開ができる。
- 受付端末の新規申請・承認ができ、公開済みイベントの取得と受付記録が動作する。
- 未承認端末や古いインストールでは保護対象データへのアクセスが拒否される。
- すべての確認が済むまで通常運用を再開しない。

## ロールバック

リセット後に管理者作成やログインが失敗した場合は、一般運用を再開せず、Firebase Admin権限のある管理環境から原因を確認する。必要ならバックアップと確認済みのAuth UIDを使って復旧する。期限付き全許可ルールを復旧策として再追加しない。

## 実行状況

この文書とスクリプトの変更は、Firebase本番へのデプロイ、バックアップ、Firestore削除を実行したことを意味しません。本番作業はFirebase CLIまたはConsole上で、対象プロジェクトを照合して実行する必要があります。
