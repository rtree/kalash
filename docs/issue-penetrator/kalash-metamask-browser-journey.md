# KALASH：MetaMask内蔵ブラウザでQR・寄付・写真をつなぐ

調査日：2026-11-06（JST）。[検証プレイブック](mobile-wallet-verification-playbook.md)のKALASH向け具体案。提案と実装済みを分け、実機の合格前に対応済みとは呼ばない。今回の作業は文書調査のみ。

## 1. 結論と採用条件

**MetaMask内蔵ブラウザ＋選択済みinjected providerを主経路にする案は、公式APIと公開実装に根拠がある。** サイトを開くdeeplink、WalletのQRスキャナー、Webカメラを組み合わせられる。初回だけ外部ブラウザから移動し、その後は同じMetaMask内で認証・寄付・受付確認・写真公開を完結させる。

ただし「内蔵なら必ず成功」ではない。provider準備、Wallet要求の競合、WebViewの権限・ライフサイクル、RPC、Centralの検証は残る。対象Androidで以下の受入ゲートを通し、その後iOSを別に確認する。

Reown AppKit（UI/adapter）とWalletConnect（外部Walletへの通信経路）を区別する。AppKitを使うこと自体が全要求をリレー経由にするわけではない。今回の要求は、**Reownのproject API／relayが使えなくても、injectedの主経路が起動し、署名・寄付できること**として検証する。

MetaMask Connect SDKに替えるだけでは、この目的を満たしたとは言えない。公式architectureではmobile外部接続に暗号化relayを使う構成もある。狙うのはSDKの名前変更ではなく、同一アプリ内のinjected経路である。[D1–D4]

## 2. 現在あるもの・まだないもの

