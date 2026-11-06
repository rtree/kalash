# KALASH 進捗

## 現在のゴール

- 現在のゴール：M5a 現地Crypto ATM連携。本人の指示により、NV200のUSB未接続を安全な試験状態としてCashを無効化し、Cryptoのみ選べるパターンを完成する。次の独立ゴールはM3現地現金。写真取り下げは後回し。M1寄付・本人写真掲載は成功済みのまま維持。
- 成功条件：認可ATMのdeeplink QR→MetaMask→SIWE／明示visit claim→電話でamount・必要時approve・kind=1 donate→Central confirmed/minted→Collection再読込とATM初期画面復帰。未接続／不明時Cash無効・Crypto有効。模擬状態やUI表示を実寄付・Stampの成功証拠にしない。
- 今回の担当：Integrator一人が本体Central／Web／Controller／テストとSPEC／SDD／TASKS・Gitを担当。PoCファイルと他担当の変更には触れない。
- 別トラック（UX-mobile限定PoC、今回の本体approval課題とは分離）：本体のReown・稼働版を変更せず、PC MetaMask拡張／外部QRリーダー→内蔵Browser／camera previewを検証する。署名・送金・撮影・uploadは対象外。
- PoC担当：調査担当=`docs/lab/uxmobile/research.md`・`manual-test.md`、実装担当=`index.html`・`app.mjs`・`style.css`・`probe.mjs`・`probe.test.mjs`、統合担当=同ディレクトリの配信／build／配備／README／自動検証、および共有SDD/TASKS・Git。担当外の変更禁止。
- PoC本人結果（2026-11-06 05:23Z）：本体向けQR→スマホの外部QRリーダー→MetaMask起動→内蔵BrowserでKalash表示を本人確認。本体でカメラ起動・撮影・CommunityBoard掲載まで成功との本人報告。添付画面ではPCのisolated PoCがEIP-6963で1 account／Base Sepolia接続。PoC自身のモバイルinjected接続／cameraは未確認。本体はまだReownあり、削除完了の証拠ではない。以降はPCにQR表示→スマホ→Cloud Run試験サイトのみ、スマホ→開発PC localhostは使わない。
- PoC checkpoint（2026-11-06 06:00Z）：本人がPCでPoCのQRを表示し、MetaMask外のスマホQRリーダーで読取→MetaMask起動→内蔵Browserに`https://kalash-uxmobile-548318651344.asia-south1.run.app/?mode=phone&case=external-qr`が表示されたと報告。PoCのorigin・path・query保持を含む入口は今回の環境で本人確認済み。これはPCの共有snapshotをスマホ実測とみなした結果ではない。稼働版`kalash-uxmobile-00002-j6c`、source `d9bf3ce0ed07`／dirty=false、health200・payments/uploads=falseをread-only再確認。配備のCloud Buildは`19d52ae7-9269-447d-8aac-4763b176e0f9`、37 tests pass・skipなし。並行作業の追加build `a72fb6e2-6136-4d05-a6a2-95ba0284d648`は成功したが、このチームから追加配備はしない。SDDのCloud Run限定方針と一致。次は同じスマホPoCページで明示接続・camera preview→停止のみ。全QRリーダー保証・Reown全面削除・モバイル認証／送金成功には拡張しない。
- チェーン：Base Sepolia（84532）のテストUSDCのみ。実価値の送金は行わない。
- 本番URL：https://kalash-central-548318651344.asia-south1.run.app
- Cloud Run：M5a candidate revision `kalash-central-00017-l62`、image `central:a193002`。Health ready・Base Sepolia・mint有効。health応答のsourceCommit環境値は旧値のため、次の配備で現在の完全commit SHAへ更新して一致を確認する。
- DonationVault：`0x7a5b5ccc5410e1c9ad4fef8f40bf9786cb842073`。Stamp：`0x853d271ed9461f4e56c449d8c2b7c83b410b4cbb`。
- M1はPC MetaMaskで完了。M2では本人の写真1枚が`temple-01`に掲載済み。画像内容や表示名はログへ記録しない。
- 次の作業：M5a実装をcommitしCloud Build/Cloud Runへ反映、実Central APIとMetaMask deeplink経路を検証する。Cash commandは作らない。成功済みの寄付や本人写真を再送／再公開しない。
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
| M5a-device-state | M5a | Integrator：ATM/Central read-only readiness | M1-e2e | doing | Controller heartbeat/USB disconnect/default unknownでCash disabled・Crypto available。局所health判定を実装。実Central API未検証、現金命令なし |
| M5a-crypto | M5a | Integrator：Central／ATM・Pilgrim／Chain API | M5a-device-state | doing | explicit visit claim→kind=1 intent→通常receipt検証・Stamp→ATM reset、同じIDで冪等。コード／型チェック済み、実Central API未検証 |
| M5a-e2e | M5a | Integrator＋本人 | M5a-crypto | todo | UI/APIの未接続時Crypto only、固定URL MetaMask経路、0.01 USDC onsite test、Central/receipt/mint/Collection、ATM画面復帰 |
| M5a | M5a | Integrator：onsite crypto | M5a-device-state、M5a-crypto、M5a-e2e | doing | onsite Crypto end-to-end。Cash disabledのまま。次のM3を完了したとは扱わない |
| M3-device | M3（次） | Integrator：CashMachineController/ITL | M5a | todo | USB接続後、認証・poller所有・接続／経路／在高・実Readyを確認 |
| M3-cash | M3（次） | Integrator：Central／ATM／Controller | M3-device | todo | 明示cash consent→有限受入→Done／照合→現金寄付・参拝Stamp・ATM写真。結果不明は停止 |
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
| M3/NV200接続 | 現金受付の準備状態は未確認 | M5aではCashをfail-closedで無効にし、現地Cryptoを先に完成。現金受入・Controller実機連携は後続M3 | M5aでは機器操作不要。Cash実装時に準備状況を再確認 |

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

