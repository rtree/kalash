# KALASH：MetaMask内蔵ブラウザでQR・寄付・写真をつなぐ

調査・更新日：2026-11-06（JST）。[検証プレイブック](mobile-wallet-verification-playbook.md)のKALASH向け導線と本体への取り込み方針。今回の更新は本人・検証チームの報告を反映した文書作業で、調査担当は追加の実機操作を行っていない。

## 0. 今回決まった方針と、新たな実機結果

**ユーザー決定：KALASHはモバイルMetaMask内蔵ブラウザとPCを前提にする。入口QRは、MetaMask内蔵ブラウザで目的のKALASHページを開くDApp deeplink形式にする。** 以下の初期案をこの決定に合わせて更新した。方針は決定済みであり、本体への反映・個々の受入結果は別に管理する。

| 項目 | 最新の証拠と扱い |
|---|---|
| 外部QRからの入口 | 本人・検証チームが「PCのQR→スマホ外部QRリーダー→MetaMask内蔵ブラウザ→指定Cloud Run URL」を確認。今回の端末・リーダーではqueryも保持。入口の成功として採用する |
| 本体の写真 | 本人が内蔵ブラウザでカメラ起動・撮影・Uploadを確認。検証チームはCommunityBoard掲載成功も別途記録。本体での本人実測として採用し、単なるAPI存在確認に戻さない |
| 隔離PoCで残るもの | 引用されたサマリでは、同じスマホPoCページの明示接続と「カメラ開始→映像確認→停止」は残確認。本体の写真成功とは別ケース |
| 本体のapprove／寄付 | 今回の成功報告には含まれない。[Approve原因調査](metamask-mobile-usdc-approve-investigation.md)の未解決範囲を引き継ぐ |
| Reown全面撤去 | 今回の入口・写真成功では可否を確定しない。主導線のinjected化とパッケージ／設定削除を別変更にする |

