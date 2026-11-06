# UX-mobile PoC：本人用の限定手動試験

根拠は [research](research.md)。配備URL・版・担当・試験結果の正本は [TASKS](../../TASKS.md)。本書は手順と報告テンプレートであり、別の進捗表ではない。Android実測は本人がこれから行う。iOSは任意の別試験・未検証。

## 1. 安全条件と準備

- **署名・送金・chain追加／切替・静止画取得・録画・uploadは一切しない。** 署名、Spending cap、送金画面が出たら承認せず終了し、統合担当へ報告する。
- camera previewは映像を端末で表示する試験。本人が許可し、無地の紙など非私的な対象だけを映す。人物・文書・秘密画面を映さず、写真／スクリーンショットを報告に添付しない。
- 操作は本人のみ。AgentのADB、Wallet操作、権限付与、ブラウザ自動操作は使わない。
- 本人所有のPC Chrome＋MetaMask拡張、Android＋MetaMask、標準カメラ、本人が普段使う外部QRリーダー1種類を使う。新規QRアプリの導入は不要。
- 未導入ケースは既にMetaMaskのない別環境がある場合だけ。既存Walletをアンインストール・初期化したり、データを消したりしない。
- 統合担当が独立HTTPS URL・対象版・下記UIを確認してから開始する。対象版を途中で変えない。本番の寄付や既存写真は操作しない。

| 確認対象 | 配備前の目安 |
|---|---|
| PCで開くPoC | `https://<POC_HOST>/`（サブパスがある場合は統合担当の指定に従う） |
| スマホの正しい到達先 | 同じPoCのpath、`mode=phone`、`case=external-qr` |
| 主リンク | `https://link.metamask.io/dapp/<POC_HOST>/?mode=phone&case=external-qr` |
| PC側の主QR | `qr-destination` を隔離PoC側にする。`qr-canvas` が主QR、`target-url` は通常HTTPS URL |
| 入口と状態 | `deep-link`、`direct-link`、環境選択、`provider-select`、`connect-wallet`、`wallet-status` |
| カメラ | `camera-start`、`camera-stop`、`camera-video`、`camera-status`、`camera-diagnostics` |

本番／control選択は今回の主試験では使わない。使う場合も別の「URL到達だけ」の参考試験とし、既存Reownアプリで接続・camera・寄付へ進まない。

## 2. 判定ルール

1. PCのQR読取成功、MetaMask起動、正しいページ到達、provider発見、接続、映像を**別々に**判定する。
2. MetaMaskのBrowserで正規originとpathを確認し、phone表示／case表示も照合する。queryを確認できなければquery保持は「観測できず」。以前の無関係なページ、Walletホーム、別アプリは到達成功ではない。
3. 内蔵Browserの環境選択は本人の申告であり、自動検出・真正性証明ではない。providerの名前だけでもMetaMask本体を証明できない。
4. 各ケースはまず1回。失敗を連打せず、最後に成功した段階を報告する。手入力で復帰できても元のQRケースは失敗／未確認のまま。
5. 「合格／失敗」はその版・端末・リーダーでの観測結果。「未検証」は未実施・前提不足。「対象外」は本PoCが提供しない経路。API不在は「当該環境で利用不可」であり、全Android非対応とは言わない。

## 3. 小さな試験マトリクス

### PC ChromeとAndroid入口

coldは本人の通常操作でMetaMaskを閉じた状態、warmは内蔵Browserで無関係な公開ページを開いてからQR読取へ戻った状態。coldはOSプロセス終了を保証する用語ではなく、実際の開始状態も記録する。

| ID | 条件・本人の操作 | 確認する結果 |
|---|---|---|
| P1 | PC Chrome＋拡張。環境をPCにし、provider候補を更新・本人がMetaMask候補を選ぶ | 候補表示と選択を区別。自動接続／署名なし |
| P2 | 選択後に接続を1回。新規許可画面が出ればまず拒否し、その後本人の意思で再操作・許可 | 拒否を成功扱いしない。許可時はアカウント数・chain表示、署名／送金なし。許可済みならpromptが出ない事実を記録し、拒否ケースは未検証 |
| A1 | Android・MetaMask導入済み・cold。PCの主QRを標準カメラで読み、提示リンクを本人がタップ | 中間画面の有無、MetaMask Browserの正しいorigin/path、phone/case保持 |
| A2 | 同じ標準カメラ・warmで同じ主QR | 無関係な古いページに留まらず正しい到達先へ移る |
| A3 | 導入済み・cold。外部QRリーダー1種類で同じ主QR | リーダー名／版と経路を記録。独自WebViewや確認画面を飛ばしたことにしない |
| A4 | 同じ外部QRリーダー・warm | A2と同じ到達確認。A1/A2の結果を流用しない |
| A5 | QR読取後、外部Chrome／リーダー内ブラウザが中間に現れる条件 | 本人が表示された正規の「開く」を1回押し、最終origin/path/queryを確認。中間経路を再現できなければ未検証 |
| A6 | MetaMask未導入の既存別環境で主QRを読む | 公式download案内、外部ブラウザ、エラーのどれかを記録。開けたふりをしない。導入やWallet作成はこの試験ではしない |
| A7 | A1～A5で正しく到達した同じAndroid内蔵Browser。環境をmobile-in-appにし、providerを選択、本人が接続 | アカウント数・chainを確認。外部Chromeでproviderがないことと区別。署名・送金なし |
| F1 | 入口失敗時だけ、通常HTTPS URLを本人がMetaMask Browserへ直接入力 | 正しいページへ到達できるか。QR／deeplink成功とは別の救済経路として記録 |

