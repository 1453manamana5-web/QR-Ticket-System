# 操作アニメーションと使いやすさ（2026-11-05）

## 調査と方針

AppleのHIG Motion、WWDC23「Animate with springs」、WWDC24「Enhance your UI animations and transitions」を一次資料として確認した。実装担当と使いやすさ監査担当を分け、管理・受付の既存操作に適用した。

- [HIG Motion](https://developer.apple.com/design/human-interface-guidelines/motion): 動きは状態・操作の理解を助け、反復する操作を煩雑にしない。
- [WWDC23 Animate with springs](https://developer.apple.com/videos/play/wwdc2023/10158/): 位置・速度の連続性、割り込み、自然な停止。springは大きなバウンドだけを意味しない。
- [WWDC24 Enhance your UI animations and transitions](https://developer.apple.com/videos/play/wwdc2024/10145/): 遷移中にも操作できる設計と、一時的な遷移状態の最小化。

このWeb実装はSwiftUI/UIKitの移植ではない。押下65ms・解放190ms・通常縮小率.98などは本アプリ向けの調整値であり、Apple指定の数値ではない。

## 適用範囲

`shared/src/controlMotion.css`を両アプリで読み込み、クラスを持たないボタンを含むnative button、button相当リンク、送信ボタン、チェック・ラジオ、select、ファイル選択を対象にする。小さな押下・戻りと状態色・フォーカスの変化を揃える。hoverの拡大はマウスなど精密ポインターだけに限定する。

固定配置や回転を壊さないよう、押下には独立したCSS `scale` を使用する。既存の二重縮小を整理し、受付の回転切り替えは専用ルールを使う。デザインの拡大縮小・回転ハンドル、サイドバーのドラッグハンドルには汎用の縮小・移動を適用せず、指の操作を維持する。操作の実行をアニメーション完了まで待たせる処理、全ボタンへのイベントリスナー、常時描画ループは追加しない。

設定はラベル全体で操作できるnative checkboxのswitchにし、ノブを移動させる。編集ツールには選択・展開状態を付ける。小さい閉じる操作はタッチ端末で44 CSS px以上にする。ファイル選択はnative inputを残し、キーボードからも操作可能にする。

部員・デザイン画面にも既存のSurfacePresenceを適用し、閉じ途中はinert・aria-hiddenにする。ガイドは閉じ途中や非表示の画面を対象に選ばず、Tab移動からも除外する。OSの動きを減らす設定を閉じ途中で変更しても追従し、待機タイマーを解除する。

## 制約と確認

無効・処理中のボタンは押し込みを維持しない。Reduced Motion・強制カラー・印刷に専用ルールを用意する。QR読み取り・カメラ・音声・オフライン保存・Firebase権限の処理はアニメーションを理由に待たせない。

自動確認はボタンの選択状態、ガイドの対象選択、ドラッグガード、終了タイマー・設定変更、既存のチケット編集・印刷・受付・オフラインを対象にする。実際のiPadでのフレームレートや指で触った感覚、Safariの描画結果は自動テストの保証対象外。