照合した本筋の記録は[main `67ab7cc` のTASKS](https://github.com/rtree/kalash/blob/67ab7ccce50fc960b5de1a1a10f5dcb9b038d227/docs/TASKS.md)。05:23 UTCの本体写真の本人報告、06:00 UTCのPoC入口確認を記録している。PoCは `kalash-uxmobile-00002-j6c`、source `d9bf3ce0ed07`、到達先は `https://kalash-uxmobile-548318651344.asia-south1.run.app/?mode=phone&case=external-qr`。調査担当が写真・DB・実端末版を再検証したという意味ではない。

対象環境は次のように整理する。

- **モバイルの主経路：** MetaMask内蔵ブラウザ＋選択済みinjected provider。初期実績は今回のAndroid端末。iOS・別端末・別QRリーダーは未確認欄を持ち、Androidの成功を転記しない。
- **PCの主経路：** PCブラウザ＋MetaMask拡張のinjected provider。既存のWindows Chrome実績を基準にし、他PCブラウザは別に対応状況を記録する。
- **モバイルChrome等の外部ブラウザ：** KALASHを開いた人には「MetaMaskで開く」を案内する。Chrome＋WalletConnectでの寄付完走は今回の対象環境のリリース条件から外す。閲覧ページまで一律に閉める必要はない。
- **今回の検証運用：** PCにQR表示→スマホ→Cloud Run試験サイトに統一し、試験中はrevisionを固定して再配備しない。開発PCのlocalhostをスマホ向け入口にしない。

## 1. 結論と採用条件

**MetaMask内蔵ブラウザ＋選択済みinjected providerをモバイルの主経路として採用する。** deeplink入口とWebカメラには今回の実績がある。同じMetaMask内で認証・寄付・受付確認・写真公開をつなぐ。Wallet内のQRスキャナーは追加機能で、今回の外部QR入口の採用条件にはしない。

ただし「内蔵なら必ず成功」ではない。provider準備、Wallet要求の競合、WebViewの権限・ライフサイクル、RPC、Centralの検証は残る。対象Androidで以下の受入ゲートを通し、その後iOSを別に確認する。

Reown AppKit（UI/adapter）とWalletConnect（外部Walletへの通信経路）を区別する。AppKitを使うこと自体が全要求をリレー経由にするわけではない。今回の要求は、**Reownのproject API／relayが使えなくても、injectedの主経路が起動し、署名・寄付できること**として検証する。

MetaMask Connect SDKに替えるだけでは、この目的を満たしたとは言えない。公式architectureではmobile外部接続に暗号化relayを使う構成もある。狙うのはSDKの名前変更ではなく、同一アプリ内のinjected経路である。[D1–D4]

## 2. 初期調査の実装状況と今回の更新

初期コード／記録：[`5bc559a`](https://github.com/rtree/kalash/tree/5bc559ada99a3e394c64e8d308c91f285cddb6cf)。この表のコード評価はその版を基準とし、写真の実測更新は§0の報告を反映。最新の動作記録は本筋のTASKSを参照する。

| 項目 | 確認できた状態 | 判断 |
|---|---|---|
| 内蔵ブラウザの本人認証 | SIWE・Central verify HTTP200・Wallet verified表示の記録 | この端末での実績あり。新規寄付成功とは別 |
| 内蔵ブラウザのapprove／寄付 | approve画面が出ない原因を診断中。通常DonateとAbandonの混同を記録 | 未完了。経路変更だけで解決したとしない |
| provider選択 | `connectWallet`が利用可能injectedを優先する処理あり | 基盤はある。実際に選ばれたconnectorを観測する |
| Reown非設定分岐 | `runtime.ts`に`createConfig`＋`injected`分岐あり。ただしAppKit/WagmiAdapterは静的import | 通信上の独立とbundle依存の除去は別。通常設定ではAppKit初期化にも入るため、主経路の分離を明示的に設計・試験する |
| 写真撮影 | 初期はAPI実装・権限・ボタンまで。今回、本人が本体のカメラ起動→撮影→Upload／CommunityBoard掲載成功を報告 | 本体での本人実測あり。PoCのcamera preview停止確認と、取り下げ等の未完了項目は別 |
| 画像選択・公開 | 本人写真1枚のpublished記録、API試験の証拠あり | 本人写真を勝手に置換・削除して再試験しない |
| Scan QR | `App.tsx`で「このreleaseでは未対応」というnoticeを出すのみ | QR decode・受付照合は新規実装が必要 |
| ATMの現地受付／現金・現地Crypto | M3～M5は未着手の記録 | QRが読めても機器・台帳・参拝スタンプ完了にはならない |

基盤コード：[runtime.ts](https://github.com/rtree/kalash/blob/5bc559ada99a3e394c64e8d308c91f285cddb6cf/src/web/runtime.ts)、[App.tsx](https://github.com/rtree/kalash/blob/5bc559ada99a3e394c64e8d308c91f285cddb6cf/src/web/App.tsx)、[TASKS](https://github.com/rtree/kalash/blob/5bc559ada99a3e394c64e8d308c91f285cddb6cf/docs/TASKS.md)。

## 3. 入口を二つ用意する

### A：主導線 — PC／ATMのQRからMetaMaskを直接開く

```text
PC／ATMにMetaMask DApp deeplinkのQRを表示
  → スマホの外部QRリーダーで読み取り
  → MetaMask内蔵ブラウザ
  → 指定したKALASHの寺院／受付ページ
  → 内容を表示し、本人が接続・chain確認・本人認証
  → 寄付／受付確認／写真へ進む
```

**入口QRのpayloadをdeeplinkそのものにする。** 通常HTTPSの案内ページを先に必ず開く初期案から変更する。今回成功したのはこの外部QR入口であり、KALASH内の「Scan QR」や `wallet_scanQRCode` の実装を先に完成させる必要はない。

公式形式と本体向けの例：[D1]

```text
https://link.metamask.io/dapp/{dappUrl}

https://link.metamask.io/dapp/kalash-central-548318651344.asia-south1.run.app/temples/temple-01
```

PoCの[buildDeepLink／phoneTarget](https://github.com/rtree/kalash/blob/67ab7ccce50fc960b5de1a1a10f5dcb9b038d227/docs/lab/uxmobile/probe.mjs)が取り込み元になる。許可済みHTTPS targetからschemeを除き、escaped pathと許可したqueryを保って連結する実装。URL全体をもう一度encodeする変更はせず、既存の生成・到達例と照合する。query保持の実績は `mode=phone&case=external-qr` であり、任意のhash・特殊文字・受付パラメータまで確認済みとはしない。

本体ではPoC専用のtarget許可条件をそのまま使わず、正規KALASH originと対象route・許可パラメータの契約に置き換える。寺院ID／受付参照はサーバーで照合する。QRの隣に寺院・用途・行き先を表示し、deeplinkの展開先は公開HTTPSに限定する。

補助導線として、一般ブラウザで来た人向けの「MetaMaskで開く」ボタンと正規URLの表示・コピーを残す。同じスマホ上で自分のQRを再スキャンさせない。MetaMask未導入／起動失敗時は導入・再開方法を表示し、自動リダイレクトを反復しない。PCは通常URLを開いて拡張から接続できる。

このリンクが行うのはページ移動だけ。QR読取・ページ表示を接続・寄付・写真公開の承認にはしない。

### B：追加導線 — MetaMask内のKALASHからATMのQRを読む

```text
MetaMask内蔵ブラウザでKALASHを開く
  → 「ATMのQRを読む」
  → MetaMaskスキャナー、またはKALASHのWebスキャナー
  → 同じページに読み取り結果を返す
  → Centralで受付を照合
  → 内容確認 → 受付紐付け／寄付
```

この導線は追加の実装・検証対象で、Aの入口採用を待たせる条件ではない。MetaMaskアプリのホームにある一般QR機能の挙動と、KALASHから呼ぶQR APIの挙動は別に試験する。Aと同じdeeplink QRをアプリ内で読む場合は、許可したdeeplinkをunwrapして展開先の正規KALASH URLを検証する設計が必要。以下の既存regex例は通常HTTPSの受付URL用なので、そのままdeeplink QRに適用しない。

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

写真はQRスキャナーと別機能。今回、本人からKALASH本体でカメラ起動・撮影・Upload／CommunityBoard掲載の成功報告を得た（§0）。MetaMask Mobileの公開fixtureもAPIの根拠になる。[D7] 以下は既存機能を本体へ取り込む際の受入条件で、すべてを今回確認済みという意味ではない。成功した撮影・掲載を方針決定のためだけに繰り返さず、停止・離脱・取り下げ等の不足証拠を確認する。

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
3. WalletConnectを残すなら任意の補助機能として分離・遅延読込し、今回の対象環境の必須導線にしない。モバイル外部ブラウザの主ボタンは「MetaMaskで開く」にする。injected失敗から無言でWCへ切り替えない。
4. public RPCを明示し、Walletへの署名経路から分ける。Centralへの認証・保存・mintも維持。
5. SDKを完全除去する変更と、主導線をinjectedにする変更を分けて検証する。Wagmi/Viem自体はReown relay必須ではない。
6. テスト環境でReown/WC宛通信だけを遮断し、injectedの接続→SIWE→許可済み少額寄付→Central→Collectionが通ることを確認する。MetaMask自身のRPC等は遮断しない。別ケースでdeep link入口と手動URL入口も確認する。

これで「Reownに依存しない主導線」という主張を実証できる。サイト・中央API・チェーンRPC・MetaMask本体・deeplink resolver等の依存まで消えるわけではない。

## 8. 検証項目と現在の優先順位

§0の成功記録を引き継ぐ。以下は機能別の受入表であり、未実装のアプリ内QRスキャナー（3・4）を先に終えないと本体へ進めないという順序ではない。本筋は入口統合・選択provider・Approveを優先し、PoCの残る接続／preview停止確認は同じ配備版で行う。cold/warmや別端末など、まだ記録のない条件だけを追加する。

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

> モバイルMetaMask内蔵ブラウザ＋PC MetaMask拡張を対応前提にし、入口QRをMetaMask DApp deeplink形式へ統合してください。外部QR→MetaMask→Cloud Runのquery保持、本体の撮影・Upload／CommunityBoard掲載は今回の本人実績として引き継いでください。PoCの接続・camera preview停止確認と、本体のApprove→寄付→Central→Stampは別の残タスクです。アプリ内Scan QRの実装やReown全面撤去を入口採用の前提にせず、§9の順で本体へ取り込んでください。

## 9. 本筋のチームが取り込む順序

### 9.1 仕様・設計・進捗へ決定を反映する

ユーザーの今回の指示を仕様変更の根拠として扱う。この方針について再承認を求める必要はない。本筋の統合担当が次を反映する。

| 正本 | 反映内容 |
|---|---|
| SPECのWeb／Wallet欄・対応環境 | 日付付き変更として「モバイルMetaMask内蔵＋PC MetaMask拡張、入口はDApp deeplink QR」を記載。元のReown/AppKit固定記述との関係を明示し、SDK全面削除を決定済みにしない |
| SDD §1/§7 | 対応環境、deeplink生成、対象URLの検証、実provider選択、外部ブラウザ案内、Reown任意化の方針を記載。ATM受付の新route／認可契約は実装時に§2/§3にも反映 |
| TASKS | QR入口・provider接続・Approve／寄付・写真・Reown分離を分けて担当／版／証拠／未完了を記録。今回の本人成功報告とPoC残項目をそのまま区別する |

この文書ブランチは古いmainを親にしている。**ブランチ全体や古いTASKS／SDDをmainへ丸ごと上書きしない。** 本筋の現在の作業ブランチへ `docs/issue-penetrator/` の更新文書を選択して取り込み、TASKSは必要な決定・証拠だけを現在の担当行へ反映する。別チームのPoC・本体コード・進捗を巻き戻さない。

### 9.2 小さな変更単位で本体へ統合する

| 順序 | 担当・変更範囲 | 取り込み内容・完了の境界 |
|---|---|---|
| 1 | UI／QR担当：本体の入口・QR表示 | PoCのdeeplink生成とquery保持の考え方を本体用URL契約へ移す。PC／ATMが表示する対象QRを切り替え、外部ブラウザには同じ行き先の「MetaMaskで開く」を出す。PoCサーバー・診断画面を本体に丸ごと移植しない |
| 2 | Wallet担当：`src/web/runtime.ts`・接続UI | モバイル内蔵とPC拡張を選択済みinjectedへ統一。EIP-6963／遅い注入／複数拡張を扱い、接続・chain・SIWE・writeが同じ選択を使う。UA文字列だけでproviderを決めない。provider未検出時は再検出／MetaMask起動を案内する |
| 3 | Wallet／Central担当：Approve障害 | [調査MD](metamask-mobile-usdc-approve-investigation.md)に沿って実provider境界とnested拒否を扱う。入口成功を障害解消にせず、同一donationIdでapprove→donate→Central→mint→再読込までを別に確認する |
| 4 | M2担当：既存カメラ・写真機能 | 成功した本体の撮影・Upload／Board経路を維持。PoC preview実装を無条件に置き換えず、停止・離脱・取り下げ・運営者権限等の不足を既存M2タスクで埋める。写真確認のための新規寄付は不要 |
| 5 | 統合担当：Reown依存の整理 | 主経路がReown初期化を待たず動く構成にする。全面削除の可否は別差分で依存利用箇所・起動設定・PC回帰を確認して決める |

`runtime.ts`の[最新照合版](https://github.com/rtree/kalash/blob/67ab7ccce50fc960b5de1a1a10f5dcb9b038d227/src/web/runtime.ts)はAppKit/WagmiAdapterの静的importと、`reownProjectId`有無によるconfig分岐を持つ。内蔵ブラウザで開くだけ、またはproject IDを空にするだけでは、本体全体の依存解消を確認したことにならない。config API、初期化、connector保存・復元、CSP、package/lock、残る呼び出し元を追ってから削除する。Wagmi/Viemは利用を続けられる。

PoCの `createWalletProbe` は接続・chain観測用で、SIWE・送金・Central業務状態を実装していない。これを製品Wallet層の代わりにしない。参考にするのは入口生成・provider発見・明示操作・camera lifecycle等の局所設計であり、本体の認証・復旧・同一ID照合は維持する。

### 9.3 取り込み後に区別して判定する

- **入口採用の完了：** 本体用QRから正しい寺院／受付URLへ到達。今回のPoC query保持を証拠として引き継ぎ、本体で新しく追加するpath／queryだけを確認する。
- **本体のWallet完了：** 対象のモバイル内蔵／PC拡張それぞれで接続・84532・SIWEが成立し、必要なapproveと寄付が同一IDでCentral・Stampまで確定。PCの既存成功も回帰の基準にする。
- **M2の完了：** 本人による撮影・掲載成功に加え、元のM2が要求する同意・取り下げ等の未完了項目を閉じる。本体写真成功とPoC preview残確認を混ぜない。
- **Reown非依存の完了：** Reown/WC通信・設定が主経路を止めないことを確認。パッケージ全面削除の完了とは別に記録する。
- **検証の運用：** PCのQR→スマホ→固定Cloud Run revisionを使う。変更が必要になった場合は実行中ケースを閉じ、次のケース用に版を更新する。試験中の無断再配備はしない。

## 10. 一次資料

以下はGitHub connectorで本文確認した公式資料／ソース。固定版はストア配布版と同一とは限らない。

- [D1：公式deeplink](https://github.com/MetaMask/metamask-docs/blob/f58d8cc892fea000e08fd43c255f5de94929b019/metamask-connect/evm/guides/metamask-exclusive/use-deeplinks.md)。公式例は`https://link.metamask.io/dapp/app.uniswap.org`。
- [D2：handleDappUrl](https://github.com/MetaMask/metamask-mobile/blob/49d569cee6aafad37923b4ba71c84204ce851ea6/app/core/DeeplinkManager/handlers/intent/handleDappUrl.ts)、[handleBrowserUrl](https://github.com/MetaMask/metamask-mobile/blob/49d569cee6aafad37923b4ba71c84204ce851ea6/app/core/DeeplinkManager/handlers/intent/handleBrowserUrl.ts)。アプリ内Browserへの引渡し。
- [D3：BrowserTab](https://github.com/MetaMask/metamask-mobile/blob/49d569cee6aafad37923b4ba71c84204ce851ea6/app/components/Views/BrowserTab/BrowserTab.tsx)、[provider API](https://github.com/MetaMask/metamask-docs/blob/f58d8cc892fea000e08fd43c255f5de94929b019/metamask-connect/evm/reference/provider-api.md)。injection/bridge、EIP-6963、isMetaMaskの限界。
- [D4：MetaMask Connect architecture](https://github.com/MetaMask/metamask-docs/blob/f58d8cc892fea000e08fd43c255f5de94929b019/metamask-connect/architecture.md)。外部接続のSDK名変更だけでrelay不要にならない根拠。
- [D5：wallet_scanQRCode](https://github.com/MetaMask/metamask-docs/blob/f58d8cc892fea000e08fd43c255f5de94929b019/metamask-connect/evm/reference/json-rpc-api/wallet_scanQRCode.mdx)。regexと返却仕様。
- [D6：RPCMethodMiddleware](https://github.com/MetaMask/metamask-mobile/blob/49d569cee6aafad37923b4ba71c84204ce851ea6/app/core/RPCMethods/RPCMethodMiddleware.ts)、[QRカメラ権限処理](https://github.com/MetaMask/metamask-mobile/blob/49d569cee6aafad37923b4ba71c84204ce851ea6/app/components/Views/QRScanner/useQrScannerCameraPermission.ts)。返却分岐と権限処理。
- [D7：camera fixture](https://github.com/MetaMask/metamask-mobile/blob/49d569cee6aafad37923b4ba71c84204ce851ea6/tests/fixtures/security/camera.html)、[CameraWebsite](https://github.com/MetaMask/metamask-mobile/blob/49d569cee6aafad37923b4ba71c84204ce851ea6/tests/page-objects/Browser/ExternalWebsites/Security/CameraWebsite.ts)。Web cameraテスト。emulator用自動権限操作を本人端末へ移植しない。
- [D8：Uniswap inAppBrowser](https://github.com/Uniswap/interface/blob/1f602ef0e4053145c44fc5cd64042d7182a902fd/apps/web/src/constants/inAppBrowser.ts)、[wagmiConfig](https://github.com/Uniswap/interface/blob/1f602ef0e4053145c44fc5cd64042d7182a902fd/apps/web/src/connection/wagmiConfig.ts)。UI制約とconnector構成の実例。
