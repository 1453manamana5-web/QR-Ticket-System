# 本番Firestore切り替え・端末リセット手順

この手順は `secure-terminal-handoff-mainline` ブランチの `firestore.rules` と Functions を本番へ反映し、管理者端末以外の登録をリセットするための手順書です。**この文書を追加しただけでは本番Firebaseは変更されません。**

## 絶対条件

- 対象プロジェクトIDをFirebase Consoleで確認し、作業中も照合する。
- 本番データのバックアップを取得し、復元可能なことを確認する。
- 保持する管理者端末IDと、その端末の正しいFirebase Auth UIDを、実際に使用する同じSafari／ホーム画面アプリの認証状態から確認する。
- `terminals/{terminalId}` が `admin: true`、`approved: true`、`managementApproved: true`、`role: "management"` または `"both"` であり、所有者・インストール対応表が同じ端末ID／UIDを指していることを確認する。
- 管理者端末を確定できない場合は**リセットもルール切り替えも実行しない**。現在見えている端末名だけを根拠に管理者を推測しない。

## 実施順序

### 1. バックアップと対象確認

1. Firebase ConsoleでプロジェクトIDを確認する。
2. Firestoreの本番データをエクスポートする（少なくとも `events`、`eventBundles`、`devices`、`terminals`、`terminalOwners`、`terminalInstallations`、`terminalApplications`、`terminalHandoffRequests`、`terminalHandoffRateLimits`）。
3. エクスポート完了と保存先を確認する。イベント、チケット、受付記録、分析、部員、設定は端末リセットの対象にしない。

### 2. 管理者の信頼マッピングを先に準備

本番の既存データが旧形式なら、`functions/scripts/migrate-terminal-owners.ts` の create-only 移行を使い、確認済みの管理者端末IDとUIDの組を登録する。まず必ずドライランで出力を確認し、プロジェクトID・端末ID・UID・既存の承認状態がすべて一致する場合だけ本実行する。

例（値は実際に確認したものへ置き換える）。ドライランでは書き込みは発生しない。

\`\`\`sh
gcloud auth application-default login
npm --prefix functions install
npm --prefix functions run build:migration
GCLOUD_PROJECT="YOUR_FIREBASE_PROJECT_ID" \\\
TERMINAL_OWNER_MIGRATION_JSON='[{"terminalId":"T-REPLACE","ownerUid":"UID-REPLACE"}]' \\\
node functions/lib-migration/scripts/migrate-terminal-owners.js
\`\`\`

本実行する場合は、別途確認後に同じコマンドへ \`MIGRATION_APPLY=true\` を追加する。\`MIGRATION_DRY_RUN=true\` が設定されている場合は \`MIGRATION_APPLY=true\` でもドライランのままになる。

この段階で管理者端末が未承認・不明・競合状態なら、先に進まない。端末リセットを先に実行すると管理者の復旧経路まで失う可能性がある。

### 3. Functionsを先にデプロイ

リポジトリのルートで、確認済みの本番プロジェクトを明示して実行する。

```sh
firebase use --add
firebase deploy --only functions --project YOUR_FIREBASE_PROJECT_ID
```

デプロイ後、端末状態確認、受付記録、端末承認・削除、イベント削除の callable が正常にデプロイされていることを確認する。失敗した場合はルール切り替えへ進まない。

### 4. Firestoreルールを切り替える

エミュレーターのルールテストとCIが成功していることを確認してから、次を実行する。

```sh
firebase deploy --only firestore:rules --project YOUR_FIREBASE_PROJECT_ID
```

既存の期限付き全許可ルール `match /{document=**} { allow read, write: if request.time < timestamp.date(2026, 11, 4); }` は、パス別ルールとOR結合されるため残してはいけない。**全許可ルールを残したままパス別ルールを追加しても安全にはならない。**

切り替え直後に、保持した管理者端末で管理アプリへアクセスできること、イベント／チケットを読み書きできること、未承認端末が拒否されることを確認する。ここで失敗した場合はリセットを実行せず、復旧する。

### 5. 端末登録情報のドライラン

バックアップ・管理者マッピング・ルール・Functionsを確認後、リポジトリのルートで次を実行する。実際の値に置き換える。

```sh
gcloud auth application-default login
npm --prefix functions install
npm --prefix functions run reset:terminals -- --help
```

スクリプトは `RESET_APPLY` が `true` でなければ削除しない。環境変数でプロジェクトID、保持する管理者端末ID、保持する管理者UIDを指定してドライランし、削除件数と保持対象を確認する。CLI引数の `--help` はスクリプトの対応状況を確認するためのものであり、削除を実行するものではない。

> 注意：このリセットは他の端末登録だけでなく、`devices` コレクション内の端末別アプリ設定も削除対象にする。イベント・チケット・受付記録・分析・部員・イベント設定・公開済みイベントバンドルは対象外。

### 6. 内容を確認してからリセットを実行

ドライランの対象件数を確認し、保持する管理者端末IDとUIDが正しいことを別途確認した後にのみ、同じ環境変数に `RESET_APPLY=true` を加えて実行する。実行後、出力された削除件数を記録する。

### 7. 再登録と動作確認

- 保持した管理者端末から管理画面を開ける。
- ほかの管理端末／受付端末は、古い承認が復活せず、新しい申請・承認フローを通る。
- 管理端末からイベント作成、チケット保存、公開、イベント削除ができる。
- 受付端末は承認後に公開済みイベントを取得でき、受付記録はサーバー callable 経由で記録される。
- 端末を削除・解除した後、古いUIDや古いインストールでアクセスが拒否される。
- すべての確認が済むまで本番運用を再開しない。

## ロールバック方針

ルール切り替え後に管理者がアクセスできなくなった場合、端末リセットを行わず作業を停止する。バックアップと確認済みの管理者ID／UIDを使い、Firebase Consoleから安全に復旧する。期限付き全許可ルールを再追加することを恒久的な復旧策にしない。

## この手順で実施していないこと

この文書は手順の定義のみであり、Firebase本番データのエクスポート、Functionsデプロイ、Firestoreルールのデプロイ、端末情報の削除は実行していない。
