# KALASH 進捗

## 現在のゴール

- 現在のゴール：M3-cash onsite cash reception。M5a onsite CryptoとM3-device disabled initializationはverified。先輩決定（2026-11-06）：現金はオフチェーンINR台帳、3% USDC feeは寺院が後払い、Stampは既存onsite kind=1。Stage Bの同意・有限受付・イベント照合・Stamp・ATM写真を実装し、自動試験後にだけ現金UIを有効化する。
- 成功条件：Controller/ITLの機器識別、route、在高/counter、disabled/empty escrowを実応答で確認。現金受付はCentral consent・有限時間・単一poller・STOREDと在高照合を人の立会い下で別途検証する。今回の初期化を現金収納成功と扱わない。
- 今回の担当：Integratorが統合・既存Cryptoとの型境界・Web・共有SDD/TASKS・Git、Central担当が`src/cash.ts`・`src/server/atm.ts`・現金store/routesとその試験、Controller担当が製品受付ループ・永続状態/Outbox・ホスト接続とC#試験を担当。PoCと診断回収の既存差分は保持する。実環境の操作担当はIntegratorのみ。
- 現在の障害：製品の紙幣イベント→Central台帳→Done確定の未接続と型エラーは解消、配備も完了。残る主障害は実機のACCEPTING／ESCROW→STORED／counter形状を署名済み受付で実証していないこと。実イベント→実Firestore寄付確定→mint receiptも未確認。製品gateとCentral現金受付は無効のまま、立ち会い・試験一枚・事前在高・回収方法を確認してから進む。
- 別トラック（UX-mobile限定PoC、今回の本体approval課題とは分離）：本体のReown・稼働版を変更せず、PC MetaMask拡張／外部QRリーダー→内蔵Browser／camera previewを検証する。署名・送金・撮影・uploadは対象外。
- PoC担当：調査担当=`docs/lab/uxmobile/research.md`・`manual-test.md`、実装担当=`index.html`・`app.mjs`・`style.css`・`probe.mjs`・`probe.test.mjs`、統合担当=同ディレクトリの配信／build／配備／README／自動検証、および共有SDD/TASKS・Git。担当外の変更禁止。
- PoC本人結果（2026-11-06 05:23Z）：本体向けQR→スマホの外部QRリーダー→MetaMask起動→内蔵BrowserでKalash表示を本人確認。本体でカメラ起動・撮影・CommunityBoard掲載まで成功との本人報告。添付画面ではPCのisolated PoCがEIP-6963で1 account／Base Sepolia接続。PoC自身のモバイルinjected接続／cameraは未確認。本体はまだReownあり、削除完了の証拠ではない。以降はPCにQR表示→スマホ→Cloud Run試験サイトのみ、スマホ→開発PC localhostは使わない。
- PoC checkpoint（2026-11-06 06:00Z）：本人がPCでPoCのQRを表示し、MetaMask外のスマホQRリーダーで読取→MetaMask起動→内蔵Browserに`https://kalash-uxmobile-548318651344.asia-south1.run.app/?mode=phone&case=external-qr`が表示されたと報告。PoCのorigin・path・query保持を含む入口は今回の環境で本人確認済み。これはPCの共有snapshotをスマホ実測とみなした結果ではない。稼働版`kalash-uxmobile-00002-j6c`、source `d9bf3ce0ed07`／dirty=false、health200・payments/uploads=falseをread-only再確認。配備のCloud Buildは`19d52ae7-9269-447d-8aac-4763b176e0f9`、37 tests pass・skipなし。並行作業の追加build `a72fb6e2-6136-4d05-a6a2-95ba0284d648`は成功したが、このチームから追加配備はしない。SDDのCloud Run限定方針と一致。次は同じスマホPoCページで明示接続・camera preview→停止のみ。全QRリーダー保証・Reown全面削除・モバイル認証／送金成功には拡張しない。
- チェーン：Base Sepolia（84532）のテストUSDCのみ。実価値の送金は行わない。
- Central URL：https://kalash-central-548318651344.asia-south1.run.app（owner-confirmed test/demo service）
- Cloud Run：revision `kalash-central-00020-xp2`、image `central:cdf55c43a37c6af16add0dbd1560531d626c4f99`。Cloud Build `c9766e9f-03a7-4b15-adb3-b68e21fa4814` SUCCESS、完了18:15:47Z。Health ready・source完全一致・traffic100%。imageとSOURCE_COMMITのみ更新し、既存service設定を維持。
- Central ATM `atm-01` は登録済み。API test後のFirestore確認でenabled=true、cashEnabled=false、active receptionなし。ペアリングコードは操作開始時に発行する。
- DonationVault：`0x7a5b5ccc5410e1c9ad4fef8f40bf9786cb842073`。Stamp：`0x853d271ed9461f4e56c449d8c2b7c83b410b4cbb`。
- M1はPC MetaMaskで完了。M2では本人の写真1枚が`temple-01`に掲載済み。画像内容や表示名はログへ記録しない。
- 次の作業：所有者立ち会いで署名済み一枚受付→同じnoteKeyの実STORED→Done→実DB確定→Stamp receiptを確認する。実機操作の承認・在高・回収方法が揃うまではgateを変更しない。CashFeeVault・3% USDC後払い・payoutはStage C。
- 個人用Skill `android-mobile-testing` を `~/.copilot/skills/` に作成。ADB・Chrome・MetaMaskの安全な確認手順を記録した。

