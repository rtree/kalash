# KALASH 進捗

## 現在のゴール

- ゴール：M1 モバイル寄付。MetaMask内蔵Browserのapprove-only停滞を安全に解決し、新しい0.01 test USDC寄付→Central確認→Stamp→Collection再読込を本人のWallet承認で通す。その後M2写真共有へ戻る。
- チェーン：Base Sepolia（84532）のテストUSDCのみ。実価値の送金は行わない。
- 本番URL：https://kalash-central-548318651344.asia-south1.run.app
- Cloud Run：revision `kalash-central-00012-hvk`、health ready・Base Sepolia・mint有効、source `2af9a24`。early/expired approval resolverを含む。
- DonationVault：`0x7a5b5ccc5410e1c9ad4fef8f40bf9786cb842073`。Stamp：`0x853d271ed9461f4e56c449d8c2b7c83b410b4cbb`。
- M1はPC MetaMaskで完了。M2では本人の写真1枚が`temple-01`に掲載済み。画像内容や表示名はログへ記録しない。
- 次の作業：Verify walletを試した後にKALASHがExploreへ戻りConnect wallet表示になった。再試行せず、端末の接続状態を本人と切り分ける。認証・resolve・新規寄付は未完了。
- 個人用Skill `android-mobile-testing` を `~/.copilot/skills/` に作成。ADB・Chrome・MetaMaskの安全な確認手順を記録した。

## ゴールと担当

| ID | ゴール | 担当・範囲 | 依存 | 状態 | 完了条件・証跡 |
|---|---|---|---|---|---|
| M1-entry | M1 | Integrator：AGENTS、仕様、依存ポリシー | なし | 完了 | 初期入力・preflight・公開手順を保存。初期lock検証539件、監査0件 |
| M1-hosts | M1 | Integrator：ホスト・権限診断 | なし | 完了 | Windows開発、Cloud Build Linux、GCP/Auth/ADBの実態を記録 |
| M1-wallets | M1 | Integrator：テストWallet | M1-entry | 完了 | 役割別Wallet、残高・予算の確認済み。残高が多くても当初予算を増やさない |
| M1-chain | M1 | Contracts：Solidity、ABI、テスト | M1-entry、M1-wallets | 完了 | Base SepoliaへVault/Stamp配備、隔離Chainテスト合格 |
| M1-api | M1 | Integrator：Central/Auth/Firestore | M1-entry | 完了 | 認可、単位、receipt、冪等確定、mintを実Auth/DB/Chainで検証 |
| M1-ui | M1 | Integrator/UI：Pilgrim UI・E2E | M1-api、M1-chain | 完了 | ユーザーがConnect、VerifyWallet、SpendingCap、送金、Central確定、Stamp/CollectionをPC MetaMaskで確認 |
| M1-deploy | M1 | Integrator：Cloud Run | M1-api、M1-ui | 完了 | 実オリジン、runtime SA、Health、mint loop確認 |
| M1-e2e | M1 | Integrator：MetaMask・テスト | M1-deploy | 完了 | PCで2件目も確認済み。先行DelegationManager経路はreceipt証拠を照合し1回だけreconcile |
| M2 | M2 | Integrator：写真・ボード | M1-e2e | 進行中 | 写真の同意・公開・置換・取り下げ・サイズ、実機カメラ確認。運営者取り下げ権限は未実装 |
| M3 | M3 | Integrator：Windows Controller/ITL | M2 | 未着手 | QR紐付け、紙幣収納、受付終了・照合・Stamp |
| M4 | M4 | Integrator：精算・払い出し | M3 | 未着手 | 実入金、管理者承認、実機全量払い出し、在高照合 |
| M5 | M5 | Integrator：現地Crypto | M4 | 未着手 | ATM QR、スマホ送金、両画面とStampの一致 |

## 現在のブロッカー

| 対象 | 確認済み事実 | 次の作業 | 人の操作・再開条件 |
|---|---|---|---|
| M2 写真 | `kalash-donation-photos` はasia-south1、Uniform access、Public access prevention有効、soft-delete 0。Cloud Run runtime SAだけがアプリ用ObjectAdmin | 現行写真API／公開ボードを維持 | 個人写真の追加公開には都度明示同意 |
| M2 カメラ | Android MetaMask内蔵Browserで`getUserMedia`が起動し、撮影・閉じる操作を表示。撮影・アップロードはせずStreamを停止 | 再度撮影する場合は所有者が操作・確認 | 許可プロンプトは本人操作。許可だけでは撮影・公開しない |
| M1 mobile Chrome | Chrome＋MetaMask/WCで接続・アドレス表示後、VerifyWalletが`personal_sign`非対応で失敗（viem 2.57.13）。認証署名・送金は行わず | MetaMask内蔵Browserを優先。認証の迂回や別署名方式への自動fallbackは禁止 | 新しい署名プロンプトは本人が確認 |
| M1 MetaMask SIWE | 再読込後、MetaMask内蔵BrowserのKALASHでaddress表示・Verify walletあり。Verify操作後にExplore/Connect walletへ遷移し、署名画面は出なかった。Cloud Run auth logに新challengeなし（API suiteのauthのみ） | ここで停止。タップを再試行せず、端末でMetaMask接続状態と表示エラーを本人に確認 | 本人がKALASH正規originを確認してから接続を再開。SIWE署名は本人が確認 |
| M1/Mobile Approval | 現intent `0x9c721a5a…2932e`は02:59:43Z作成、03:09:43Z期限、Firestore status=`intent`。登録operationはapproveのみ（10000 units、USDC宛）、donateAttempt/txHashなし。期限切れ。過去確認ではAllowance popupなし、Approval/Donated event 0、Allowance 0 | revision `00012-hvk` / source `2af9a24`配備済み。実Central API 7件成功・skipなし。本人のintentはまだ未解決で、APIが解決時にチェーン証拠を再検証する | MetaMask requestが開いていないことを本人が確認し、Central dialogを明示承認。古い署名を手動送信しない。新規0.01送金はWalletで本人が承認 |
| M3/M4 ITL | 保護APIは認証前HTTP401（認証失敗とは未確定） | 後続ゴールで安全な資格情報を用意して認証 | 紙幣・払い出しは人の立ち会いが必要 |

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
- ユーザーが`temple-01`に写真を1枚登録。状態published、tier1、期限2026-12-05。画像内容・表示名は読まず、公開一覧とprivate objectの存在のみ確認。
- `/board/temple-01`はLotus Courtyardの空状態・Navigationを表示。任意Reown inline scriptのCSP警告が1件あるが視覚上の破綻なし。CSPは緩めない。
- Android撮影：MetaMask内蔵BrowserでCamera permissionを本人が許可した後、Take photo/Close cameraが表示されることを確認。Streamを閉じ、撮影・uploadなし。

