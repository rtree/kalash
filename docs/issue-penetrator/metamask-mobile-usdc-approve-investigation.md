# MetaMask内蔵ブラウザでUSDC approveが出ない：原因調査

調査日：2026-11-06（JST）。対象はKALASHのAndroid MetaMask内蔵ブラウザ。実機試験は別チームが担当し、本調査はコード・依存ソース・保存済み観測記録・上流issueの照合のみ。送金、Wallet操作、製品コード変更、配備、再現試験は実施していない。

参照KALASH：[`7b72c796255f34ae75857dc867ef7f0211e3c1a5`](https://github.com/rtree/kalash/tree/7b72c796255f34ae75857dc867ef7f0211e3c1a5)。この版のTASKSが記録する稼働版は`00016-w6k`、source `1790e57`。最新コード、稼働版、当時の失敗操作を区別する。本書は文書専用ブランチに保存し、本体や別チームのUX PoCを変更しない。

## 0. 追記：入口・写真の成功と本体への取り込み方針（2026-11-06）

ユーザーは今回、**入口QRをMetaMask内蔵ブラウザで開くDApp deeplink形式にし、KALASHを「モバイルMetaMask内蔵ブラウザ＋PC」前提へ変更する**と決定した。PCは既存のChrome＋MetaMask拡張の経路を基準にする。

- 本人・検証チームの報告では、PCのQR→外部QRリーダー→MetaMask内蔵→指定Cloud Run URLが成功し、queryも保持された。
- 本体でカメラ起動・撮影・Upload／CommunityBoard掲載まで成功との本人報告がある。
- 引用されたPoCサマリでは、同じスマホPoC画面の明示接続とcamera preview→停止は残確認。本体での写真成功と混同しない。

これにより、deeplink入口と写真機能を使う方向へ進める。**本書のApprove不表示を解決済みとする証拠は増えていない。** QR到達、撮影、接続、SIWE、USDC approveはそれぞれ別の境界であり、以下の初発未特定・nested拒否の指摘を引き継ぐ。今回の本体にはまだReownがあり、全面撤去可否も別判断。

本筋は「仕様・SDD・TASKSへ方針反映→deeplink QRを本体化→内蔵／PCの選択済みinjected providerへ統一→本書のApprove課題を解消→Reownの依存削除を別途判断」の順で取り込む。詳細と担当範囲は[導線設計§9](kalash-metamask-browser-journey.md#9-本筋のチームが取り込む順序)。アプリ内QRスキャナーの実装を入口採用の前提にしない。試験はPCのQR→スマホ→固定Cloud Run revisionを維持し、実行中は再配備しない。

照合先：[main `67ab7cc` のTASKS](https://github.com/rtree/kalash/blob/67ab7ccce50fc960b5de1a1a10f5dcb9b038d227/docs/TASKS.md)。以下の原因調査本文は従来の固定参照版 `7b72c796` に対する分析であり、今回の方針追記によって実機再現済みに変わるものではない。

## 1. 結論：直近の停止原因は特定できた。最初の停滞とは別

**記録された直近のDonate再試行は、CentralがHTTP 409 `SIGNED_INTENT_STILL_VALID` を返したため、MetaMaskへの要求に到達していない。** この試行はリレー・NAT・MetaMaskの確認画面の不具合ではない。

しかし、その前に起きた「approve-only operationを登録したのに画面が出なかった」初発の原因は、既存の証拠だけでは一意に特定できない。初発も409だった、とまとめるのは誤り。特定を妨げている具体的なコード上の問題と、停止し得る範囲は判明した。

| 判定 | 分かったこと |
|---|---|
| 記録＋コードで特定 | 直近再試行は署名期限guardの409でWallet要求前に停止。最新記録では当該期限は既に経過している |
| コードで確認 | `approve-request-start` はWalletへの実RPC送信ではなく、`writeContractAsync`直前のログ。MetaMask受信の証拠ではない |
| コードで確認 | 追加されたwalletClient preflightはclientの存在を見るだけ。そのclientをapprove送信に使わず、SDKが接続clientを取得し直す |
| コード＋依存で特定 | Viemが包んだWallet拒否を`isWalletRejection`が見落とし、拒否後にpendingを残す条件付き不具合。今回の実機でそのエラーが返ったかは未観測 |
| 依存ソースで確認 | SDK内に`eth_chainId`等のawaitがあり、custom providerの待ちにはpublic HTTP RPCの10秒timeoutが適用されない |
| MetaMask参照実装で確認 | `eth_sendTransaction`受信後にも、確認画面を出す前の取引分類・コード取得・gas等の処理がある。SIWE成功ではこの経路を検証できない |
| 未確定 | 初発がCentral応答待ち、SDK内待ち、誤ったconnector、MetaMask内部待ち／拒否のどれだったか。実端末のMetaMask版と同一attemptのprovider境界記録がない |

**原因を「MetaMaskが地蔵」「Reownが不安定」とだけ呼ぶ段階は終えられるが、初発の特定済み宣言はまだできない。** 必要なのは大量の再試験ではなく、同じattemptの最後の成功境界を一つ捕まえること。

## 2. 観測を時系列・層別に分ける

| 局面 | 保存済み記録 | 言えること／言えないこと |
|---|---|---|
| PC寄付 | 通常MetaMaskでconfirmed/mintedまで成功 | Vault・基本ABI・Central経路に成功実績。モバイルapproveの証明ではない |
| 過去のdelegated寄付 | 送信済み取引をCentralが拒否、正規イベント検証で復旧 | 送信後の問題。今回の「approve画面が出る前」とは別 |
| Android内蔵SIWE | auth verify HTTP200、Wallet verified表示 | 接続・ログイン署名の成功。取引確認pipelineの成功ではない |
| 初期approve-only操作 | approve operationあり、donateAttempt/hashなし、記録時点のApproval/Donated=0・allowance=0 | 確定済みapproveの証拠がない。Walletが要求を一度も受信していない証拠にはならない |
| Abandon後の再Donate | `SIGNED_INTENT_STILL_VALID`で409、新規intent／Wallet requestなし | この回はCentralのguardで停止したと特定できる |
| 最新preflight修正 | walletClient確認を追加、build/API試験成功の記録 | API試験は実MetaMask画面の代替にならない。修正版の実機完走は記録されていない |

出典：[TASKS](https://github.com/rtree/kalash/blob/7b72c796255f34ae75857dc867ef7f0211e3c1a5/docs/TASKS.md)、[preflight修正commit](https://github.com/rtree/kalash/commit/1790e57b270953160d16f240b164f12e340dfa47)。

記録された最後のcancelled署名の期限は2026-11-06 04:44:27 UTC＝13:44:27 JST。時間経過後の新しい試行を、この古い409だけで説明し続けない。

## 3. 確定した停止経路：Abandon後のguard

```text
通常Donate
  → POST /api/donations
  → createDonationがcancelled intentを検索
  → まだ有効なCentral署名がある
  → 409 SIGNED_INTENT_STILL_VALID
  → App catchでエラー表示
  × allowance readへ進まない
  × approve operationを新規登録しない
  × MetaMaskへ要求しない
```

根拠：[App.tsx L626](https://github.com/rtree/kalash/blob/7b72c796255f34ae75857dc867ef7f0211e3c1a5/src/web/App.tsx#L626)、[donations.ts L37](https://github.com/rtree/kalash/blob/7b72c796255f34ae75857dc867ef7f0211e3c1a5/src/server/donations.ts#L37)。

ここで有効期限を持つのは、Centralが発行した寄付用EIP-712認可署名である。USDCの通常のERC-20 allowanceそのものにこの10分の期限が付くわけではない。アプリでcancelledにしても、発行済み認可署名はオンチェーンで取り消されないため、新しいintentを重ねないguardがある。

AbandonはMetaMaskにapproveを依頼するボタンではなく、Centralで証拠を照合してアプリの操作を終了するボタン。以前のno-promptを直すためにAbandon→Donateを反復すると、別のguardで止まる状態を作り、同じ症状に見える。これは利用者の責任とせず、準備失敗・Wallet待ち・安全な終了を区別しにくいUXとして扱う。

修正方針はguardの削除ではない。「Walletへ未要求」「旧署名が有効なため開始不可」「元取引確認中」を表示し分け、許される次の操作を限定する。

## 4. 初発の要求経路をコードで展開する

```text
App.startDonation
  1. pending・接続・額・設定を確認
  2. 必要ならSIWE、ensureNetwork
  3. POST /api/donations または既存intent再利用
  4. publicClient.readContract(allowance)
  5. walletClient ?? refreshWalletClient()                 ← 最新追加
  6. createOperation('approve')
       local pending保存
       Firebase getIdToken
       POST /operation をawait
  7. approve-request-start を記録                         ← 現在の観測点
  8. writeContractAsync
       TanStack mutation開始待ちの可能性
       Wagmi getConnectorClient
       connector.getChainId / getProvider（分岐によってgetAccounts）
       Viem encodeFunctionData(approve)
       Viem sendTransaction
       provider.request(eth_chainId)
  9. provider.request(eth_sendTransaction 等)              ← ここを未観測
 10. MetaMask bridge / transaction middleware
 11. MetaMask内部の取引前処理
 12. ApprovalController / 確認画面
 13. 本人承認 → hash → receipt → allowance確定
 14. donate処理
```

SDK内の厳密な分岐はconnectorとaccount種別に依存する。後述の出典はKALASHが使うJSON-RPC account経路を追ったもの。MetaMask側の参照コードは公開版であり、端末に入っている版と同じとは確認できていない。

### 4.1 local pending／DB operationは「Walletに届いた」証拠ではない

[createOperation L529](https://github.com/rtree/kalash/blob/7b72c796255f34ae75857dc867ef7f0211e3c1a5/src/web/App.tsx#L529)は、先にlocalStorageへpendingを保存し、それからCentralへPOSTする。Wallet要求はPOST応答の後。

- POST前のtoken更新、POST待ち、応答欠落でもlocal pendingが残る。
- DBにoperationがあっても、応答をページが受け取ったとは限らない。
- [API helper L262](https://github.com/rtree/kalash/blob/7b72c796255f34ae75857dc867ef7f0211e3c1a5/src/web/App.tsx#L262)に明示のfetch timeoutはない。無制限に必ず待つという意味ではないが、App側の有限待機保証がない。
- UIとstartDonationはpendingがあると再開始を止める。重複防止には必要だが、現在は「未要求の準備失敗」と「要求済み未応答」が同じpendingに見える。

**提案：** `preparing → operation_registered → provider_requested → hash_received`を区別する。Centralへ記録できたか不明な場合も、同じattemptIdでサーバー照合する。未送信の証明なしにstorageだけ消して再開しない。

### 4.2 最新のwalletClientチェックはapproveの実行経路を固定していない

SIWEは取得したclientを使っている：

```ts
const signingClient = walletClient ?? (await refreshWalletClient()).data;
await signingClient.signMessage(...);
```

approveでは存在を確認した後、別のactionを呼んでいる：

```ts
const signingClient = walletClient ?? (await refreshWalletClient()).data;
if (!signingClient) throw ...;
await createOperation(...);
await writeContractAsync(...); // signingClientは渡していない
```

根拠：[SIWE L478](https://github.com/rtree/kalash/blob/7b72c796255f34ae75857dc867ef7f0211e3c1a5/src/web/App.tsx#L478)、[approve L643](https://github.com/rtree/kalash/blob/7b72c796255f34ae75857dc867ef7f0211e3c1a5/src/web/App.tsx#L643)。

これで「必ず別providerになる」とは言えない。同じconfig・接続なら通常同じproviderを得られる。しかし、SIWEで成功したclientをapproveがそのまま使った証明にもならない。存在確認だけなので、古いclientのaccount/chainや非同期処理中の接続変更まで保証しない。

**提案：** 検証したclient／connector／account／chainと実送信経路の同一性を明確にする。例として検証済みwallet clientでwriteするか、Wagmi actionへ選択connectorを明示する。ただしどちらもprovider内のchain取得・Wallet処理の待ちを消す万能修正ではない。送信前記録・本人確認・重複防止は維持する。

### 4.3 SDK内の待ちにはpublic HTTP timeoutが効かない

lockで確認した構成はWagmi 3.7.9、core 3.6.7、connectors 8.2.2、Viem 2.57.13、AppKit adapter 1.8.24。参照ソースでは：

- `useWriteContract`はTanStack mutation経由でcore `writeContract`を呼ぶ。
- coreは`getConnectorClient`で接続を解決し直す。
- ViemのJSON-RPC account送信は、送信RPC前に`eth_chainId`をawaitする。
- connectorに使う`custom(provider)`はprovider.requestへ委譲し、public HTTP transportのtimeoutを共有しない。
- この送信経路は`eth_sendTransaction`を基本とし、特定のRPCエラーでは`wallet_sendTransaction`にfallbackする分岐がある。method名を一つと仮定しない。

したがって、10秒のpublic RPC timeoutが設定されていても、approveのWallet側待ちが10秒で終わる保証はない。[U1–U4]

このJSON-RPC account経路でViemが自動的にbalanceOf／simulateContract／estimateGasを全て先行実行すると説明するのも誤り。MetaMask内部のgas処理と、dAppライブラリの前処理を分ける。

### 4.4 TanStackのpausedも低優先の候補

`main.tsx`は既定のQueryClientを使う。mutationがonlineManager上でofflineなら、mutationFnより前でpauseする可能性がある。startログの後にWallet要求がない症状と整合し得るが、現在その観測はない。`isPaused`とonline状態を見れば区別できる。根拠なく`networkMode: 'always'`へ変更しない。

### 4.5 特定できた二次不具合：拒否後にpendingが残る

[isWalletRejection L177](https://github.com/rtree/kalash/blob/7b72c796255f34ae75857dc867ef7f0211e3c1a5/src/web/App.tsx#L177)は、最上位のnameが`UserRejectedRequestError`、または最上位codeが4001／ACTION_REJECTEDの場合だけtrueになる。

しかし、固定版Viemの通常のwriteContractエラー経路は次のように包む。[U5]

```text
ContractFunctionExecutionError         ← Appが受け取る最上位
  cause: TransactionExecutionError
    cause: UserRejectedRequestError    ← code 4001はここ
      cause: 元providerエラー
```

外側にcode4001は転写されないため、KALASHの判定はfalseになり、一般エラー分岐でpendingを残す。**このcause chainを受けた場合の誤分類はソースから特定できる。** 一方、初発の端末でそのcauseが実際に返ったかは記録がなく未確認。

これは次の連鎖を作り得る：

```text
MetaMask／providerが要求を拒否
  → Viemがエラーを包む
  → KALASHは拒否を識別できない
  → approve-only pendingが残る
  → 利用者には承認待ち／Abandonが提示される
  → 期限前Abandon後の再Donateは別の409 guardへ
```

MetaMask側には「非activeタブ」という理由で、確認画面を出さず4001を返す経路もある。これと誤分類が組み合わされば「本人は拒否していないのに画面も出ずpending」という症状を説明できる。ただしこれは検証可能な仮説であって、今回の主因確定ではない。

**提案：** Viemの`BaseError.walk`等、または循環・深さを制限したcause走査で、対応する要求の構造化エラーを分類する。画面文言は「Wallet/providerが要求を拒否」とし、4001だけで「本人がCancelした」と断言しない。一般timeoutや任意メッセージを拒否扱いにしてpending解除しない。修正後も自動再送はしない。

## 5. MetaMask内部：SIWE成功でも取引画面まで通るとは限らない

参照Mobileソース：`49d569cee6aafad37923b4ba71c84204ce851ea6`。実端末の配布版は未特定。下記は停止可能な場所を示し、今回そこが止まったと認定するものではない。[M1–M3]

```text
eth_sendTransaction
  → 対象タブがactiveか
  → originに許可されたaccountか
  → chain指定の整合
  → TransactionController.addTransaction
      permitted accounts / origin検証
      EIP-1559対応確認
      取引種別判定（宛先code取得等）
      afterAdd等のhook
      初期gas設定
  → unapprovedTransactionAdded
  → ApprovalController:addRequest
  → 本人の確認画面
```

- 参照版の`checkTabActive`は非activeタブを拒否する。ここで4001が返っても、本人が画面でCancelを押したとは限らない。
- 取引種別判定にはWallet側の`eth_getCode(to, 'latest')`をawaitする経路がある。エラーをcatchする処理があっても、未解決Promiseの間は先へ進めない。
- Appのpublic RPCが成功しても、MetaMaskが使うRPC／取引前処理が成功した証明にはならない。
- `personal_sign`はSignatureController側の別処理なので、SIWE成功だけでTransactionControllerの正常性を証明できない。
- 調査版の該当middlewareではPPOMの`validateRequest`呼び出しは`addTransaction`の後にある。「危険サイト警告／Blockaidが今回の最初のpopupを止めた」とは、このソースだけから言えない。警告原因もTestnet・Cloud Runだからと断定しない。

よって、providerへ送信RPCを渡したと確認できた後は、MetaMask側の許可・タブ・取引前処理・確認UIのどこかを追う。ネットワーク切断をすべてWalletConnectのせいにしない。

## 6. 診断を難しくしているtraceの具体的欠落

[walletTrace.ts](https://github.com/rtree/kalash/blob/7b72c796255f34ae75857dc867ef7f0211e3c1a5/src/web/walletTrace.ts)を確認した。

| 現在の記録 | 欠けている証拠 |
|---|---|
| approve-request-start | 実provider.requestが呼ばれたmethodと時刻。ライブラリ呼び出し直前の記録に留まる |
| connector文字列 | type・接続先の同一性。metamaskを含む名前が同じ値に正規化される |
| chainId=CHAIN_ID | 対象chainの指定であり、実provider読取結果ではない |
| approve-request-reject | error.code、nested cause、どのmethodで拒否されたか |
| visibilitychange | 実際のvisible/hidden値 |
| メモリ100件 | 再読込前の同一attempt記録。再読込後に過去の記録があったと仮定できない |

**次の一件で最も価値があるのは、選択した実providerの`request`開始／終了とmethodだけ。** payload全文やWalletの秘密は不要。

提案する最小記録：

```text
attemptId / monotonicElapsedMs / stage
connectorId + connectorType + セッション内だけのprovider識別子
targetChainId / observedChainId / account一致boolean
operation POST開始・終了・HTTP status・safe error code
mutation pending/paused
provider method開始・resolve/reject・safe nested error code
visibilityState / foreground復帰
```

観測対象のmethod候補：`eth_accounts`、`eth_chainId`、`wallet_switchEthereumChain`、`eth_sendTransaction`、`wallet_sendTransaction`。実行経路に出たものだけ記録する。probeのために追加の署名・送金要求を発行しない。

別providerを計測しても無意味なので、Wagmiが実際に解決したproviderに境界計測を置く。SDKを二重初期化しない。request引数、calldata全文、署名、token、WC URI、raw session、QRを保存しない。

## 7. 仮説の順位と反証条件

順位は今回の実測確率ではなく、確認コストと既存証拠による調査順。

| 順位 | 仮説／問題 | 現在の根拠 | 反証・特定条件 |
|---|---|---|---|
| 0 | Centralの旧署名guard | 直近試行の409記録と実コード | 別の新しい試行でintent作成が成功したら、その回の原因ではない |
| 1 | Walletへ出す前のAPI・client取得・chain取得で停止 | 多段await、operation記録がWalletより前、境界traceなし | operation応答と実送信RPCの開始が揃えば前段を除外 |
| 2 | providerに渡した後、MetaMask取引前処理／許可で停止、または無画面拒否をAppが誤分類 | 上流ソースに確認画面前のawait・拒否処理。入れ子拒否の誤分類はコード上成立 | 同じRPCのエラーcode、実端末版のWallet診断、受信とUIの観測が必要 |
| 3 | 内蔵ページだが別connector経路を使用 | 自動復元と粗いconnectorログでは区別できない | 実connector typeとprovider同一性を記録。injectedならWC配送障害をこの試行から除外 |
| 4 | TanStack mutation pause | 既定online gatingがある | mutationFn開始・isPaused=falseなら除外 |
| 5 | 依存版不整合 | 調査したpeer範囲に実versionは含まれる、core重複の証拠なし | 現時点では積極的根拠なし。SDK総入替えの理由にしない |

## 8. 誤診を避けるために除外／保留したもの

- **USDCのapprove引数ミス：** 対象は`config.usdc`、spenderは`config.vault`、額は`parseDonationUnits(intent.amount)`。既定0.01 USDCは10000単位であり、10000 USDCとして送る計算にはなっていない。
- **allowanceが十分だから画面を省略：** 一般には正常な分岐だが、今回の保存記録はallowance=0。記録対象の説明にはならない。
- **Wagmi v3＋AppKitだから必ず非互換：** lockは単一core 3.6.7。adapterの宣言peer範囲は導入版を含む。宣言適合は無バグ保証ではないが、主因と断定する証拠はない。
- **Relay/NAT：** injected経路ならWalletConnect relayを通らない。経路を観測してから判断する。
- **iOSの自動復帰問題：** Androidで発生している本件に直接適用しない。同じ症状のissueもOS・版・接続方式が違えば原因証明ではない。
- **Abandonがbusy中でも押せる：** 調査中に候補になったが、参照版のL1114は`disabled={props.busy}`。この版の確定バグとして報告しない。ただしreloadやWallet側要求の寿命は別で、UIのbusy解除はWallet要求取消しの証拠ではない。
- **isWalletRejectionが全拒否を識別：** §4.5のとおり誤分類は成立する。ただし実端末の原因認定には当該エラーの観測が必要。4001を常に「本人がCancelした」と表示しない。

## 9. 別チームに渡す具体的な修正・観測依頼

### 先に直す観測と表示

1. `approve-request-start`を「writeContract action開始」と正しく名付け、実provider境界のmethod開始／終了を別記録する。
2. `preparing / registered / provider-requested / hash-received / outcome-unknown`を分離する。UIも「準備中」「Walletへ依頼済み」「結果照合中」を分ける。
3. APIのHTTP statusとsafe error codeを保持する。現在は説明文は表示するが、Error化で構造化情報が失われる。
4. 選択provider／account／chainと実write経路の同一性を確認する。walletClientのtruthyチェックだけを修了条件にしない。
5. 入れ子のWallet拒否を分類できるようにする。期限前guardは維持し、拒否の分類修正を自動再送の許可にしない。

### 同じ一件での判定表

| 最後に確認できたもの | 次に調べる場所 |
|---|---|
| POST /donations=409 | Central guard。Wallet内部は調べない |
| intentあり、operation応答なし | Firebase token／Central POST／レスポンス経路 |
| operation=200、mutation paused | TanStack online状態 |
| action開始、chain RPC未完了 | connector／選択providerのread処理 |
| eth_sendTransaction等の呼出し前にreject | SDKが返した実nested codeとaccount/chain |
| eth_sendTransaction等を渡した、応答なし、画面なし | 実端末版MetaMaskのtransaction pipeline／タブ／RPC／確認UI |
| hashが戻った | 画面再要求を止め、元receiptを確認 |

AppのタイマーだけではWallet内の要求は取り消せないので、単にtimeoutを追加して次のapproveを許可する変更はしない。タイマーは「遅延を表示して照合へ移る」ために使う。結果不明の自動再送、無限allowance、手動calldata送信、認証やguard削除を解決策にしない。

今回のUX-mobile PoCは接続・URL・camera previewだけで署名／送金が対象外。その成功を本体approve経路の合格に数えない。必要な一件の観測は別チームの許可済み本体試験で行う。

## 10. 出典

下記はGitHub connectorで取得した一次資料。上流の存在する処理を示す資料と、今回の端末で実際に起きた証拠を区別する。上流のissueは報告であり、同一原因の認定ではない。

- [U1：Wagmi core writeContract](https://github.com/wevm/wagmi/blob/4af4d6bd1eba5635043497dcb515944059c122d8/packages/core/src/actions/writeContract.ts#L91)、[getConnectorClient](https://github.com/wevm/wagmi/blob/4af4d6bd1eba5635043497dcb515944059c122d8/packages/core/src/actions/getConnectorClient.ts#L107)。接続clientの再取得。
- [U2：Viem writeContract](https://github.com/wevm/viem/blob/6075b962aa4bc7de4b0ddcef950c290318563a5c/src/actions/wallet/writeContract.ts#L221)、[sendTransaction](https://github.com/wevm/viem/blob/6075b962aa4bc7de4b0ddcef950c290318563a5c/src/actions/wallet/sendTransaction.ts#L221)。chain read、送信RPC、fallbackの実装。
- [U3：Viem custom transport](https://github.com/wevm/viem/blob/6075b962aa4bc7de4b0ddcef950c290318563a5c/src/clients/transports/custom.ts#L35)、[buildRequest](https://github.com/wevm/viem/blob/6075b962aa4bc7de4b0ddcef950c290318563a5c/src/utils/buildRequest.ts)。provider Promiseの委譲。
- [U4：KALASH lockのpeer条件](https://github.com/rtree/kalash/blob/7b72c796255f34ae75857dc867ef7f0211e3c1a5/pnpm-lock.yaml#L803)、[adapter実解決](https://github.com/rtree/kalash/blob/7b72c796255f34ae75857dc867ef7f0211e3c1a5/pnpm-lock.yaml#L3565)、[Wagmi実解決](https://github.com/rtree/kalash/blob/7b72c796255f34ae75857dc867ef7f0211e3c1a5/pnpm-lock.yaml#L6891)。宣言上の依存不整合を主因とする根拠がないこと。
- [U5：getContractError](https://github.com/wevm/viem/blob/6075b962aa4bc7de4b0ddcef950c290318563a5c/src/utils/errors/getContractError.ts#L81)、[getTransactionError](https://github.com/wevm/viem/blob/6075b962aa4bc7de4b0ddcef950c290318563a5c/src/utils/errors/getTransactionError.ts#L32)、[BaseError](https://github.com/wevm/viem/blob/6075b962aa4bc7de4b0ddcef950c290318563a5c/src/errors/base.ts#L37)、[ContractFunctionExecutionError](https://github.com/wevm/viem/blob/6075b962aa4bc7de4b0ddcef950c290318563a5c/src/errors/contract.ts#L140)。causeを保持し最上位に4001を転写しない経路。
- [U6：TanStack retryer](https://github.com/TanStack/query/blob/%40tanstack%2Fquery-core%405.105.0/packages/query-core/src/retryer.ts#L96)、[KALASH main.tsx](https://github.com/rtree/kalash/blob/7b72c796255f34ae75857dc867ef7f0211e3c1a5/src/web/main.tsx)。online gating候補。
- [M1：MetaMask RPC middleware](https://github.com/MetaMask/metamask-mobile/blob/49d569cee6aafad37923b4ba71c84204ce851ea6/app/core/RPCMethods/RPCMethodMiddleware.ts#L527)、[account／chain検証](https://github.com/MetaMask/metamask-mobile/blob/49d569cee6aafad37923b4ba71c84204ce851ea6/app/core/RPCMethods/RPCMethodMiddleware.ts#L141)、[personal_sign側](https://github.com/MetaMask/metamask-mobile/blob/49d569cee6aafad37923b4ba71c84204ce851ea6/app/core/RPCMethods/RPCMethodMiddleware.ts#L801)。
- [M2：MetaMask eth_sendTransaction](https://github.com/MetaMask/metamask-mobile/blob/49d569cee6aafad37923b4ba71c84204ce851ea6/app/core/RPCMethods/eth_sendTransaction.ts#L113)、[PPOM呼び出し位置](https://github.com/MetaMask/metamask-mobile/blob/49d569cee6aafad37923b4ba71c84204ce851ea6/app/core/RPCMethods/eth_sendTransaction.ts#L124)。
- [M3：TransactionController 73.0.0](https://github.com/MetaMask/core/blob/%40metamask%2Ftransaction-controller%4073.0.0/packages/transaction-controller/src/TransactionController.ts#L1122)、[初期gas処理](https://github.com/MetaMask/core/blob/%40metamask%2Ftransaction-controller%4073.0.0/packages/transaction-controller/src/TransactionController.ts#L1226)、[unapproved追加](https://github.com/MetaMask/core/blob/%40metamask%2Ftransaction-controller%4073.0.0/packages/transaction-controller/src/TransactionController.ts#L1286)、[ApprovalController呼び出し](https://github.com/MetaMask/core/blob/%40metamask%2Ftransaction-controller%4073.0.0/packages/transaction-controller/src/TransactionController.ts#L3414)、[取引type判定](https://github.com/MetaMask/core/blob/%40metamask%2Ftransaction-controller%4073.0.0/packages/transaction-controller/src/utils/transaction-type.ts)。参照Mobileの[依存指定](https://github.com/MetaMask/metamask-mobile/blob/49d569cee6aafad37923b4ba71c84204ce851ea6/package.json#L315)。

### 類似issueを今回の原因としなかった理由

| 報告 | 類似点 | 適用限界 |
|---|---|---|
| [MetaMask Mobile #32863](https://github.com/MetaMask/metamask-mobile/issues/32863) | personal_sign成功・eth_sendTransaction画面が前面に出ない報告 | iOS／MetaMask 8.0.4。投稿者はAndroidで起きないと記載。本件Androidへ直接適用不可 |
| [#25150](https://github.com/MetaMask/metamask-mobile/issues/25150) | Samsungで確認画面が遅延／不表示 | Reown AppKit／WalletConnect Link Mode経路、7.61.6 beta。injectedとは別 |
| [#10074](https://github.com/MetaMask/metamask-mobile/issues/10074) | eth_sendTransactionエラー | 旧WalletConnect sessionのInvalid Id。今回そのエラーがある証拠なし |

類似issueから特定版への更新・ダウングレードや保護機能の無効化を推奨しない。まず実端末版と同じ要求の境界証拠を対応させる。