## ゴールと担当

| ID | ゴール | 担当・範囲 | 依存 | 状態 | 完了条件・証跡 |
|---|---|---|---|---|---|
| UX-mobile-research | 限定PoC | 調査：上記research/manual-testのみ | なし | verified | 指定commitの2資料・公式仕様を照合。link.metamask.ioを採用、一般QRリーダー保証不可。本人用試験表あり |
| UX-mobile-probe | 限定PoC | 実装：上記5ファイルのみ | なし | verified（実装・PC接続） | Reownなし、明示接続2method限定。本人のPC添付画面でMetaMask/EIP-6963・1 account・84532確認。PoCモバイル接続／cameraはhuman-wait |
| UX-mobile-integrate | 限定PoC | 統合：配信／配備／検証・共有文書・Git | UX-mobile-research、UX-mobile-probe | verified（配備・QR到達） | revision `00002-j6c`、health200、37 pass・skipなし。本人がPC QR→外部スマホQRリーダー→MetaMask BrowserのPoC origin/path/query一致を確認 |
| UX-mobile-device | 限定PoC | 本人：Cloud Run PoCの同じスマホページ | UX-mobile-integrate | human-wait | 残る確認はinjected接続（アカウント数／chain）とcamera preview→停止。本体での撮影・CommunityBoard掲載成功とは分離。試験中は再配備しない |
| M1-entry | M1 | Integrator：AGENTS、仕様、依存ポリシー | なし | 完了 | 初期入力・preflight・公開手順を保存。初期lock検証539件、監査0件 |
| M1-hosts | M1 | Integrator：ホスト・権限診断 | なし | 完了 | Windows開発、Cloud Build Linux、GCP/Auth/ADBの実態を記録 |
| M1-wallets | M1 | Integrator：テストWallet | M1-entry | 完了 | 役割別Wallet、残高・予算の確認済み。残高が多くても当初予算を増やさない |
| M1-chain | M1 | Contracts：Solidity、ABI、テスト | M1-entry、M1-wallets | 完了 | Base SepoliaへVault/Stamp配備、隔離Chainテスト合格 |
| M1-api | M1 | Integrator：Central/Auth/Firestore | M1-entry | 完了 | 認可、単位、receipt、冪等確定、mintを実Auth/DB/Chainで検証 |
| M1-ui | M1 | Integrator/UI：Pilgrim UI・E2E | M1-api、M1-chain | 完了 | ユーザーがConnect、VerifyWallet、SpendingCap、送金、Central確定、Stamp/CollectionをPC MetaMaskで確認 |
| M1-deploy | M1 | Integrator：Cloud Run | M1-api、M1-ui | 完了 | 実オリジン、runtime SA、Health、mint loop確認 |
| M1-e2e | M1 | Integrator：MetaMask・テスト | M1-deploy | 完了 | PCのMetaMaskに加え、Android MetaMask内蔵Browserでも0.01 USDC approval→Donate→Central確認→Stamp/Collection再読込を本人確認。receipt canonical、Vault `Donated` event、mint receiptを照合 |
| M2 | M2 | Integrator：写真・ボード | M1-e2e | human-wait（後回し） | 写真共有→Devotee board表示は本人／API確認済み。2026-11-06本人指示で取り下げ追加作業は後続へ。既存本人withdrawは維持。残るcamera/size検証も未完として保持 |
| M5a-device-state | M5a | Integrator：ATM/Central read-only readiness | M1-e2e | verified | Live APIでmissing/stale/disconnected/ready healthを確認。Cash acceptanceは全状態でfalse、Crypto有効。CashDevice命令なし |
| M5a-crypto | M5a | Integrator：Central／ATM・Pilgrim／Chain API | M5a-device-state | verified | visit claim・kind=1 intent、実receipt／Vaultイベント、mint／Stamp、points、ATM idleまで同じdonationIdで照合 |
| M5a-e2e | M5a | Integrator＋本人 | M5a-crypto | verified | 本人がATM screen pairing、MetaMask mobileの0.01 USDC送金、Collection再読込後のOn-site Stamp表示を確認 |
| M5a | M5a | Integrator：onsite crypto | M5a-device-state、M5a-crypto、M5a-e2e | verified | 現地Crypto end-to-endを確認。Cashは無効のまま。次のM3現地現金は別ゴール |
| M3-itl-contract | M3準備 | Integrator：メーカーREST API契約照合 | なし | done | Manual v14 p.182のSpectral Payout Route=1、NV4000用Postman例Route=3、acceptRoute=7の読戻しを区別。別firmware/datasetへ一般化しない |
| M3-controller-host | M3準備 | Integrator：CashMachineController／子プロセス管理 | M3-itl-contract | done | 専用.NET 10ホスト。専用dir/runtime/loopback検証、明示dotnet.exe、Host/JWT環境上書き、既存port拒否、自分が起動した子だけ停止。18件のController tests pass。 |
| M3-device | M3 | Integrator：CashMachineController/ITL | M5a、M3-itl-contract、M3-controller-host | done | Stage 1 verified。Stage 2 OpenConnection一回成功、6 route-result=true、status DISABLED。GET readback deviceModel/type/base=2/3/0、firmware/dataset一致、isOpen/isStarted=true、deviceError/dispenseState=0、noteInEscrow=false。6 INR levels/counters/currency取得。DisconnectDevice成功、connected list 0、所有REST child正常停止。現金操作なし |
| M3-cash | M3 Stage B | Integrator：Central／ATM／Controller | M3-device | doing | INRオフチェーン、寺院3% USDC後払い、既存onsite kind1、₹400/session・demo ₹1,000/10枚。命令journal `ed6cfd0`、既存host/adapter `0cff0a8`、診断fail-closed `f9054dc`を保持し製品event/Doneを接続（M3-cash-local）。既承認test/demoのAPI read/write・配備権限あり。直近実配備`00019-jdc`/`666c516...`、live ATM API9/9・skip0、ATM cashEnabled=false。今回未確認：新event APIの配備/実DB、実ACCEPTING・STORED・全counter、署名済み一枚→Done→Stamp。診断の成功を製品E2Eに代用せず、人の立ち会い・事前在高・承認済み回収方法で製品経路を確認する |
| M3-cash-local | M3 Stage B | Central担当／Controller担当／Integrator（上記所有範囲） | M3-cash | verified（局所実装、実機ではない） | 単一機器owner・永続判断/Outbox・Central順序/紙幣台帳・Done・原子的寄付/points/mint待ち・INR UIを接続。`pnpm run test:cash` 47/47・skip0（実C# HTTP serialization fixtureをTSで検証）、typecheck/build成功。未commit診断差分を除外したstaged snapshotでController build warning/error0、全46件（既存27＋製品19）成功。実DB・実機・mint receiptは別証拠が必要 |
| M4 | M4 | Integrator：精算・払い出し | M3 | 未着手 | 実入金、管理者承認、実機全量払い出し、在高照合 |
| M5 | M5 | Integrator：現地Crypto | M4 | 未着手 | ATM QR、スマホ送金、両画面とStampの一致 |