- UTC 2026-11-06 10:15以降／再開約147分。本人優先順位：M5a onsite Crypto while cash is disabled → next M3 cash. SPEC/SDD/TASKSはこの分割と写真取り下げ後回しに一致。実稼働版は`00017-l62`／image `central:a193002`。sourceCommit応答は旧環境値。
- M5a実装：read-only healthによりmissing/stale/disconnected/readyを分類。ただしこの段階では状態に関係なくCash acceptanceはfalse。ATM screen pairing、短命deeplink受付、本人claim、現地kind=1 intent、同じreceipt verification/mint/points/Collectionを接続。Donation unknown中はATMをロックし、確定後だけ同じvisitを解除する。
- `node scripts/check-policy.mjs`合格、570ロック依存の168時間証拠も有効。`pnpm exec tsc --noEmit`と`pnpm run build`成功。`atm.test.ts`、`shared.test.ts`、`donation-receipt.test.ts`、`wallet-network.test.ts`、`policy.test.mjs`は12/12成功・skipなし。APIテストの構文検査成功。実Central APIとオンチェーン送金/mintは未実施。
- Cloud Build `d853fe8b-ecd7-4d99-accb-1cfd1db9d640`成功、image `central:a193002`をrevision `00017-l62`へ配備。`/api/health` ready・Base Sepolia、ATM route HTTP200。応答sourceCommitの環境値は旧値と判明、次の配備でfull SHAへ修正する。
- 実Central `pnpm run test:atm`初回は6/8成功・skipなし。未認証Controller healthの本文を認証より先に検証して400になった問題を特定し、認証を先行する修正を作業中。2件目のoffline/disconnected差は1件目がhealth状態を作る前に停止したことによる連鎖。claim・kind=1 intent・冪等競合試験は成功。送金・mint・写真APIは実行していない。
- 変更中のpathはM5aのsource／docs／testsのみ。実サービスのAPI検証と現地Crypto実送金はこれから。
- 次：認証順序修正をtypecheck/build/API unitで確認→M5a変更を明示pathだけcommit/push→Cloud Build/deploy（SOURCE_COMMIT=full SHA）→live `pnpm run test:atm`を全件成功させる。未接続Cash disabled/MetaMask deeplink/claim/ATM resetを確認。本人MetaMask送金を行う場合は対象額と操作を事前提示し、未知の操作は再送しない。

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