通常の外部Android Chromeから、その場でWallet接続するrelay方式は対象外。外部ブラウザは移動の中間地点であり、そこにproviderがないだけでMetaMask Browser内の接続失敗としない。

### Android内蔵Browserのcamera preview

正しい隔離PoCページへ到達した後に行う。Wallet接続はcamera許可の代わりではなく、camera試験のための署名も不要。外部QR読取アプリのカメラを閉じてから開始する。

| ID | 本人の操作 | 合格条件・切り分け |
|---|---|---|
| C1 | 開始して、サイトのカメラ許可を拒否 | 拒否／利用不可が表示され、映像なし。勝手に再要求しない。拒否画面が出ない既存許可環境では未検証 |
| C2 | OS側のMetaMaskカメラ権限が拒否済みの場合に開始 | 正常なpreviewと誤表示しない。本人が設定を戻す必要があれば本人だけが行う。OS拒否とサイト拒否は別結果 |
| C3 | 本人が開始・必要な許可。非私的な対象を少し動かす | 実際に動く映像、正のvideo幅・高さ、video trackがlive。表示されない診断項目は観測できず。音声・静止画・uploadなし |
| C4 | 停止→停止状態を確認→本人が再開→再度停止 | 映像停止、track停止／接続解除を診断で確認。再開は新しい本人操作で動く。camera表示の消灯だけで判断しない |
| C5 | preview中にホームへ移動し、数秒後MetaMaskへ戻る | 背景化で停止。戻っただけでpreviewが自動再開しない。本人の開始で再開可能、終了時に停止 |
| C6 | 可能なら許可待ちの間に背景へ移動し、その後本人が許可または取消 | 遅い許可結果で勝手にpreviewを開始しない。停止済みの古い要求が復活しない。再現できなければ未検証 |
| I1 | 任意：別途本人がiOSの対象版・端末を用意 | Androidの合格を転記しない。同じ入口・cameraケースを独立に行うまではiOS未検証 |

許可済み表示なのに黒画面なら、C3は不合格。カメラ競合・再生失敗・権限・secure contextを切り分け、録画やuploadで確認を代替しない。試験終了時は必ず停止し、PoCを閉じる。

## 4. 本人から返す結果テンプレート

ケースごとに以下を短く返し、統合担当がTASKSへ結果を集約する。URL全文、QR本文、Walletアドレス、写真、秘密、認証情報、生のprovider／エラーログは貼らない。

```text
対象版：<PoCの表示版／統合担当が指定したcommit>
ケース：<A1等>　結果：<合格／失敗／未検証／対象外>
環境：<PCまたはAndroid、OS版、Chrome版、MetaMask版>
リーダー：<標準カメラまたはアプリ名・版／該当なし>
開始状態：<導入済み／未導入、coldの実態／warm・無関係ページ>
経路：<リーダー→外部ブラウザ有無→MetaMask Browser／別画面>
到達：origin一致 <はい／いいえ／不明>
      path一致 <はい／いいえ／不明>
      mode=phone・case=external-qr <保持／欠落／不明>
provider：<選択候補名、EIP-6963／fallback／なし>
接続：<許可／拒否／未実施、アカウント数のみ、chain IDのみ>
camera：<未開始／拒否／動くpreview／黒画面／停止>
診断：<表示された寸法・track状態、観測できずはその旨>
復帰：<停止保持／自動再開してしまった／未実施>
最後に通った段階：<読取／起動／到達／provider／接続／preview>
エラー：<一般化した名前・コードのみ。秘密を含む本文は不要>
安全確認：署名・送金・静止画取得・録画・uploadをしていない
```

少数の成功から「任意のQRアプリで使える」「Android/iOS対応済み」とは結論しない。該当ケースの条件だけを経験的な結果として報告する。