## 現在のブロッカー

| 対象 | 確認済み事実 | 次の作業 | 人の操作・再開条件 |
|---|---|---|---|
| M2 写真 | `kalash-donation-photos` はasia-south1、Uniform access、Public access prevention有効、soft-delete 0。Cloud Run runtime SAだけがアプリ用ObjectAdmin | 現行写真API／公開ボードを維持 | 個人写真の追加公開には都度明示同意 |
| M2 カメラ | 本人が本体の撮影→掲載を確認。公開API1件・本人slot／publishedも照合済み（画像内容は取得せず） | 既存機能を維持してM3 ATM写真へ再利用 | 追加の本人写真撮影・公開・削除は依頼しない |
| M1 mobile Chrome | Chrome＋MetaMask/WCで接続・アドレス表示後、VerifyWalletが`personal_sign`非対応で失敗（viem 2.57.13）。認証署名・送金は行わず | MetaMask内蔵Browserを優先。認証の迂回や別署名方式への自動fallbackは禁止 | 新しい署名プロンプトは本人が確認 |
| M1 MetaMask SIWE | 本人がwarningを解除してSIWEを承認。Base Sepoliaの正規origin、login-only message、Cloud Run auth verify HTTP200、KALASHにWallet verified表示。寄付・token transferは行われていない | 完了。次のウォレット署名／送金は別の本人確認 | 認証成功を寄付同意とみなさない |
| M1/Mobile Approval | ユーザーがMetaMask Base Sepolia RPCを変更後、0.01 USDC approval→donation成功。Firestore最新記録`0xebee32b2…`はconfirmed/minted、amount=10000, fee=1, net=9999。Receipt success・canonical、matching Vault `Donated` event、mint receipt success・canonical | M1 mobile donation完了。Central recordsは全消去せず保全 | 以後の送金は別依頼・本人確認 |
| M3/NV200接続 | OpenConnectionをCOM4へ一回。route result 6/6成功、REST state DISABLED、device codes 2/3/0、firmware/dataset一致、error=0、noteInEscrow=false。6 INR levels/counters/currency取得、DisconnectDevice後connected list 0 | M3-cash Stage Bの認可・イベント台帳実装へ進む | Acceptor/auto escrow disabled。紙幣投入・payoutなし |
| M3/CashFeeVault | 先輩決定で現金寄付はオフチェーン、寺院が3% USDCを後払い。CashFeeVault/CollectorはStage Cで必要だが、現金受付Stage Bを止めない | Stage Cで専用契約・invoice・正規receipt照合を実装。Stage Bで架空addressやDonationVault callを使わない | Feeは寄付者から徴収しない。未払い状態を明示し、payoutはStage Cまで不可 |
| M3/ITL REST API | Stage1/2実検証完了。numeric deviceModel/type parser、GetAllCashDevices string ID parser。DisconnectDevice後にchild停止・port閉・ログdir削除（内容未読） | M3-cash Stage BのCentral/Controller連携 | Fresh初期資格情報の変更なし。OpenConnection再送・現金命令なし |
| M3/Central command API | Owner confirmed test/demo and approved API reads/writes and deployment. Route-enabled revision `00019-jdc` now serves 100%; health source matches `666c516...`, repeated command GETs are 200/identical, and `pnpm run test:atm` passes 9/9 with no skips. | Continue the device-event ledger, Done reconciliation and confirmed donation/mint handoff. | No paper or ITL acceptance used during deployment/API tests; physical diagnostic still requires owner attendance and verified device preconditions. |

