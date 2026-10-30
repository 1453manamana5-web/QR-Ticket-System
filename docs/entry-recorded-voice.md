# 入口受付の録音音声

入口・再入場の成功時は、選択済みのDの声で「お進みください。」を再生する。
出口は従来の「ご来場ありがとうございました。」の端末音声を維持する。
読取音・成功音・エラー音は既存の音源を維持する。

音声案内がオフ、または音量が0の場合は再生しない。成功音だけをオフにしても、
音声案内がオンなら録音音声は再生する。エラーや次の案内では前の案内を停止する。

オンラインで受付アプリを更新してからオフライン運用する。録音音源は受付の
Service Workerの事前保存対象。既存と同じHTMLAudioを操作時に準備し、端末に
保存した音源はBlob URLで再生する。端末の音声合成や外部APIは入口では使わない。

確認: 受付アプリの「音声を有効にして確認」を押す。この操作で音声案内をオンにし、
音量が0の場合だけ70%へ戻してDの声を試聴する。既存の成功音設定は維持する。
設定はその受付端末内へ保存される。設定画面にも同じボタンがある。
「受付結果を試験表示」→「入口結果」「出口結果」でもそれぞれ確認できる。
再生が拒否された場合や消音時は画面に案内を表示する。

音源: reception-app/public/sounds/entry_osusumi_voice_d_v1.mp3
元サンプル: 04_voice_D.mp3（バイト列を変更せず収録）
SHA-256: db8b652a46de3cc1aa09de6703722c558f4ecabf2bcad56a0de6817e6889cce5
生成方法・出典: reception-app/public/sounds/entry_voice_credits.txt

自動確認: 入口・再入場・出口の振り分け、音量と音声案内設定、タップ時の準備、
エラー時の停止、古い出口音声の遅延防止、オフラインのBlob再生と事前保存、音源の同一性。

## iPadで音声が出ない問題の修正

成功音と録音音声を同時に別々のAudio要素で鳴らす処理を廃止した。
入口の成功音がオンなら、成功音とDを一つにしたentry_success_voice_d_v1.mp3を
一度だけ再生する。成功音は元音源を35%の音量で使い、Dは220ms後から重ねる。
Dのみの元ファイルも保持し、成功音がオフならこちらを使う。

全ての録音音源に、ユーザー操作で有効化する一つのHTMLAudio要素を再利用する。
ダウンロード完了のコールバックでは再生元を切り替えず、再生中の声を中断しない。
Service Worker v7で両方の音声を事前保存する。準備に失敗した音源は次の操作で再試行する。

Safariのユーザー操作とメディア要素の扱いはApple/WebKitの資料を参照した。
古い資料の同時再生制約が全ての現行iPadにそのまま当てはまると断定はしない。
iPad実機での再生確認は利用者側で必要。
https://developer.apple.com/library/archive/documentation/AudioVideo/Conceptual/Using_HTML5_Audio_Video/Device-SpecificConsiderations/Device-SpecificConsiderations.html
https://bugs.webkit.org/show_bug.cgi?format=multiple&id=134925
