# KALASH：MetaMask・寺院ATMの寄付UXと取り込み方針

更新日：2026-11-06（JST）。ユーザーが定義した三つの寄付体験を本体・寺院ATMへ取り込むための文書。[検証プレイブック](mobile-wallet-verification-playbook.md)と[過去のApprove調査](metamask-mobile-usdc-approve-investigation.md)を参照する。今回の作業は文書更新のみで、製品変更・配備・機器操作は実施していない。

## 0. 最新の決定と進捗

**KALASHはモバイルMetaMask内蔵ブラウザ＋PCを前提とし、ATMのQRはMetaMask DApp deeplinkにする。M1・M2の成功経路を使って寺院ATMへ進める。Reown全面撤去や独立したWallet層の作り直しを前提にしない。**

最新照合：[main `8a7b887` のTASKS](https://github.com/rtree/kalash/blob/8a7b887fbd5496d78f0b71abe95fb4a8ddb3e7f2/docs/TASKS.md)。

| 項目 | 現在の証拠・扱い |
|---|---|
| モバイルCrypto寄付 | 本人がMetaMaskのBase Sepolia RPCを変更後、0.01 USDC approve→donate→Central confirmed/minted→Collection再読込まで成功。記録では成功receipt・canonical block・Vault Donated・mint receiptを照合済み。以前の「Approve未解決」を現在のブロッカーにしない |
| RPC原因と再発防止 | 問題時のWallet設定hostは本人報告で `rpc.walletconnect.org/v1`、RPC準備時にUnauthorized。RPC変更後に成功した記録と今回の原因報告を採用。自動追加するRPCは必ず `https://sepolia.base.org` にする（§7） |
| 写真・Devoteeボード | 本人がスマホで撮影・Upload・Devotee board表示まで確認。公開APIの写真1件・本人slot・published状態とも一致。M2はほぼ到達しており、運営者withdraw・残るcamera/size/withdraw検証を本筋で閉じる |
| QR入口 | 今回の端末・外部QRリーダーでPC QR→MetaMask内蔵→指定Cloud Run URLへ到達しquery保持も成功。PoC `00002-j6c`／source `d9bf3ce0ed07` の記録 |
| 独立PoCの残項目 | PoC自身の接続・camera preview停止は別ケースの未確認。本体の成功を取り消す理由にも、ATM共通設計を止める条件にもしない |
| M3～M5 | 現金Controller・精算／払い出し・現地Cryptoはこれから。今回のUXはその実装へ取り込む仕様であり、実装済みの宣言ではない |

mainの同じTASKS内には古い「Approve診断を再開」「モバイル成功確認が未完」も残っている。本筋の統合担当は新しいM1-e2e／Mobile Approvalの成功証拠に合わせて現在状態を整理する。新たな寄付で成功済みを証明し直す必要はない。

## 1. 対応環境と実装の優先順位

- モバイルはMetaMask内蔵ブラウザのinjected providerを使う。PCは既存のChrome＋MetaMask拡張を基準にする。iOS・別端末・別QRリーダーの対応実績は別欄で管理する。
- 外部モバイルブラウザで来た人には「MetaMaskで開く」を出す。Chrome＋WalletConnectの完走を今回のリリース条件にしない。
- Reown/AppKitを残してよい。必要なのは正しいprovider・chain・RPCで既存の寄付が動くこと。SDK撤去、Reown全通信遮断試験、アプリ内QRスキャナー実装はATM着手の必須条件から外す。
- M2の残項目を引き継ぎ、次のM3でATM共通受付・deeplink QR・現金寄付・ATM写真を実装する。同じ受付基盤をM5現地Cryptoで再利用する。M4の精算／払い出しは既存計画に残し、寄付UX変更で削除しない。
- 実機検証はPCのQR→スマホ→Cloud Runに統一し、試験中は配備revisionを固定する。

## 2. 三経路で共通に使うもの

| 項目 | 定義 |
|---|---|
| 本人確認 | MetaMaskで接続し、SIWEをCentralで検証。有効な認証は再利用し、Wallet変更時は本人を再確認 |
| Crypto | 同じ金額入力・必要時approve・donate・Central検証・mint・Collectionを再利用。十分なallowanceがある場合、approve画面を省略するのは正常 |
| 現地性 | ATM発行の有効な受付と本人をCentralで結ぶ。URLの現地フラグは表示の手掛かりで、現地種別・10倍Point・参拝スタンプの権限ではない |
| 写真 | 寄付確定後の任意機能。撮影／画像選択／Skip→ローカルpreview→明示掲載同意→Upload。辞退しても寄付・スタンプは変わらない |
| 二画面の同期 | スマホとATMが同じ受付・donationIdについてCentralを読む。スマホからATMへ直接通信させず、Centralの状態更新を表示する |
| スタンプ | 応援／参拝の既存Collectionに反映。寄付確定とmint完了を区別し、成功mintを一度だけ数える |

## 3. 入口と三つの寄付UX

### 3.1 共通入口：PC／ATMのQRからMetaMaskを直接開く

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

### 3.2 追加導線：MetaMask内のKALASHからATMのQRを読む

```text
MetaMask内蔵ブラウザでKALASHを開く
  → 「ATMのQRを読む」
  → MetaMaskスキャナー、またはKALASHのWebスキャナー
  → 同じページに読み取り結果を返す
  → Centralで受付を照合
  → 内容確認 → 受付紐付け／寄付
```

この導線は追加の実装・検証対象で、§3.1の入口採用を待たせる条件ではない。MetaMaskアプリのホームにある一般QR機能の挙動と、KALASHから呼ぶQR APIの挙動は別に試験する。§3.1と同じdeeplink QRをアプリ内で読む場合は、許可したdeeplinkをunwrapして展開先の正規KALASH URLを検証する設計が必要。以下の既存regex例は通常HTTPSの受付URL用なので、そのままdeeplink QRに適用しない。


### 3.3 リモートCrypto：スマホだけで完結

```text
MetaMask内蔵でKALASHのURLを開く
 → 寺院を選ぶ
 → Connect／必要時SIWE
 → USDC金額を入力し、金額・fee・受取額を確認
 → 必要ならUSDC Approval
 → 寄付取引をSign／送信
 → Centralが寄付を確定
 → 応援スタンプ発行・Collectionへ反映
 → 任意：スマホで写真→preview→掲載同意→Devotee board
```

既定額0.01 USDC・既存の上限・Base Sepoliaを維持する。既に接続・本人認証済みなら重ねて要求せず、allowanceが十分ならapproveは不要。取引署名は寄付ごとに本人が確認する。寄付と写真の操作はすべてスマホで完結し、写真をSkipしても寄付は完了する。写真は寄付確定後ならmint待ちと並行してよい。PCも同じ寄付処理を拡張Wallet経由で使う。

### 3.4 現地Crypto：ATMは入口と進捗、金額・署名はスマホ

| 段階 | 寺院ATM | スマホ／Central |
|---|---|---|
| 初期 | 「Cryptoで寄付」「現金で寄付」を表示 | 未接続 |
| Crypto選択 | Centralが作成した当該寺院・ATM・用途の受付をdeeplink QRで表示。ATMで金額入力は要求しない | 外部QRリーダーで読む |
| 到達 | 「スマホで接続してください」 | MetaMask内蔵で**当該寺院の寄付ページ**を開く。寺院・受付を照合し「現地寄付」を表示 |
| SIWE・受付紐付け | Centralが本人検証とこの受付への紐付けを完了したら「寄付中」（Donation in progress）へ | Connect／必要時SIWE。既存ログインでも今回の寺院受付への参加を主操作で明示する |
| 金額・署名 | 「スマホで寄付を続けてください」 | リモートと同じ金額入力→必要時approve→donate |
| 送信済み | 「確認中」（Confirming donation） | 同じdonationIdの送信結果をCentralで検証 |
| 寄付確定 | 完了を短く示すか、そのまま初期画面へ戻る。mint・スマホ写真の完了は待たない | 参拝スタンプを発行し、同じ本人のCollectionを更新 |
| 任意写真 | 次の利用者を受け付けられる | リモート同様、スマホで撮影・掲載できる |

「SIWEしたら寄付中」は**CentralでSIWE検証＋当該ATM受付へのclaimが成立した時**に対応する。別ページでのログインやQR表示だけでATMを切り替えない。

「Transactionが実行されたら初期画面」は、txHashを受け取っただけでなく、成功receiptと正しいVaultイベントをCentralが確認して寄付確定した時とする。送信失敗・結果不明を完了扱いしない。送信前の離脱／QR期限切れは受付を閉じられるが、送信後の不明状態は同じIDを照合する。ATMの初期化後もその寄付のmint・写真権限はCentralで継続する。

### 3.5 現地現金：本人紐付け→投入→ATM写真

| 段階 | 寺院ATM | スマホ／Central／Controller |
|---|---|---|
| Cash選択 | この寺院・ATM・cashSessionId用のdeeplink QRを表示 | Centralが一つの有効な受付を作る。まだNV200は受入無効 |
| QR読取・本人紐付け | 「スマホで接続してください」 | MetaMask内蔵で当該寺院の現金受付ページへ。本人確認とこの現金受付への同意・紐付けを行う |
| 機器準備 | 「準備中」 | Centralが受付を許可し、ControllerがNV200を開始。実機Readyを確認 |
| 投入 | **「現金を投入してください」**、収納済み額・残り時間・上限を表示 | Readyから受付時間を計測。このcashSessionIdの実収納を紐付いたWalletの寄付として記録 |
| 現金の完了 | 本人がATMの**「投入完了」（Done depositing）**を押す | 新規受入停止→途中紙幣・遅延イベント・在高を照合→収納額で寄付確定・mint予約 |
| スタンプ | 寄付完了後、ATMは任意写真の選択画面へ | 成功mint後、スマホの参拝スタンプリストを静かに更新。画面を強制遷移させない |
| ATM写真 | 「撮影／画像選択／Skip」→preview→任意の公開同意→掲載 | この確定寄付に限定したATM掲載権限で、寄付者Walletに帰属する写真として保存 |
| セッション終了 | **「終了」（Finish）**、Skip、または写真画面の無操作期限で初期画面へ | カメラ・preview・本人表示・掲載権限を片付け、次の利用者へ |

現金はQRを読んだだけでは開始しない。SPEC §5に合わせ、現金の署名を寺院・ATM・cashSessionId・用途に拘束する。未認証なら本人確認と受付紐付けを一つの導線で行い、有効なログインがある場合も今回の受付への同意・必要な署名だけを行う。一般的なログイン署名を別の受付への同意として使い回さない。

「一定時間の現金がそのWalletの寄付」とは、**この受付のaccepting中に受け入れた紙幣を、Controllerが同じcashSessionIdへ帰属させて照合すること**を指す。closing後に遅れて届く同じ紙幣の収納イベントも含める。時刻の近さだけで現金を割り当てない。同じATMで別の寄付者の受付を重ねない。

スマホでCollection表示中ならリストのデータだけ更新し、別画面なら次の表示／復帰時に取得する。完了モーダル・自動画面遷移・プッシュ通知は今回必須にしない。ネイティブアプリのNotificationはハッカソン後。発行中を獲得済みとして増やさず、mint成功後に既存の参拝枠へ一度だけ加算する。

#### 受付と画面の期限

実装初期値の案はQR 120秒、現金受付はReadyから120秒、ATM写真は無操作30秒。採用する値は本筋のSDD／設定に一元化し、画面には残り時間を表示する。QR・現金受付・写真画面の期限を同じタイマーにしない。

- QR期限切れ：未claimの参照を失効させ、必要なら新しいQRを発行する。QRだけで寄付確定しない。
- 現金のDone／期限／上限到達：いずれも受入停止→照合へ。収納額0なら寄付・mint・掲載権限を作らず終了する。実収納があればその額を照合して確定する。
- NV200のHTTP成功や時計だけで収納を確定しない。ESCROW途中・遅延STORED・返却・通信断は既存Controller契約に従って処理し、照合不能なら「確認が必要」を表示して次の受付を開かない。
- 写真のDone／Skip／期限：未公開previewを破棄し、撮影済みを自動Uploadしない。公開完了済みの写真はBoardに残す。処理中Uploadの結果も旧donationIdに限定し、次の寄付者へ引き継がない。

```text
ATM共通：idle → QR待ち → 本人紐付け
Crypto：寄付中 → 取引確認中 → 寄付確定 → idle
Cash：  機器準備 → 投入受付 → 受入停止・照合 → 寄付確定
        → 任意写真 → Finish／Skip／無操作期限 → idle
```

この状態遷移は実装契約案。寄付確定前の異常は再照合へ分岐し、写真タイマーや画面の再読込で金銭処理を初期化しない。

## 4. QRは四種類を混ぜない

| QR | 役割 | KALASHでの扱い |
|---|---|---|
| WalletConnect接続QR | Walletセッションの接続資格情報 | 今回の主導線では不要。ATM受付QRと区別 |
| サイト／deeplink QR | Webページ・Walletブラウザを開く | navigationだけ。本人・支払い・掲載の同意にはしない |
| ATM受付QR | 短命の受付・寺院・端末・用途に紐づく参照 | Centralで照合・本人に内容表示。重複と期限切れを処理 |
| token送金QR | アドレス・token・金額への送信 | Vault寄付の代替にしない。donationIdとDonatedイベントが欠落する |

`/send/.../transfer`のUSDC deeplinkは、今回の寄付Contract呼び出しの代替にはならない。ATMから秘密鍵・WalletConnectセッションを渡す設計にもしてはいけない。

### URLと受付状態の持ち方（新規設計案）

- 本体の主案は `/temples/<templeId>?visit=<opaque-reference>&mode=crypto` のように既存の寺院ページへ受付参照を渡す形。Cashでは用途をcashにする。パラメータ名は実装時に固定し、Centralの照合結果から現地寄付表示と用途を決める。`/visit/<opaque-reference>`を別途作るなら受付を解決して当該寺院ページへ移る補助routeとする。いずれも受付連携は未実装で、金額・recipient・RPC URLをQRの値だけで採用しない。
- 単純なpathだけの非秘密URLでcold/warm起動を先に試す。query/hash/percent encodingを含む場合は欠落・二重decode・別originへの遷移を試験する。
- ChromeとMetaMask内蔵ブラウザではstorage・認証は共有されない。Firebase token・SIWE署名・WC URIをURLで移送しない。移動先で本人認証し、Centralから同じ受付を復元する。
- deeplinkサービスはURLの搬送経路に入る。URLへ高権限のbearer資格情報を載せない。受付参照はそれだけで現金開始・払い出し・写真公開できないものにする。
- SPEC §5に従い、受付は短命・不透明・用途／寺院／端末／受付／必要な本人に拘束する。表示用参照と、認証後の一回限りclaim処理を分ける設計を検討する。
- 同じQRを二人が読む、期限直前に読む、ATMが別受付へ切り替わる、第三者が撮影済みQRを再使用するケースをサーバーで検証する。見ただけで消費せず、確認後のclaimを原子的に行う。
- 短い手入力コードをfallbackにする場合も認証・期限・試行制限を維持し、番号だけで現金権限を与えない。

## 5. 追加機能：KALASH内でQRを読む実装候補

以下はスマホ内の追加スキャナーを実装する場合の資料。今回のATM入口は外部QRリーダーで成立しているため、M3開始や三つの寄付UXの必須条件にはしない。

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
5. 許可待ち中に離脱→後からgetUserMedia成功、という競合でも取得したtrackが停止されることを確認し、不足があればガードを追加する。
6. 選択・撮影・プレビュー時点で画像POSTがない。公開同意後にのみ送信する。
7. 5MB/20MP等のサーバー制限を、実端末の高解像度写真で確認。クライアントで縮小する場合もサーバー検証は維持。
8. 公開→置換→取り下げ後、Board一覧・旧画像URL・Storage実体を確認。開きっぱなしのBoardにも状態変化を反映する。

今回の決定で撮影場所を明確に変更する。**リモートCryptoと現地Cryptoはスマホ、現地現金はATM**で撮影／画像選択／Skipを提供する。旧SPECの「現地は端末」は本筋で更新する。現金ATMの掲載権限は確定したdonationId・Wallet・templeId・atmId・期限・用途に限定し、本人のWalletセッションをATMへ渡さない。Centralが寄付記録から所有者を決め、Upload時の任意wallet指定は採用しない。本人の掲載同意は撮影・受付同意と別に取得する。

## 7. Base Sepolia RPCの再発防止を小さく取り込む

今回の本人報告とmainの復旧記録では、MetaMaskが使うBase Sepolia RPCを変更するとapprove・寄付が通った。問題時のhostは `rpc.walletconnect.org/v1` と報告されている。これをWallet側RPC経路の問題として扱い、自動追加時に同じ設定を作らない。どの過去操作がWalletへそのURLを登録したかは未確定で、Reown全体の撤去まで原因対策を広げない。

### 固定する契約

| 設定箇所 | 値・扱い |
|---|---|
| Walletへ追加するchain | Base Sepolia、84532／`0x14a34` |
| `wallet_addEthereumChain` の `rpcUrls` | **`["https://sepolia.base.org"]`**。Reown／WalletConnectのproject付きRPCへ自動置換しない |
| dAppのpublic read transport | `https://sepolia.base.org`。現在のruntimeにも明示設定がある |
| SDKのnetwork／chain metadata | add-chain時に使われるRPCも同じ値になるようにする。public transportの設定だけで済ませない |
| Walletに既に登録済みのnetwork | chain切替だけでは既存RPCが更新される保証はない。問題が残る端末は本人が設定を確認・変更する。ネットワーク追加要求だけで上書きできたと扱わない |

自動追加要求の期待形（設計例。実際の要求は本人が確認する）：

```json
{
  "method": "wallet_addEthereumChain",
  "params": [{
    "chainId": "0x14a34",
    "chainName": "Base Sepolia",
    "nativeCurrency": { "name": "Ether", "symbol": "ETH", "decimals": 18 },
    "rpcUrls": ["https://sepolia.base.org"],
    "blockExplorerUrls": ["https://sepolia.basescan.org"]
  }]
}
```

[最新runtime.ts](https://github.com/rtree/kalash/blob/8a7b887fbd5496d78f0b71abe95fb4a8ddb3e7f2/src/web/runtime.ts)はpublic transportを既に固定しているが、AppKit/WagmiAdapterへchainも渡している。[App.tsx](https://github.com/rtree/kalash/blob/8a7b887fbd5496d78f0b71abe95fb4a8ddb3e7f2/src/web/App.tsx)のSIWE前と寄付前の両方のchain切替について、未知chain時の自動追加に上記 `rpcUrls` が使われるようにする。SDKのchain定義・connectorの追加パラメータを調整する最小差分でよい。

レビューでは実際に組み立てられるadd-chain要求を確認する。新規network追加と既存network切替を別ケースにし、すでに正常な本人端末のnetworkを削除して試し直す必要はない。chainIdが84532という応答だけではRPC hostを証明できず、ブラウザからWalletの実RPC設定を標準APIで取得できるとも仮定しない。資格情報付きURLのqueryをログへ出さない。

Reown/AppKitは現在の成功経路を維持する。将来整理するなら別タスクでよく、ATM実装の先にSDK全面撤去・全通信遮断・新しいWallet基盤を置かない。

## 8. 本筋で閉じる受入項目

成功済みのM1/M2をゼロからやり直さず、新しいATMとの接点を中心に確認する。

| 対象 | 完了条件 |
|---|---|
| RPC設定 | network自動追加の `rpcUrls` が指定URL。既存設定の扱いを区別し、PC／モバイルの成功経路を維持 |
| ATM QR・受付 | Crypto/CashのQRが該当寺院をMetaMaskで開く。用途・期限・二重読取・別人・別ATMをCentralが区別する |
| 現地Crypto | 金額入力はスマホ、SIWE＋claim後にATM「寄付中」、Central確定でATM初期画面、参拝mint・任意スマホ写真が同じ本人に帰属 |
| 現地現金 | 本人紐付け→実機Ready→投入→Done／期限→受入停止・照合→確定・参拝mint。0円・途中紙幣・遅延イベントでも次の人へ現金を混ぜない |
| Cash後のスマホ | 現在画面を維持。Collectionを表示中なら成功mintだけが静かに反映され、復帰・再読込でも重複しない |
| ATM写真 | 寄付確定後に任意で撮影・同意・掲載。Wallet帰属が正しく、Finish／Skip／無操作終了で次の人に画像・権限を残さない |
| M2の残項目 | 運営者withdraw、残るcamera／size／withdraw検証を現在のM2行で閉じる。今回の本人写真を再撮影・再公開する条件にはしない |

実機中はCloud Run revisionを固定し、PCのQR→スマホの外部QRリーダー→MetaMaskの経路を使う。M3は実紙幣・Controller・台帳、M5は同一donationIdのチェーン・Central・両画面を照合する。写真やmintのUIタイマーを金銭処理の成功証拠にしない。

## 9. 本筋のチームが取り込む順序

### 9.1 正本に反映する仕様差分

今回のユーザー指示でUXは決定済み。本筋の統合担当が以下をSPEC／SDD／TASKSに反映する。

| 既存記述 | 今回の変更 |
|---|---|
| SPEC §4.2 現地CryptoはATMで金額入力 | ATMでCrypto選択→QR。金額はスマホの寺院寄付ページで入力 |
| SPEC §4.3 現地写真は端末 | リモート／現地Cryptoはスマホ、現地現金はATM。任意掲載は共通 |
| ATMとスマホの結果表示 | SIWE＋受付claimでATM「寄付中」、Crypto確定で初期画面。Cashは確定後ATM写真へ、Finish／無操作で初期画面 |
| CashのCollection更新 | 成功mintを静かに追加し、スマホを強制遷移させない。Notificationはハッカソン後 |
| Web／Wallet・RPC | モバイルMetaMask内蔵＋PC、deeplink QR、自動追加RPCを指定値へ。Reown利用継続可 |
| 進捗 | モバイル寄付は成功済み。M2残項目とM3着手条件を最新証拠で整理し、古いApprove未解決の次アクションを残さない |

SDDには受付のID・claim・期限・状態遷移・二画面同期・端末写真権限を追加する。現地フラグはCentralが有効なATM受付から解決し、QRの自己申告で種別・recipient・金額・Point倍率を決めない。現金受付の署名拘束と受入停止・照合は既存SPEC §5/§8を再利用する。

### 9.2 ATM実装タスクへの割り当て

| タスク | 担当・範囲 | 取り込む内容 |
|---|---|---|
| M2残り | 既存M2担当 | 運営者withdraw等を閉じ、成功済みの写真API・カメラ・Boardを再利用可能なまま引き継ぐ |
| RPC予防 | 既存Wallet担当 | network自動追加だけを局所修正。public read／chain metadata／add-chain要求を照合。Reown撤去はしない |
| M3 ATM共通受付 | ATM UI＋Central | 初期画面、用途別受付、短命deeplink QR、本人claim、寺院ページへの到達、Centralからの状態更新 |
| M3現金・写真 | Controller＋Central＋ATM UI | 受付拘束の署名、NV200 Ready／有限受付／Done／照合、参拝mint、寄付限定ATM写真権限、終了時の片付け |
| M4 | 既存の精算・払い出し担当 | 元の精算・権限・全量払い出し契約を継続。今回の寄付UXで置き換えない |
| M5現地Crypto | Pilgrim＋Central＋ATM UI | M1の金額・approve・donateを再利用し、M3共通受付へ接続。現地種別、両画面同期、ATM初期化、任意スマホ写真 |

M3とM5で別のQR／本人紐付け基盤を二重に作らない。現在の寄付・写真の成功経路を活かし、ATM用の受付コンテキストを追加する。PoCの診断サーバーやWallet probeを本体へ丸ごと移植する必要はない。

### 9.3 実装境界を具体化する

以下の名前は提案であり、既存APIとして扱わない。

- Centralが `visitSessionId` 相当を発行し、寺院・ATM・crypto/cash・期限・state・本人・donationId／cashSessionIdを結ぶ。QRには不透明な参照を載せる。
- スマホは寺院ページで参照を解決し、本人確認後に当該受付をclaimする。署名・認証token・高権限の掲載資格情報をdeeplinkに載せない。
- ATMとスマホは認可されたCentralのsession状態を取得する。まず既存構成に合わせた短周期pollで十分。動作中1～2秒目安、idleでは頻度を落とし、復帰時に再取得する。SSE等の新基盤を必須にしない。
- 同じ状態への再処理、受付claim、Done、収納イベント、mint予約は同じIDで冪等化する。QR再読取・ブラウザ復帰で新しい寄付を自動作成しない。
- 現金確定後、ATMにはそのdonationIdだけの短命写真権限を与える。掲載APIが所有者・寺院・ATM・期限・同意を再照合する。Finishで権限と端末内画像を解放する。

この文書ブランチは古いmainを親にしている。**本筋では `docs/issue-penetrator/` の文書を選択して取り込み、現在のSPEC／SDD／TASKSへ差分を反映する。古いTASKS／SDDやブランチ全体で上書きしない。** 今回ここでは本体実装・配備・試験は行っていない。

### チームへ渡す短い依頼文

> M1モバイルはRPC変更後に完走済み、M2は写真掲載成功と残項目を引き継いでATM実装へ進めてください。ATMのCrypto/CashからMetaMask deeplink QRを出し、Centralで本人と受付を結びます。Cryptoは金額・署名・任意写真をスマホ、Cashは有限受付・終了照合後にATM写真です。Cashのスタンプはスマホの画面を変えずリストに反映してください。自動追加するBase Sepolia RPCを https://sepolia.base.org に固定し、Reown全面撤去には工数を使わず、§9.2の既存M3～M5へ組み込んでください。

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