## M1の検証証跡

- Cloud Build `a8edc91e-655f-4fd3-9213-24ed913ba4b6`：Contract隔離テスト23件成功、skipなし。Vault/Stamp配備receiptは`config/deployment.public.json`。
- 初期のテストSigner寄付3件は、通常MetaMask経路ではない。金額・mint・累計は過去のAPIテスト記録を参照し、MetaMask成功と混同しない。
- 既存のMetaMask取引`0xbb22b84e...17da`は外側が`redeemDelegations`で、直接EOA前提のCentralが`submitting`に停滞。Vaultの`Donated`とUSDCの1+9999単位の移動がintentに一致したため、strict receipt検証を追加後に同一txだけreconcile。新規送金なしでmint `0xb848936a...b4b`、チェーンbalance 1を確認。
- ユーザーは続いてPC MetaMaskでConnect→VerifyWallet→SpendingCap→送金→Central確定→Stampを確認。FirestoreとChainに2件のMetaMask確定・mintがあり、添付Collection/History画面にも反映。
- 最近の2件（21:40Z、21:43Z）はCloud Runのintent作成User-AgentがWindows Chrome。どちらもconfirmed/minted。モバイル送金の証拠とは扱わない。
- FirestoreのOwner別ポイント、API認可・単位・冪等性、deny-all Firestore rulesを実サービスで検証済み。

## M2実装・検証証跡

