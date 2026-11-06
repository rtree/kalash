# モバイルWallet・MetaMaskの検証プレイブック

調査日：2026-11-06（JST）。目的は「どの経路の、どの段階で止まったか」を証拠で特定し、同じ操作を安全に完走させること。全端末での成功保証ではない。各ゲートを実端末で通った経路だけを対応済みとする。

この文書は公式仕様・公開アプリのソース・KALASHの保存済み記録を照合した机上調査であり、今回新たな実機試験・送金・デプロイはしていない。動作の正本は `../TASKS.md`、設計の正本は `../SDD.md`。本書の提案を実装済みと扱わない。

KALASH参照版：[`5bc559a`](https://github.com/rtree/kalash/tree/5bc559ada99a3e394c64e8d308c91f285cddb6cf)。ユーザー提供の過去メモは `ef6e807`・`apps/web-public/...` 構成で、今回の `src/web/...` 構成とは異なる。SIWE省略、操作資格情報、storage形式、approve復旧条件を混ぜない。

## 1. 原理：接続の方向、メッセージの方向、アプリ起動を分ける

### Chrome＋WalletConnect

```text
接続を開始する方向（両方ともスマホから外向き）

スマホのChrome内SDK ── TLS/WebSocket A ──→ 外部リレー
スマホのMetaMask    ── TLS/WebSocket B ──→ 外部リレー

既存接続上の要求・応答（双方向）

Chrome内SDK ═══ A ═══ 外部リレー ═══ B ═══ MetaMask
   暗号化した署名要求 ─────────────────────→
   ←───────────────────── 暗号化した結果

アプリ起動（上の通信とは別）

Chrome → ディープリンク → Android/iOS → MetaMaskを前面にする
```

- サイトとWalletConnect SDKはスマホのブラウザ内で実行。リレーは外部サーバー。署名と鍵管理はWallet側。
- MetaMaskはインターネットから新規TCP接続を受けるサーバーではない。端末から作った接続の戻りを使うため、通常NATのポート開放は不要。WebSocket禁止・アイドル切断・回線切替は別途起こる。
- リレーへのpublish成功は、MetaMaskが画面を出した証拠でも本人承認の証拠でもない。
- 暗号化通信でも、リレーが接続先などの配送メタデータを全く観測できないという意味ではない。
- リレーのTTL付き保持や再接続は復旧を支えるが、OS停止中のアプリに確認画面を必ず表示させる保証ではない。[S1–S3]

### MetaMask内蔵ブラウザ＋injected provider

```text
スマホのMetaMaskアプリ
  WebView内のKALASH JavaScript
    → 注入されたprovider → アプリ内部bridge → Walletの確認・署名

外部通信は残る
  WebView → Central：認証、intent、状態、写真
  WebView／Wallet／Central → チェーンRPC：read、送信、receipt
```

実際にinjected経路を選んだ場合、署名要求配送にWalletConnectリレーを必要としない。単に内蔵ブラウザで開いただけでは接続経路を断定しない。前のWalletConnect接続が復元される場合は選択connectorを確認する。[S4]

### 四つの寿命を別管理する

| 対象 | 切れた・失効した時の意味 | 復旧の基準 |
|---|---|---|
| ネット接続 | WebSocket/TLSが切れた | 再接続・再購読。新規署名はしない |
| Walletセッション | 許可アカウント・chain・methodsの有効性 | 同じ相手の状態を確認。必要時だけ本人が再接続 |
| 個別Wallet要求 | 署名・approve・donateの未応答／期限切れ | 旧要求と元取引を照合。timeoutを取消しと解釈しない |
| 業務状態 | Central認証、donationId、cashSessionId、photoId | サーバーから復元。ブラウザstorageだけを台帳にしない |

## 2. 調べた実例：採用できる考え方と、証明できないこと

以下は当該ソースに実装がある証拠。調査者が各サービスを実スマホで完走した証拠ではない。

| 実例 | 確認できた工夫 | KALASHへ持ち込む判断 |
|---|---|---|
| Uniswap interface | モバイルでinjected Walletを一つ検出した場合、それだけを表示する経路。公開read RPCとWallet依頼の扱いを分離。WalletConnectの複数client間でstorage名前空間を分ける処理 | 内蔵ブラウザでは選択providerを明示。SDKを二重初期化しない。別clientのcleanupが有効sessionを壊す構成を避ける [A1] |
| Uniswap interface | Uniswap Wallet向けモバイルリンクに、popupに依存しないページ遷移を用いる実装 | ユーザーの一操作からリンクを開く。別タブが増える導線を最小化。MetaMaskの実機成功例と取り違えない [A1] |
| Aave interface | MetaMask委任取引で、送信済みなのにライブラリが解析エラーを返す場合のtransactionHash／receipt回収処理 | provider例外を即「未送信」にしない。取引hashがある場合は元取引を確認。曖昧な全エラーを成功扱いしない [A2] |
| MetaMask Mobile本体 | WebViewへのprovider注入とアプリ内bridge、QRスキャンRPC、カメラ権限に関する実装 | 内蔵ブラウザ経路は具体的な実装根拠がある。ただしKALASH対象端末・版のcamera／QR成功は別ゲート [S4–S6] |
| KALASH | 直接EOA前提でdelegated donationを拒否した後、正規VaultイベントとUSDC移動を検証して既存取引を復旧。PC MetaMask成功、内蔵ブラウザSIWE成功の記録 | 今の障害を過去のCentral問題と混同しない。内蔵ブラウザのapprove表示以降は未完了 [K1] |

SDKの固定版・構成が違うため、他アプリのconnector配列やprivate APIをそのままコピーしない。事例が示すのは設計上の対策であり、成功率の比較ではない。

## 3. 検証開始前に固定するもの

- 端末／OS／Chrome／MetaMask版、正規origin、配備revision、ソースcommit、connector id/type、chainId、試験ケース番号。
- PC拡張、Android内蔵、Android Chrome＋WalletConnect、iOS内蔵、iOS外部ブラウザを別経路とする。Android成功をiOS成功にしない。
- 一台・一担当・一対象タブ。試験中に配備やSDK版を変えない。変更したらそのケースを同条件で再実行する。
- WalletとCentralの既存pending操作を先に確認する。現在の本人操作とテストsigner操作を混ぜない。
- testnet・許可額・spender・recipient・操作範囲を確認。本人の署名・撮影・公開の同意を自動化しない。
- このゲート表は順に使うが、写真検証のために毎回新しく寄付しない。既存confirmed寄付から写真ゲートへ入れる。

## 4. 順番に確証を取るゲート

失敗したら当該ケースの依存操作を止める。読み取り調査と独立ケースは継続可能。15分新しい証拠が出なければ、仮説・最後の成功段階・版・関連ID・次の一操作に絞って引き継ぐ。

| Gate | 操作・観測 | 通過の証拠 | 通らない時の次の一手 |
|---|---|---|---|
| G0 配備・入口 | 正規URLを開き配備情報とassetを確認 | 同じrevision、origin、設定。必要APIが到達可能 | JS/config/CSP/HTTPを確認。Wallet問題と呼ばない |
| G1 provider | 対象connectorを選びgetProvider／準備状態を確認 | 実providerが存在し、選択経路が記録される | 登録済みconnectorと利用可能providerを区別。遅い注入・hydrationを確認 |
| G2 接続 | 本人がconnectを承認 | provider上のaccount、Appのaccountが一致。WCは成立済みnamespacesのaccounts/methodsを照合 | 古い接続・別providerを確認。connect成功だけで署名可能にしない |
| G3 chain | `eth_chainId`、public RPC、Central設定を照合 | Base Sepolia 84532／0x14a34。切替後に再読取 | 切替拒否なら停止。未知chain追加は正規設定を提示。QRからRPCを採用しない |
| G4 SIWE | nonce取得→署名依頼→Central検証→Firebase復元 | 署名結果、auth verify成功、認証済みの本人API、再読込後の同一本人 | provider未呼出、method不可、nonce失効、API失敗を区別。署名方式の弱化で通さない |
| G5 送信前read | allowance/balance、必要ならsimulate | 対象RPCと所要時間が分かり、値を取得。失敗を0にしない | readを有限timeoutで止める。Wallet要求をまだ出していないと表示 |
| G6 approve | 操作記録後、必要額のapproveを一度だけ依頼 | provider要求開始、Wallet画面、本人承認、hash／receipt、公開allowance照合 | 画面が出なければ要求開始まで来たか確認。Abandonは承認ではない |
| G7 donate | 同じintentと期限・chain・accountを再確認し一度送信 | donationのhashまたは正規イベントによる同一取引発見 | timeout／復帰失敗はunknown。再送しない |
| G8 Central | 正規chain・Vault・成功receipt・canonical block・event・donor・intent・金額を照合 | 永続confirmed、ポイント一回加算、mint予約一件 | 外側from/toと実寄付者を混同しない。TX/CALL/EVENT/TRANSFERのどの検証失敗か識別 |
| G9 mint・再開 | Wallet／ブラウザを閉じて後から再確認 | 同じdonationIdのmint receipt、Collection/History再読込一致 | mint jobの状態と元mint hashを確認。ブラウザ停止で処理を失わない |
| G10 QR・写真 | 次文書のQR・カメラ試験を実行 | 同じ受付ID、許可後の実映像、同意前未送信、公開・取り下げ結果 | QR成功と現金受付成功を分離。camera失敗は画像選択／skipへ |

### 「provider要求開始」の記録位置

`writeContractAsync()`直前のログだけでは、その内部でRPC read等が待っていないと証明できない。可能な範囲で、選択済みEIP-1193 providerへ実際に要求が渡る境界も計測する。SDKのprivate内部を書き換えず、対応する公開hook／transport instrumentationを使う。

記録項目例（提案であり現行実装済みの宣言ではない）：

```text
caseId / attemptId / stage / wallClockUtc / elapsedMs
connectorId / connectorType / targetChainId / visibilityState
requestMethod / started | resolved | rejected / sanitizedErrorCode
```

```text
click → preflight開始/終了 → operation保存
→ provider.request開始 → Wallet表示（本人確認）
→ 本人承認 → provider応答 → receipt → Central確定 → mint
```

人の確認待ちをRPC待ち時間に含めない。署名本文・署名値・session topic/key・WC URI・QR全文・認証token・生のprovider/session・写真をログへ残さない。実IDはアクセス制限した証拠と結び、公開文書には転載しない。

## 5. 制御できる待ちと、取消せない要求

### 公開readとWallet要求

公開readは明示RPCで有限timeout／限定retry。Walletへの署名依頼は別経路。KALASH参照版はpublic transportを `https://sepolia.base.org`、timeout 10秒、retryCount 0に設定済み。過去メモの「9分38秒待ち」を今回の原因と断定しない。[K2]

モバイルのアプリ起動はuser gestureと関係する。特にiOSの公式ガイドは、リンク起動前の非同期nonce取得等で自動遷移が失敗する場合を示す。事前準備を終えて「Walletで確認」ボタンを有効化し、最後に鮮度を確認して一度依頼する構成を検討する。古いnonce／amount／accountを再利用しない。iOSの制約をAndroid障害の原因と断定しない。[S3]

`Promise.race`で画面をtimeoutにしてもWallet内の要求を取り消せない。後から成功することがある。遅着したreadが期限切れ操作を自動送信しないように、操作世代／有効性を検査する。再接続・visibilitychange・pageshowは状態照合の契機であって自動署名の契機ではない。

### approveとdonateの復旧

- approve前に操作種別・intent・本人・chain・対象token/spender・額を保存する。
- approve hash不明でもallowanceやApprovalイベントで情報は得られる。ただし十分なallowanceだけで「この要求は完了し、Walletにも残っていない」と証明できない。
- donationの結果不明をallowanceだけで解除しない。donationIdに拘束した正規イベント・元receiptを探す。
- 現KALASHのapprove-only終了は、owner・操作履歴・イベント不在・allowanceゼロ等の再確認が必要。アプリのcancelledはオンチェーン署名の失効ではない。期限前cancel後の旧署名が有効な間は、新規intentを重ねないguardがある。[K3]
- 旧メモの「正確なallowanceでapproveを再送せず継続」と、現行の「ゼロallowance等を確認して古いintentを終了」は別契約。混用しない。
- Libraryがエラーを返しても送信済みの可能性がある。返却hashがあれば先に照合する。Aaveの委任取引対応が実例。[A2]

### SIWEとスマートアカウント

接続、SIWE、ERC-20 approve、donate、委任署名は別の認可。SIWEはdomain/URI/chain/nonce/期限/署名を検証する。`personal_sign`は署名を頼むmethodで、SIWEはメッセージと検証規則。[S7–S9]

EIP-7702でコードを持つEOAと、コントラクトWalletを同一扱いしない。EOA署名で検証できる構成もあり、別のコントラクトWalletではERC-1271等の検証が必要になり得る。現行KALASHはviemのstandalone `verifyMessage` を使う。対象Walletの対応範囲を試験で明示し、全スマートアカウント対応と宣言しない。[K4]

## 6. 失敗を注入する試験表

まずread-only／専用fixtureで試し、実送金は本人が許可した限定ケースだけ。異常系ごとに新しい寄付を繰り返す必要はない。

| ケース | 期待動作・合格条件 |
|---|---|
| 接続拒否／SIWE拒否 | 明示エラー、未認証、支払いは出ない |
| nonce失効 | 新challenge取得の導線。期限切れ署名を成功扱いしない |
| chain/account変更 | 依存状態を無効化し本人・金額・chainを再確認 |
| read timeout | 署名要求が未送信と区別でき、readだけを再試行できる |
| Wallet要求後にアプリ往復 | 同じ操作を再取得。新規要求を重ねない |
| approve承認後に応答欠落 | allowance/receipt/操作履歴を照合。donateの自動再開を競合させない |
| donate承認後にhash欠落 | unknown保持、同一donationId探索／復旧。二重送金なし |
| Wi-Fi→携帯、画面ロック、OSによる終了 | 復帰後の認証・操作状態を復元。セッション消失を未送信にしない |
| Central応答だけ欠落 | 同じIDを再取得し重複ポイント・mintを防ぐ |
| delegated取引 | 直接取引と同じ厳密な業務証拠で確定。外側from/toだけで拒否しない |
| カメラ許可待ち中の離脱 | 遅れて取得したStreamも即停止。本人変更後に前の写真や同意が残らない |
| QR期限切れ・二度読み・別寺院・別人 | サーバーで拒否／冪等応答。QR読み取りだけで現金権限を与えない |

対応宣言には経路別に「通常一本」「同一ID再読込」「中断から復旧」を残す。成功件数／試行件数・失敗段階を記録し、少数成功から一般的な成功率を主張しない。

## 7. ADBを使う時の最短観測

1. `adb devices -l`で対象を選び、以降は毎回`-s <serial>`。unauthorized/offlineなら本人に接続を戻してもらう。
2. Android ChromeはPCの`chrome://inspect/#devices`で対象KALASHタブだけを観測。必要なDOM状態・限定したNetwork status/errorを見る。HARや全タブ一覧を保存しない。
3. MetaMask release版のWebViewはCDP公開を前提にしない。公式ソースにもtest環境限定debug設定がある。ADBの前面アプリ・必要な画面確認＋サイトのsanitized trace＋Central状態を組み合わせる。[S4]
4. screenshotは初期・重要遷移・失敗時。実映像の確認は必要だが、クリック毎の全画面撮影を必須にしない。秘密画面を撮らず、一時画像は確認後に削除。
5. `provider開始なし`ならApp内の最後のawaitへ。`開始済み・Wallet画面なし`なら経路とsessionへ。`本人承認済み・応答なし`なら同じ操作のチェーン／サーバー状態へ。

## 8. 現在のKALASHに対する適用順

参照TASKSではSIWEはHTTP200と本人画面で確認済み。内蔵ブラウザのapprove要求表示が未完了。CentralのAbandonは状態を照合してintentを終了するAPIで、MetaMaskのSpendingCap承認ではない。[K1]

1. 版と選択connectorを固定し、旧pendingを通常の復旧導線で照合する。
2. 通常Donateを一度だけ操作し、G5→G6の境界で止まる場所を観測。promptが出ないからAbandonを反復しない。
3. Reownを必須にしない内蔵ブラウザ導線を別ケースとして実装・検証する。具体案は [KALASH導線設計](kalash-metamask-browser-journey.md)。
4. M2の写真試験は既存confirmed寄付を使って並行して進める。モバイルの新規寄付成功を写真の必須前提にしない。

## 9. 出典と証拠の範囲

調査環境のHTTPプロキシ接続が失敗したため、公式ドキュメントのGitHub原文と公開ソースをGitHub connectorで確認した。Web上の最新画面やストア配布版の実挙動を今回検証したという意味ではない。外部ソースの詳細は次文書の出典も参照。

- [S1] [WalletConnect Relay Server RPC](https://github.com/WalletConnect/walletconnect-specs/blob/ecbbf6e114687812fd0366fb59dff8c0a8e3c9ec/docs/specs/servers/relay/relay-server-rpc.md)、[Relay Client API](https://github.com/WalletConnect/walletconnect-specs/blob/ecbbf6e114687812fd0366fb59dff8c0a8e3c9ec/docs/specs/clients/core/relay/relay-client-api.md)。publish/subscribe、TTL、未配送メッセージ取得。
- [S2] [WalletConnect session namespaces](https://github.com/WalletConnect/walletconnect-specs/blob/ecbbf6e114687812fd0366fb59dff8c0a8e3c9ec/docs/specs/clients/sign/namespaces.md)。成立済みmethods/accountsを確認する。chainsフィールド省略時はCAIP-10 accountsも参照。
- [S3] [WalletConnect iOS mobile linking](https://github.com/WalletConnect/walletconnect-docs/blob/5e6ba2d5a94b4915b20e5b99a046be19c891d9a2/docs/walletkit/ios/mobile-linking.mdx)。iOS user gesture・非同期処理・手動復帰の制約。
- [S4] [MetaMask Mobile BrowserTab](https://github.com/MetaMask/metamask-mobile/blob/49d569cee6aafad37923b4ba71c84204ce851ea6/app/components/Views/BrowserTab/BrowserTab.tsx)。provider注入・bridge・WebView設定。
- [S5] [MetaMask deeplink公式原文](https://github.com/MetaMask/metamask-docs/blob/f58d8cc892fea000e08fd43c255f5de94929b019/metamask-connect/evm/guides/metamask-exclusive/use-deeplinks.md)。
- [S6] [MetaMask wallet_scanQRCode](https://github.com/MetaMask/metamask-docs/blob/f58d8cc892fea000e08fd43c255f5de94929b019/metamask-connect/evm/reference/json-rpc-api/wallet_scanQRCode.mdx)。実装との違いは次文書。
- [S7] [EIP-1193](https://eips.ethereum.org/EIPS/eip-1193)：provider.request、events、エラーコード。
- [S8] [EIP-6963](https://eips.ethereum.org/EIPS/eip-6963)：複数injected providerの発見。
- [S9] [ERC-4361原文](https://github.com/ethereum/ERCs/blob/master/ERCS/erc-4361.md)：SIWE。署名検証対象とnonce。
- [A1] Uniswap interface固定版： [useOrderedWalletConnectors](https://github.com/Uniswap/interface/blob/1f602ef0e4053145c44fc5cd64042d7182a902fd/apps/web/src/connection/hooks/useOrderedWalletConnectors.ts)、[instrumentWalletConnectRpc](https://github.com/Uniswap/interface/blob/1f602ef0e4053145c44fc5cd64042d7182a902fd/apps/web/src/connection/instrumentWalletConnectRpc.ts)、[walletConnect](https://github.com/Uniswap/interface/blob/1f602ef0e4053145c44fc5cd64042d7182a902fd/apps/web/src/connection/walletConnect.ts)、[実機を区別するsession試験計画](https://github.com/Uniswap/interface/blob/1f602ef0e4053145c44fc5cd64042d7182a902fd/packages/casebook/walletconnect/scenarios/session.md)。
- [A2] [Aave Web3Provider](https://github.com/aave/interface/blob/88a3f4e62a00d5448c2e0fcab065cebbb9f34159/src/libs/web3-data-provider/Web3Provider.tsx)。Delegation Framework等の送信済み例外の扱い。
- [K1] [KALASH TASKS](https://github.com/rtree/kalash/blob/5bc559ada99a3e394c64e8d308c91f285cddb6cf/docs/TASKS.md)。保存済み観測の参照であり、今回の実機観測ではない。
- [K2] [runtime.ts](https://github.com/rtree/kalash/blob/5bc559ada99a3e394c64e8d308c91f285cddb6cf/src/web/runtime.ts)、[App.tsx](https://github.com/rtree/kalash/blob/5bc559ada99a3e394c64e8d308c91f285cddb6cf/src/web/App.tsx)。
- [K3] [donations.ts](https://github.com/rtree/kalash/blob/5bc559ada99a3e394c64e8d308c91f285cddb6cf/src/server/donations.ts)。
- [K4] [authentication.ts](https://github.com/rtree/kalash/blob/5bc559ada99a3e394c64e8d308c91f285cddb6cf/src/server/authentication.ts)。
