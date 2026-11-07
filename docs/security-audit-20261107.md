# 隔離環境でのセキュリティ調査（2026年11月7日）

対象は QR-Ticket-System の管理・受付アプリ、Firestore のアクセス制御、印刷画面、依存部品。修正案は [PR #81](https://github.com/1453manamana5-web/QR-Ticket-System/pull/81)。

本番データへの攻撃、負荷送信、端末権限の変更は行っていない。公開ページには通常のヘッダー確認だけを実施した。攻撃を模した操作は、ループバック接続の Firestore エミュレーターと新規の一時ブラウザープロファイルで実行した。

## 確認したことと修正

| 項目 | 調査結果・対応 |
| --- | --- |
| 管理者への権限昇格 | 未認証、匿名認証、偽の admin claim、コピーした端末ID、受付用UIDからの権限変更を拒否。試験した範囲では管理権限の奪取経路は確認されなかった |
| イベント・記録の改ざん | 別イベントへの書き込み、他端末へのなりすまし、チケット情報の同時改ざん、余計な権限フィールド、失効済み承認、別UIDの承認、受付の再送を直接SDKから試験。原子的に拒否され、不完全な書き込みも残らないことを確認 |
| 登録データによる資源消費 | 未承認のUIDでも requestedAt/updatedAt に大きな文字列や空文字を保存できた。新規申請・端末作成に共通の検査を加え、日時文字列は1〜40文字、端末IDは1〜160文字に制限。既存の所有者・承認・役割の判定は保持 |
| スクリプト混入への防御 | 配信HTMLにCSPがなかった。ビルド時に、外部・インラインスクリプト、eval、埋め込みオブジェクト、baseタグ、フォーム送信を制限するCSPを追加。必要なFirebase通信、端末内画像・音声、サービスワーカーは許可 |
| 画面の埋め込み | 公開ページのCSP/X-Frame-Optionsヘッダーは未設定だった。アプリ起動時、別画面に埋め込まれていたら認証・アプリ処理を開始せず、別ウィンドウで開く案内だけを表示する。管理・受付・オフライン予備印刷、同一オリジン・別オリジン・sandbox付きiframeで試験 |
| 印刷データの改ざん | 印刷用文書にはスクリプトを全く許可しない別のCSPを追加。改ざんしたCSSからのscript挿入とHTMLのイベントハンドラーが実行されず、元画面のopener参照も渡さない。印刷ボタン・番号・QRの表示は維持 |
| 依存部品 | FirebaseのNode向け依存経路に古い @grpc/grpc-js 1.9.16 があった。修正済みの1.14.7へ固定。対象はNodeの通信部品で、公開ブラウザーからこのCVEを悪用できることが確認されたわけではない |

CSPは、混入の原因そのものを直す代わりではなく、実行を制限する追加の防御。今回の印刷改ざん試験は、端末内の保存データが改ざんされた場合の防御確認であり、外部の未承認ユーザーがその保存領域を書き換えられることを示したものではない。

## 試験結果

- 新規Firestore攻撃試験: 23件。修正前は、既存の権限境界・正常操作等の14件は成功し、登録データの上限不足を検査する9件が失敗した。
- 新規ブラウザー試験: 12件。修正前の配信物では、スクリプト制限と埋め込み拒否の9項目が満たされなかった。
- 修正後の手元の既存クライアント試験: **357件成功**。
- 修正後の手元の実ブラウザー試験: **12件成功**。印刷とQR画像の実デコード、実際の匿名認証クライアントに対するダミー応答も含む。
- アプリ・共通コード・Vite設定の型チェック、本番ビルド: 成功。
- アプリ側の `npm audit --omit=dev`: **既知の検出0件**。これは監査データベースに登録された問題の検査であり、未知の問題がないという意味ではない。
- 最終コミットのCI結果と公開反映は、本書末尾に記録する。

匿名認証の試験では、Googleのエンドポイントへの通信をブラウザーの経路で捕まえてダミー応答に置き換えている。実際のアカウントやトークンは使わず、Firestore宛の通信許可もダミー応答で検査している。エミュレーター用の新規試験は、FIRESTORE_EMULATOR_HOST がループバックの値でない限り起動しない。

## 今回だけでは対応しきれないこと

- GitHub Pagesでは任意のレスポンスヘッダーをアプリのファイルだけで設定できないため、HTTPヘッダーの `frame-ancestors 'none'` による保護は追加していない。今回の埋め込み拒否はJavaScriptによる補助策。将来、ヘッダーを設定できる配信先やプロキシへ移す場合は、ヘッダー側でも拒否する。
- 登録データの大きさは制限したが、大量の小さい要求の回数制限にはなっていない。匿名認証や申請への大量アクセス対策は、App Check、回数制限、監視などの別設定を含めて継続検討が必要。
- GitHubアカウント、端末そのもの、管理者の認証情報の窃取・不正利用は、このコード試験で完全に防げる対象ではない。GitHub/IAMの認証設定や実際のアカウント侵害の有無は今回調査していない。
- iPad/Safari実機、カメラの実映像、実回線切断、本番の認証情報を使った試験は今回の対象外。
- 広い範囲で共有する前にルールを引き続きレビューする必要がある。すべての攻撃や乗っ取りを防げるという保証ではない。

ルール変更のレビュー注記:

> I've set up prototype Security Rules to keep the data in Firestore safe. They are designed to be secure for rejecting oversized terminal registrations while retaining the existing server-verified owner and role checks. However, you should review and verify them before broadly sharing your app. If you'd like, I can help you harden these rules.

## 再実行

通常のクライアント試験は `npm run test:client`。隔離したFirebase試験はJavaが使える環境で `npm run test:rules` と `npm run test:callables`。ブラウザー試験は `npm run build` の後に `npm run test:security:browser` を使う。Linuxでは事前に `npx playwright install --with-deps chromium` を実行する。Windowsの手元試験は新規プロファイルのheadless Edgeを使う。CIにもブラウザー攻撃試験を追加した。

## 根拠資料

- [Firebase: Security Rulesの条件とgetAfter](https://firebase.google.com/docs/firestore/security/rules-conditions)
- [OWASP: CSPとmetaタグの制約](https://cheatsheetseries.owasp.org/cheatsheets/Content_Security_Policy_Cheat_Sheet.html)
- [OWASP: Clickjacking対策とHTTPヘッダー](https://cheatsheetseries.owasp.org/cheatsheets/Clickjacking_Defense_Cheat_Sheet.html)
- [gRPCの認証コンテキストに関する修正](https://github.com/advisories/GHSA-m9gg-hp2v-232j)、[エラーメッセージに関する修正](https://github.com/advisories/GHSA-f596-whhp-79r4)

最終状態: 公開前の最終CIを確認中。