- 依存：sharp 0.35.5（168時間超）、install scripts無効、lock 569件の公開時刻とhashを確認。`pnpm audit`は既知脆弱性0件、GitHub Dependabotもopen 0件。
- Cloud Storage：`kalash-donation-photos`（asia-south1）、公開禁止、Uniform bucket access、soft-delete 0。Storageに公開ACLやsigned URLなし。
- Centralはconfirmed donationに紐づく本人画像だけを受け付け、JPEG/PNG/WebP実デコード、5MB/20MP/単一frame制限、EXIF向きを適用、1600px以下・metadataなしJPEGへ再encode。明示同意なしではuploadしない。1 wallet×templeにつき最新1枚、30日で期限切れ。公開画像はCentral経由で毎回状態確認し、取り下げ後は404。削除失敗はdurable retry queueへ。
- 画像サイズは本人の累計Pointで4段階。公開DTOにwallet、donation ID、金額、正確なPoint、Storage pathを含めない。
- Cloud Build `a80fc3f1-a8d0-4311-8271-66a32f4daac0`（M2 API）と`30b9c882-5915-44ac-b0ac-e625951feedc`（カメラUI）成功。revision `kalash-central-00009-hgk`、source `65cf51cee9a7c908c516d7aac7e4448b940d358e`。
- 実Central API 7件成功・skipなし：合成ポートレート、同意拒否、非公開Storage配信、差し替え、他Walletのwithdraw拒否、本人withdraw、取り下げ後404。既存ユーザー写真を残したままテストするようAPIテストを修正済み。
- ユーザーはAndroidで写真を撮って共有し、Devotee boardに出たと報告。read-only確認では`temple-01`公開写真1件、本人slot1件、published tier1。画像内容・表示名は読まず、画像ファイルも取得しない。
- `/api/board/temple-01/photos`はHTTP200で写真1件を返す。これは本人の表示確認と一致。個人写真をテスト・削除・再アップロードせず、CSPも緩めない。
- Android撮影：MetaMask内蔵BrowserでCamera permissionを本人が許可した後、Take photo/Close cameraが表示されることを確認。Streamを閉じ、撮影・uploadなし。

## 現在のモバイル状態（寄付・掲載成功済み）

- 端末はWindowsからADB 37.0.1で認識。Samsung SM_S942Z、Android 16、物理1080×2340。Chromeは`com.android.chrome`、MetaMaskは`io.metamask`。
- MetaMask内蔵DApp BrowserでKALASHのHistory/Collection・写真操作を表示。通常Chrome＋WalletConnectのVerifyWalletは`personal_sign` unavailableで失敗したため、認証を迂回しない。
- 以前の2件はPC Chrome起点。その後のAndroid寄付`0xebee32b2…`はconfirmed/minted照合済み。成功証明のための追加送金は不要。
- SIWE verify HTTP200、Base Sepolia。旧intent `0x9c721a5a…2932e`と`0xdf3655da…`は期限切れ・approveのみ・txHash/donateAttemptなし。直近4件はcancelled、全署名期限経過。ユーザーはRPC設定変更後にapprovalを承認し、DonationVault receipt・`Donated` event・mint receiptはsuccessかつcanonical。Collection reloadでLotus Courtyardのstamp count 5表示。Central全件削除は未実施。
- 失効済みapprove-only intent 3件は開始後600ブロック内にUSDC Approval/Vault Donatedがなく、Allowance 0。
- 既存版は期限後だけの解決だった。`src/server/donations.ts`のローカル変更は、approve-only・owner・イベント不在・Allowance 0を再検証し、deadline前は`cancelled`、期限後は`expired`とする。期限前cancelは署名を無効化せず期限まで有効であることを表示。署名・送金・Firestore削除はしない。
- 型チェック/build・局所9件成功。Cloud Build `02dddf7d-b07e-4953-b089-af0585d2bf77`成功。Cloud Run `00016-w6k`、health ready・source `1790e57`。Live Central API 7件成功・skipなし。Viem official docsで`writeContract → sendTransaction → prepareTransactionRequest`がfee/gas準備に`getBlock`/`eth_getBlockByNumber`を使うと確認。RPC変更後はapprove→donate→Central→mint→Collection reloadまで実機成功。
- 予期しないMetaMaskページが開いた場合は操作・入力しない。所有者が正規KALASH画面へ戻したことを確認する。Wallet unlock、生体認証、カメラ権限、Spend/Donate署名は本人が行う。