参照コード／記録：[`5bc559a`](https://github.com/rtree/kalash/tree/5bc559ada99a3e394c64e8d308c91f285cddb6cf)。稼働状況はこの版のTASKS記録であり、本調査でlive endpointを検証したものではない。

| 項目 | 確認できた状態 | 判断 |
|---|---|---|
| 内蔵ブラウザの本人認証 | SIWE・Central verify HTTP200・Wallet verified表示の記録 | この端末での実績あり。新規寄付成功とは別 |
| 内蔵ブラウザのapprove／寄付 | approve画面が出ない原因を診断中。通常DonateとAbandonの混同を記録 | 未完了。経路変更だけで解決したとしない |
| provider選択 | `connectWallet`が利用可能injectedを優先する処理あり | 基盤はある。実際に選ばれたconnectorを観測する |
| Reown非設定分岐 | `runtime.ts`に`createConfig`＋`injected`分岐あり。ただしAppKit/WagmiAdapterは静的import | 通信上の独立とbundle依存の除去は別。通常設定ではAppKit初期化にも入るため、主経路の分離を明示的に設計・試験する |
| 写真撮影 | `getUserMedia`実装と権限許可・操作ボタン表示の記録 | live preview・撮影から公開までの実機通しは未確認 |
| 画像選択・公開 | 本人写真1枚のpublished記録、API試験の証拠あり | 本人写真を勝手に置換・削除して再試験しない |
| Scan QR | `App.tsx`で「このreleaseでは未対応」というnoticeを出すのみ | QR decode・受付照合は新規実装が必要 |
| ATMの現地受付／現金・現地Crypto | M3～M5は未着手の記録 | QRが読めても機器・台帳・参拝スタンプ完了にはならない |

基盤コード：[runtime.ts](https://github.com/rtree/kalash/blob/5bc559ada99a3e394c64e8d308c91f285cddb6cf/src/web/runtime.ts)、[App.tsx](https://github.com/rtree/kalash/blob/5bc559ada99a3e394c64e8d308c91f285cddb6cf/src/web/App.tsx)、[TASKS](https://github.com/rtree/kalash/blob/5bc559ada99a3e394c64e8d308c91f285cddb6cf/docs/TASKS.md)。

## 3. 入口を二つ用意する

### A：初めての人 — ATMのQRから入る

```text
ATMに正規KALASH HTTPS URLのQR
  → スマホ標準カメラで読み取り
  → KALASHの受付案内ページ（寺院・受付内容を表示）
  → 本人が「MetaMaskで開く」をタップ
  → MetaMask内蔵ブラウザで同じ受付を取得
  → 必要なら接続・chain確認・本人認証
  → 寺院／端末／金額／期限／用途を確認して進む
```

最初のHTTPSページはWallet未接続でも案内を表示できるようにする。バックエンドの受付状態を変更するのは本人確認・明示同意後。自動リダイレクトを連打せず、MetaMask未導入・起動できない場合に手動で正規URLへ進む案内を残す。

公式の現行deeplink形式は次のとおり。[D1]

```text
https://link.metamask.io/dapp/{dappUrl}

KALASHの既存寺院ページを開く例（提案・実機未試験）：
https://link.metamask.io/dapp/kalash-central-548318651344.asia-south1.run.app/temples/temple-01
```

これはページを開くリンクであり、接続・ログイン・送金を許可しない。公式にはQR化して読む導線と未導入時の案内もある。新規実装は現行公式形式を使い、古い`metamask.app.link`の動作を全端末で仮定しない。

ATMのQRをdeeplinkそのものにする案も試せるが、初期案は正規HTTPSページを入口にして、利用者が行き先を確認してからWalletを開く。標準カメラのURL認識やOSのリンク関連付けで失敗しても説明・再開ができるため。

### B：使い慣れた人 — MetaMask内のKALASHから読む

```text
MetaMask内蔵ブラウザでKALASHを開く
  → 「ATMのQRを読む」
  → MetaMaskスキャナー、またはKALASHのWebスキャナー
  → 同じページに読み取り結果を返す
  → Centralで受付を照合
  → 内容確認 → 受付紐付け／寄付
```

この導線は外部ブラウザへの往復を減らせる。MetaMaskアプリのホームにある一般QR機能の挙動と、KALASHから呼ぶQR APIの挙動は別に試験する。どんなQRでも内蔵ブラウザへ開くとは約束しない。

## 4. QRは四種類を混ぜない

| QR | 役割 | KALASHでの扱い |
|---|---|---|
| WalletConnect接続QR | Walletセッションの接続資格情報 | 今回の主導線では不要。ATM受付QRと区別 |
| サイト／deeplink QR | Webページ・Walletブラウザを開く | navigationだけ。本人・支払い・掲載の同意にはしない |
| ATM受付QR | 短命の受付・寺院・端末・用途に紐づく参照 | Centralで照合・本人に内容表示。重複と期限切れを処理 |
| token送金QR | アドレス・token・金額への送信 | Vault寄付の代替にしない。donationIdとDonatedイベントが欠落する |

`/send/.../transfer`のUSDC deeplinkは、今回の寄付Contract呼び出しの代替にはならない。ATMから秘密鍵・WalletConnectセッションを渡す設計にもしてはいけない。

### URLと受付状態の持ち方（新規設計案）

- `/visit/<opaque-reference>`のような短いパスを候補にする。このrouteは現時点で未実装。金額・recipient・RPC URLをQRの値だけで採用しない。
- 単純なpathだけの非秘密URLでcold/warm起動を先に試す。query/hash/percent encodingを含む場合は欠落・二重decode・別originへの遷移を試験する。
- ChromeとMetaMask内蔵ブラウザではstorage・認証は共有されない。Firebase token・SIWE署名・WC URIをURLで移送しない。移動先で本人認証し、Centralから同じ受付を復元する。
- deeplinkサービスはURLの搬送経路に入る。URLへ高権限のbearer資格情報を載せない。受付参照はそれだけで現金開始・払い出し・写真公開できないものにする。
- SPEC §5に従い、受付は短命・不透明・用途／寺院／端末／受付／必要な本人に拘束する。表示用参照と、認証後の一回限りclaim処理を分ける設計を検討する。
- 同じQRを二人が読む、期限直前に読む、ATMが別受付へ切り替わる、第三者が撮影済みQRを再使用するケースをサーバーで検証する。見ただけで消費せず、確認後のclaimを原子的に行う。
- 短い手入力コードをfallbackにする場合も認証・期限・試行制限を維持し、番号だけで現金権限を与えない。

## 5. QRを読む実装候補

### 第一候補：選択したinjected providerで `wallet_scanQRCode`

対象のストア配布版で、返却形式・キャンセル・復帰の実機試験に合格した場合に採用する。

MetaMask公式RPCにQRスキャナーがある。正規URLを読むならregexを明示する。省略時はEthereum addressを期待する仕様なのでATM URL用途には適さない。[D5]

```ts
// 設計例。selectedProvider取得と受付route実装は別途必要。
const raw = await selectedProvider.request({
  method: 'wallet_scanQRCode',
  params: ['^https://kalash-central-548318651344\\.asia-south1\\.run\\.app/visit/[A-Za-z0-9_-]+$'],
});

// ここで即navigate/claimしない。
// 1. 対象端末で確認した返却形式だけをparse
// 2. URLのprotocol/origin/path/長さ/余分なquery等を検査
// 3. Centralへ参照を照会
// 4. 内容表示 → 本人の明示確認 → claim
```

重要な制約：

- このmethodはMetaMask専用の拡張で、任意Walletに共通ではない。非対応・拒否・キャンセルを表示し、勝手に再要求しない。
- WalletConnect経由のmethod一覧にも存在するため、API名だけでローカル通信と断定しない。今回の主経路ではselected injected providerから呼ぶ。
- 公式の結果型はstring。一方、調査したMobile実装には`data`、`target_address`、構造化結果のJSON文字列を返す分岐がある。対象版で実際の返却形式を観測し、既知の形式だけを厳密に扱う。任意objectを文字列化してURL扱いしない。[D6]
- regexは入力フィルターで認可ではない。クライアントのURL検査とCentralの受付検証を必ず行う。
- カメラ権限とスキャナー復帰は実機ゲート。Wallet側の権限を`pm grant`で代行しない。

### 第二候補：Webカメラ＋QR decoder

同じMetaMask内のKALASHで`getUserMedia`を開き、フレームをページ内でdecodeする。BarcodeDetector単独に依存せず、対応確認と検証済みdecoder fallbackを用意する。依存追加はプロジェクトのpin／公開168時間／install scripts禁止を守る。

QR検出後はスキャンを一時停止して二重処理を防ぎ、結果確認後に必要なら再開。生のQR画像をサーバーへアップロードして読む構成にはしない。QR用背面カメラと自撮り用前面カメラは同時起動せず、切り替え前にtrackを停止する。

### 第三候補：受付コード入力

カメラなし・拒否時のfallback。金額や宛先を手入力させる代替ではなく、Centralの同じ受付へ戻るための導線とする。本人確認・用途確認・期限検証は省かない。

## 6. 自分の写真を撮る導線

写真はQRスキャナーと別機能。MetaMask Mobileの公開テストにWebViewの`getUserMedia({video:true})` fixtureとAndroid/iOSのカメラ権限ケースがある。設計上可能な根拠はあるが、KALASHでの実機通し合格ではない。[D7]

```text
confirmed寄付（既存Historyからでもよい）
 → 撮影／画像選択／スキップ
 → 動くカメラプレビュー
 → 本人が撮影
 → ローカルプレビュー・撮り直し・破棄
 → 初期OFFの公開同意
 → 本人がPublish
 → Central保存 → 別ブラウザでBoard確認
```

必要な受入条件：

1. HTTPS secure context、API存在、サイト／OSの権限を確認。
2. ボタン表示だけで合格にしない。映像が動き、videoWidth/Heightが正で、trackが有効であることを確認。
3. 自撮りは前面カメラをpreferするが、facingModeの厳格指定を必須にしない。向き・ミラー表示・保存結果を照合。
4. close、撮影完了、画面離脱、本人切替で停止・破棄する。背景化時の停止と復帰時の再開方針を明示する。
5. 許可待ち中に離脱→後からgetUserMedia成功、という競合でも取得したtrackを即停止する。現在コードはこの競合への追加ガードが必要。
6. 選択・撮影・プレビュー時点で画像POSTがない。公開同意後にのみ送信する。
7. 5MB/20MP等のサーバー制限を、実端末の高解像度写真で確認。クライアントで縮小する場合もサーバー検証は維持。
8. 公開→置換→取り下げ後、Board一覧・旧画像URL・Storage実体を確認。開きっぱなしのBoardにも状態変化を反映する。

現地写真は現在のSPECでは端末撮影が基本。今回のスマホ撮影希望は追加のUX候補として扱い、M3/M5のATM側「撮影／選択／スキップ」を黙って削らない。スマホとATMの写真掲載権限・同じ受付IDへの帰属を設計し、実装時にSDDへ反映する。

## 7. Reownを主経路の必須条件から外す実装方針

1. 起動時にinjected経路を初期化できる構造にする。Reown project API・relay・modal初期化完了を待たない。
2. EIP-6963等で検出した実providerを選択し、アカウント取得・chain確認・SIWE・writeで同じ選択を使う。`isMetaMask`は他Walletも設定し得るので単独の認可根拠にしない。
3. WalletConnectを残すなら「他のブラウザ／Walletで接続」の別選択にし、遅延読込する。injected失敗から無言でWCへ切り替えない。
4. public RPCを明示し、Walletへの署名経路から分ける。Centralへの認証・保存・mintも維持。
5. SDKを完全除去する変更と、主導線をinjectedにする変更を分けて検証する。Wagmi/Viem自体はReown relay必須ではない。
6. テスト環境でReown/WC宛通信だけを遮断し、injectedの接続→SIWE→許可済み少額寄付→Central→Collectionが通ることを確認する。MetaMask自身のRPC等は遮断しない。別ケースでdeep link入口と手動URL入口も確認する。

これで「Reownに依存しない主導線」という主張を実証できる。サイト・中央API・チェーンRPC・MetaMask本体・deeplink resolver等の依存まで消えるわけではない。

## 8. 最小実機スパイクとリリース条件

アプリへ一度に全部入れず、以下の順に判定する。最初のQR・camera試験は送金も個人写真公開も不要。

| 順番 | 試験 | 合格証拠 |
|---|---|---|
| 1 | 非秘密の既存寺院URLを手動入力、公式deeplink、標準カメラのQRで開く | cold/warm両方で正規origin・正しいpath。別ページ再開を検出 |
| 2 | 内蔵ページでinjectedを選ぶ | connector記録、chain 84532、正しい本人。WC経由でない |
| 3 | 状態変更しない試験用route／QRを用意してnative scannerで読む | 実返却形式・キャンセル・権限拒否・復帰を確認。例のregexは`/visit/`専用なので既存`/temples/`用の試験では合わせて変更する |
| 4 | Web scanner／手入力fallback | 同じ受付照合へ到達。QR誤読・別originは拒否 |
| 5 | 既存confirmed寄付からカメラ試験 | 実映像・撮影・破棄・Stream停止、公開前未送信 |
| 6 | 同意した専用テスト画像で公開・取り下げ | 別ブラウザBoard表示と撤回後停止、実体削除。本人の既存写真を保護 |
| 7 | 古いpendingの通常復旧後、許可済み寄付一本 | approveとdonateが区別され、同じIDでCentral・mint・再読込成功 |
| 8 | Reown通信遮断、中断・回線切替 | injected主経路が成立し、同じ操作の復旧・重複防止を確認 |
| 9 | ATMとの実連携（M3/M5） | スマホとATMが同じ受付ID・寺院・額・状態。QR読取だけで機器を動かさない |

AndroidとiOSは別々に記録。未検証のiOSを対応済みにしない。WebViewのtoolbar・キーボード・セーフエリアでDonate/Publishボタンが隠れないことも実画面で確認する。Uniswapにもin-app browserの表示領域を扱う実装がある。[D8]

### チームへの短い依頼文

> MetaMask内蔵ブラウザ＋injectedを主経路として検証してください。まず公式deeplinkで非秘密の寺院ページを開き、実connectorを確認。次にwallet_scanQRCodeの返却形式・キャンセル・復帰と、getUserMediaの実映像・破棄を送金なしで確認してください。Scan QRは現行未実装なので、新しい受付routeとCentralの期限・用途・本人拘束が必要です。Reown通信を遮断しても主経路が通ることを受入条件にし、M2写真は既存confirmed寄付から進めてください。

## 9. 一次資料

以下はGitHub connectorで本文確認した公式資料／ソース。固定版はストア配布版と同一とは限らない。

- [D1：公式deeplink](https://github.com/MetaMask/metamask-docs/blob/f58d8cc892fea000e08fd43c255f5de94929b019/metamask-connect/evm/guides/metamask-exclusive/use-deeplinks.md)。公式例は`https://link.metamask.io/dapp/app.uniswap.org`。
- [D2：handleDappUrl](https://github.com/MetaMask/metamask-mobile/blob/49d569cee6aafad37923b4ba71c84204ce851ea6/app/core/DeeplinkManager/handlers/intent/handleDappUrl.ts)、[handleBrowserUrl](https://github.com/MetaMask/metamask-mobile/blob/49d569cee6aafad37923b4ba71c84204ce851ea6/app/core/DeeplinkManager/handlers/intent/handleBrowserUrl.ts)。アプリ内Browserへの引渡し。
- [D3：BrowserTab](https://github.com/MetaMask/metamask-mobile/blob/49d569cee6aafad37923b4ba71c84204ce851ea6/app/components/Views/BrowserTab/BrowserTab.tsx)、[provider API](https://github.com/MetaMask/metamask-docs/blob/f58d8cc892fea000e08fd43c255f5de94929b019/metamask-connect/evm/reference/provider-api.md)。injection/bridge、EIP-6963、isMetaMaskの限界。
- [D4：MetaMask Connect architecture](https://github.com/MetaMask/metamask-docs/blob/f58d8cc892fea000e08fd43c255f5de94929b019/metamask-connect/architecture.md)。外部接続のSDK名変更だけでrelay不要にならない根拠。
- [D5：wallet_scanQRCode](https://github.com/MetaMask/metamask-docs/blob/f58d8cc892fea000e08fd43c255f5de94929b019/metamask-connect/evm/reference/json-rpc-api/wallet_scanQRCode.mdx)。regexと返却仕様。
- [D6：RPCMethodMiddleware](https://github.com/MetaMask/metamask-mobile/blob/49d569cee6aafad37923b4ba71c84204ce851ea6/app/core/RPCMethods/RPCMethodMiddleware.ts)、[QRカメラ権限処理](https://github.com/MetaMask/metamask-mobile/blob/49d569cee6aafad37923b4ba71c84204ce851ea6/app/components/Views/QRScanner/useQrScannerCameraPermission.ts)。返却分岐と権限処理。
- [D7：camera fixture](https://github.com/MetaMask/metamask-mobile/blob/49d569cee6aafad37923b4ba71c84204ce851ea6/tests/fixtures/security/camera.html)、[CameraWebsite](https://github.com/MetaMask/metamask-mobile/blob/49d569cee6aafad37923b4ba71c84204ce851ea6/tests/page-objects/Browser/ExternalWebsites/Security/CameraWebsite.ts)。Web cameraテスト。emulator用自動権限操作を本人端末へ移植しない。
- [D8：Uniswap inAppBrowser](https://github.com/Uniswap/interface/blob/1f602ef0e4053145c44fc5cd64042d7182a902fd/apps/web/src/constants/inAppBrowser.ts)、[wagmiConfig](https://github.com/Uniswap/interface/blob/1f602ef0e4053145c44fc5cd64042d7182a902fd/apps/web/src/connection/wagmiConfig.ts)。UI制約とconnector構成の実例。