## 現在のモバイル状態（安全な復旧が必要）

- 端末はWindowsからADB 37.0.1で認識。Samsung SM_S942Z、Android 16、物理1080×2340。Chromeは`com.android.chrome`、MetaMaskは`io.metamask`。
- MetaMask内蔵DApp BrowserでKALASHのHistory/Collection・写真操作を表示。通常Chrome＋WalletConnectのVerifyWalletは`personal_sign` unavailableで失敗したため、認証を迂回しない。
- Historyへ表示される2件のrecent donationsはどちらもPC Chrome起点で、モバイル購入ではない。3件目の送金は行わない。
- MetaMask内蔵BrowserのDonateはapprove-only操作の途中状態でdisabled。最新Firestore intentは`0x9c721a5a…2932e`、02:59:43Z作成、03:09:43Z期限。status=`intent`、approve operationのみ（attempt `29b1b082…`）、txHash/donateAttemptなし。API test後も本人intentは未解決、本人photo slot 1件維持、test signer slot 0件。再読込後Verify wallet操作でExplore/Connect walletへ戻り、SIWE promptなし・auth challenge記録なし。追加操作を止めた。
- 失効済みapprove-only intent 3件は開始後600ブロック内にUSDC Approval/Vault Donatedがなく、Allowance 0。
- 既存版は期限後だけの解決だった。`src/server/donations.ts`のローカル変更は、approve-only・owner・イベント不在・Allowance 0を再検証し、deadline前は`cancelled`、期限後は`expired`とする。期限前cancelは署名を無効化せず期限まで有効であることを表示。署名・送金・Firestore削除はしない。
- 型チェック/buildと局所9件（skipなし）、Cloud Build `54757330-06b2-431b-b9b8-f431eca87b12`成功、Cloud Run `00012-hvk`配備済み。live Central API 7件成功・skipなし。Commit/push済み。API testは専用signerのapprove-only intentをcancelledにしたが、本人のintentには触れていない。残り：MetaMask requestなしを本人が確認してdialogを進め、resolverで現intentを再照合する。新しい0.01寄付は既存intent解決後のみ。
- 予期しないMetaMaskページが開いた場合は操作・入力しない。所有者が正規KALASH画面へ戻したことを確認する。Wallet unlock、生体認証、カメラ権限、Spend/Donate署名は本人が行う。

## 過去のM1調査（要約）

- Node 26.13.0、pnpm 10.34.9を固定。依存は168時間条件を満たし、`node scripts/check-policy.mjs`をinstall/build/test/deploy前に実行。
- GCP project `kalash-donation`、asia-south1、Firebase Auth/Firestore/Secret Manager、Cloud Runを構成。Windows ARM64 Ganache制約はCloud Build Linuxへ移行。
- PC WalletConnect/MetaMaskではSIWE nonce期限切れ、async Firebase restore、Base unit/USDC allowance表示の問題を修正。Mainnet送金は禁止。
- AndroidのMetaMask deeplinkが既存ページへ戻る場合があるため、URL originを必ず確認する。CDP/UIAutomatorの生ログや全タブ一覧は個人情報を含むので出力・保存しない。

## 引き継ぎ

- 完了：M1全体、delegated receipt復旧、M2のprivate photo API/boardとカメラ実装、PC MetaMaskの実寄付、写真のpublic listing。
- 未完：Approval-only stale stateのguarded解決、モバイルでの新規寄付成功確認、Camera preview実画面、Temple/operator withdrawal、M3～M5。
- 人の操作：Allowカメラを押下済み。以降の撮影・同意・ウォレット署名・支払いは都度本人が確認する。
- 次の一手：端末に表示されているConnect wallet状態とMetaMaskの表示を本人に確認してもらい、最初の失敗がProvider接続かSIWE前かを切り分ける。返答まではADB操作・署名・送金を停止。復旧後にSIWE、approve-only resolve、既存intent解決を順に確認し、新規0.01 USDC送金は最後に本人が承認する。