## 過去のM1調査（要約）

- Node 26.13.0、pnpm 10.34.9を固定。依存は168時間条件を満たし、`node scripts/check-policy.mjs`をinstall/build/test/deploy前に実行。
- GCP project `kalash-donation`、asia-south1、Firebase Auth/Firestore/Secret Manager、Cloud Runを構成。Windows ARM64 Ganache制約はCloud Build Linuxへ移行。
- PC WalletConnect/MetaMaskではSIWE nonce期限切れ、async Firebase restore、Base unit/USDC allowance表示の問題を修正。Mainnet送金は禁止。
- AndroidのMetaMask deeplinkが既存ページへ戻る場合があるため、URL originを必ず確認する。CDP/UIAutomatorの生ログや全タブ一覧は個人情報を含むので出力・保存しない。

## 引き継ぎ

- 完了：M1全体、delegated receipt復旧、M2のprivate photo API/boardとカメラ実装、PC MetaMaskの実寄付、写真のpublic listing。
- 未完：後回しのTemple/operator withdrawalとM2残検証、M3～M5。モバイル寄付と写真公開を未完へ戻さない。
- 人の操作：Allowカメラを押下済み。以降の撮影・同意・ウォレット署名・支払いは都度本人が確認する。
- 次の一手：M3-rpc／M3-receptionの実装・自動検証→固定Cloud Run版のQR入口確認。ITL認証と実紙幣は安全な別ゲート。追加署名・撮影・公開・機器動作は必要な対象を明示して本人操作を依頼する。

## 最新チェックポイント

- UTC 2026-11-06 18:25、M3製品実装・配備まで完了。Cloud Build `c9766e9f...` は18:15:47Z SUCCESS（contracts/policy25、Central54、fail0/skip0）。次に既承認test/demoへ配備し`00020-xp2`100%、health source `cdf55c4...`一致。配備前後とも実ATM active visitなし、cashEnabledは未設定＝false。現金・実Wallet・mint・Payout操作なし。
- live `pnpm run test:atm` は10/10・skip0。新cash-session GET、paired Done→実Firestore closing/closeRequested、event routeの401/不正evidence400まで確認。旧試験の架空`TEST_OBSERVATION`成功期待は400に修正し、隔離test ATMだけで`ACCEPTING`申告を検証（実機Readyの証拠ではない）。実紙幣台帳・寄付確定・mintは局所fixtureの証拠のみ、実E2E未完を維持。
- 配備障害の解消：2回目build `72df2279...`もpolicy停止。実upload archiveを調べるとGitのautocrlfがlockfileまでCRLF化していた。`git -c core.autocrlf=false archive`でcommitted sourceを再生成し、upload前にarchive内のpolicy hash・byte-exact lock SHA・570 release-ageを照合して成功。SDDに配備元作成条件を保存。最後のUI追加通信失敗ケースはbrowser reload timeoutで未確認（先のDone正常fixture画面確認とは分離）。
- 保存：`f7f2929`、`6d942d7`、`f0caf3b`、`cdf55c4`はpush確認済み。今回のtest/証拠記録を追加commit。既存の診断回収5ファイルは未commitのまま保持。次の人の操作：実紙幣一枚の製品検証の立ち会い・回収条件を確認。再開文「TASKSからM3の署名済み一枚E2Eを再開。配備済み00020-xp2を維持、未知の現金操作を再送しない」。
- UTC 2026-11-06 17:08／今回再開約67分、M3配備境界。committed source `f0caf3b` のCloud Build `8298c8ab-29dc-4143-b4c0-11b673ce1831` はstep0 policyで停止、配備なし。原因をhashで特定：Windowsの`.npmrc`/workspace/Node版のCRLFとGit archiveのLF差だけでpolicy fingerprintが不一致（lockfileは一致）。4 policy入力の改行だけを正規化し、実設定・版・release-age・lock SHAの検証は維持。570 release再検証、policy2/2・skip0。次は修正版committed sourceのbuild一回、成功後に同一test/demoサービスへ配備。現金gateはoffのまま。
- UTC 2026-11-06 16:40以降／今回再開約40分、M3-cash-local。未commit診断回収を除いたstaged snapshotからController全46試験・warning/error0を独立確認。新規snapshotのassets未作成（NETSDK1004）は空のlocal feedでpackage-free restoreして復旧、外部依存取得なし。実C# HTTP serializationの4イベントをTS validator/ledgerへ通す回帰を追加し、Central/Web局所47/47・skip0、typecheck/build再合格。製品pathから診断回収への依存なし。
- 次：製品Controller変更をcommit/pushし、既承認のtest/demo Centralへ同じcommitted sourceを配備してrevisionと実APIを確認する。現金フラグ・Controller製品gateは有効化しない。実紙幣・Wallet署名・Payoutは未実施、実機のreadback/event/counter/人の受取確認は未検証のまま。
- UTC 2026-11-06 16:30／今回再開約29分、M3-cash-local。Central/Controllerを2担当で実装し、Integratorが型・UI・Doneと検証入口を接続。`pnpm run test:cash` 46/46・skip0、typecheck/build成功（16:26）。package script変更でpolicy fingerprintが変わり一度停止したため、既存release verifierで570件を再検証して復旧。依存追加・installなし。Dockerfileにも必須cash HTTP/store試験を追加。
- UI実測は隔離localhostの明示fixtureのみ：100.00/400.00 INR、Done表示、受付中Close無効を画面で確認。Done一回でclosing／挿入停止表示となり、confirmed表示なし・Close無効を確認。実Cash/Central保存の証拠には数えない。SDD §2/§8.2を実装契約へ更新。`f7f2929`はorigin/main一致でpush確認済み。
- 実稼働はread-only再確認で`00019-jdc`・traffic100%、health source `666c516...`のまま。次：cross-language契約と全Controller回帰を確認、製品変更だけをcommit/push。既存診断回収差分はステージせず保持。実紙幣・署名・Payoutは未実施。
- UTC 2026-11-06 16:09確認／今回再開約8分、M3-cash。実Central healthをread-only確認：ready、chain84532、source `666c5165f2cc9a8757c6cbb9cf348b0f7a39bace`。今回の製品イベント経路はこの稼働版には未配備。実API書込み・機器・署名・配備なし。
- 最初の突破：未統合のcash/crypto型境界を接続。Crypto receipt/operationとcash台帳を分離し、cashはGETで発行状況を確認、INRと寺院後払いfeeを表示。`node scripts/check-policy.mjs`、typecheck、対象shared/receipt試験7/7成功・skip0。以後のATM変更と担当作業は統合試験待ち。SDD §2を更新。
- 保存境界：Integratorの型・表示・文書を今回commit。Central担当はイベント台帳／Done／原子的確定、Controller担当は単一ループ／状態／Outboxを作業中。既存診断回収差分は別に保持し製品の成功扱いにしない。次：両担当を統合しexact contract・順序／再起動／照合異常を検証、実機は未確認のまま別途立ち会い条件を示す。
- UTC 2026-11-06 10:26以降／再開約158分。本人優先順位：M5a onsite Crypto while cash is disabled → next M3 cash. SPEC/SDD/TASKSはこの分割と写真取り下げ後回しに一致。実稼働版は`00018-dgg`／image `central:dbb7efa`。
- M5a実装：read-only healthによりmissing/stale/disconnected/readyを分類。ただしこの段階では状態に関係なくCash acceptanceはfalse。ATM screen pairing、短命deeplink受付、本人claim、現地kind=1 intent、同じreceipt verification/mint/points/Collectionを接続。Donation unknown中はATMをロックし、確定後だけ同じvisitを解除する。
- `node scripts/check-policy.mjs`合格、570ロック依存の168時間証拠も有効。`pnpm run typecheck`、`pnpm run build`成功。Focused unit suiteは12/12成功・skipなし。
- Cloud Build `146fafbd-127e-47ff-ac98-b17d2b7e4815`成功、image `central:dbb7efa`をrevision `00018-dgg`へ配備。`/api/health` ready・Base Sepolia・sourceCommit full SHA一致。ATM shell route HTTP200。
- 実Central `pnpm run test:atm`は認可・pairing・expiry・claim・kind=1 intentを8/8成功・skipなし。未接続／古いhealthではCash disabled・Crypto available、Controller healthがreadyでもM5aではCash disabled。claim・intentの競合／再試行も実Firestoreで成功。API testは送金・mint・写真操作なし。
- M5a live donation `0xd25b42f9…dd2dfb`（visit `178d6d49…fbbc0`）：kind=1、10,000 USDC base units、Firestore confirmed/minted。Donation tx `0x24708f73…aaba69` successful/canonical、exact Vault `Donated` and USDC fee/net transfers matched. Mint tx `0x658b3e88…9584b` successful/canonical、matching `StampMinted` event。Firestore visit `confirmed`、ATM `activeVisitId` cleared、points include 10× onsite multiplier。本人はCollection reload後のOn-site Lotus Courtyard Stamp表示も確認。
- M5a配備 revision `00018-dgg`／image `central:dbb7efa`。Cloud Build `146fafbd-127e-47ff-ac98-b17d2b7e4815` successful. Live API `pnpm run test:atm` 8/8 pass, no skips. Source `dbb7efa47df17107a6843f46961c5d55881712f9`。
- 次：M5a完了。M3現金は別ゴールとして準備し、Cash command／実機service登録は実装・権限の確認後に別途行う。Cash試験は人の立ち会いを待つ。
- M3 device checkpoint: Stage 1/2 verified. OpenConnection once, six route results true, DISABLED, numeric model/type/base 2/3/0, expected firmware/dataset, empty escrow, six INR level/counter/currency reads. DisconnectDevice returned, connected list empty, owned child stopped and port closed. 18 Controller tests pass; no notes accepted/dispensed. Next M3 Stage B per Senior decision; CashFeeVault/fee payment and payout deferred to Stage C.

## 寺院ATMへ取り込むUX（文書PR）

- UTC 2026-11-06 07:27:46。対象：ユーザー定義のリモートCrypto／現地Crypto／現地現金UXをM2残項目とM3～M5へ引き継ぐ。参照main `8a7b887fbd5496d78f0b71abe95fb4a8ddb3e7f2`、稼働記録 `00016-w6k`／source `1790e57`。
- 最新証拠：MetaMaskのBase Sepolia RPC変更後、モバイルapprove→donate→Central confirmed/minted→Collection再読込が成功。receipt・Vaultイベント・mint receipt照合記録あり。本人の写真共有・Devotee board表示と公開APIの記録も一致。M2は運営者withdraw・残るcamera/size/withdraw検証を引き継ぐ。古い「Approve未解決」を現在のブロッカーにしない。
- 新方針：モバイルMetaMask内蔵＋PC、ATM QRはDApp deeplink。Reown全面撤去は不要。自動追加するBase Sepolia networkのrpcUrlsを `["https://sepolia.base.org"]` に固定し、public read設定とWallet保存済みRPCを区別する。
- UX：リモートCryptoはスマホ完結。現地CryptoはATMで選択→QR、スマホの当該寺院ページで金額・署名、CentralのSIWE＋claim後にATM「寄付中」、寄付確定後に初期画面。任意写真はスマホ。現地現金は本人と受付を結び、NV200 Ready→有限受付→Done／期限→停止・照合→確定、スマホCollectionを強制遷移なしで更新、ATM任意写真→Finish／無操作で初期画面。
- 成果：`docs/issue-penetrator/kalash-metamask-browser-journey.md` に三UX・画面状態・期限・現地性・写真権限・RPC・M3～M5への割り当てを統合。プレイブックをATM段階へ更新し、Approve調査にはRPC復旧済みの証拠を追記、旧分析を履歴化。今回の文書commitに含む。
- SPEC §4.2/§4.3/§5/§8、SDD §2/§3/§6/§7と照合。変更指示は現地Cryptoの金額入力場所、Crypto写真の撮影場所、ATMとスマホの状態遷移、RPC固定。現金の署名拘束・Controller照合・寄付限定写真権限は既存契約を維持。本筋のSPEC／SDD／製品コードは今回変更していない。
- 確認：最新コード・記録の読み取り、文書レビュー、Markdownと相互リンクの検査。実機操作・Wallet署名・送金・撮影・公開・配備・製品テストはなし。
- 次の一手：本筋が導線文書§9の差分を現行SPEC／SDD／TASKSと既存M3～M5へ反映。文書ファイルを選択して取り込み、古い文書ブランチ全体やTASKSでmainを上書きしない。実機はPC QR→スマホ→固定Cloud Run revision、試験中は再配備しない。今回の文書作業に本人操作待ちはなし。
- 統合準備：2026-11-06 07:36:04 UTC。ユーザー指示によりPR #1を作成。main `8a7b887` のTASKS本文と製品ツリーを保持し、文書3件と本チェックポイントだけを統合。製品コード・配備変更なし。
