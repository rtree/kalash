# UX-mobile PoC：調査根拠と採用範囲

調査日：2026-11-06。進捗・配備版・実機結果の正本は [TASKS](../../TASKS.md)、隔離方針は [SDD](../../SDD.md)。本書は調査資料であり、実機合格の宣言ではない。

## 1. 結論

主経路は **PC ChromeのMetaMask拡張／スマホのMetaMask内蔵Browserに注入されたprovider**。Reown、WalletConnect、MetaMask Connect SDKを追加せず、独立HTTPS PoCで入口とカメラpreviewだけを切り分ける。

PCに表示したQRを、本人がスマホの標準カメラまたは選んだ外部QRリーダーで読む。推奨リンクは現行公式の `https://link.metamask.io/dapp/{dappUrl}` [M1]。これはページを開くリンクで、接続・本人認証・支払いの許可ではない。

| 区分 | この調査で言えること |
|---|---|
| 文献で確認 | 公式deeplink、injected provider API、カメラのWeb API条件とMetaMaskの公開fixture |
| 本PoCで未検証 | 実端末のQR→正しいページ到達、接続、動く映像、停止・復帰。本人の試験が必要 |
| 対応対象外 | 外部モバイルChromeからのrelay接続、MetaMask内蔵QRスキャナー、Web QR decoder、署名、送金、静止画取得、録画、upload |
| 保証できない | 任意のQRリーダー・全OS・全MetaMask版での自動遷移。Androidの結果からiOSを推定しない |

## 2. 指定された先行資料の確認

GitHub APIのContents取得を `ref=8ef70e0750f36b289d8e43d817698f510d7b20f0` に固定し、次の2資料を全文確認した。checkout／fetchや原文の再配置はしていない。

- [MetaMask Browser導線案](https://github.com/rtree/kalash/blob/8ef70e0750f36b289d8e43d817698f510d7b20f0/docs/issue-penetrator/kalash-metamask-browser-journey.md)：injected主経路、通常HTTPS入口とdeeplink、QRの用途分離、cameraの実映像確認を提案。今回採るのは非秘密URLの入口とpreviewだけ。native scanner、受付claim、寄付・写真公開は採らない。
- [モバイルWallet検証プレイブック](https://github.com/rtree/kalash/blob/8ef70e0750f36b289d8e43d817698f510d7b20f0/docs/issue-penetrator/mobile-wallet-verification-playbook.md)：アプリ起動、provider、本人許可、業務確定を別ゲートにする。版・経路を固定し、実行した経路だけを評価する。本PoCに支払いゲートを持ち込まない。

両資料自身も「机上調査・今回の実機試験なし」と明記している。過去TASKSを引用した観測は、本PoCの実測ではない。

**ローカルにない理由の証拠範囲：** 取得時HEAD `e17994904e21e9d472ea1d1d7d71612073081ba4` の追跡一覧・ローカル履歴に当該2ファイルはなく、指定commitは両ファイルを追加している。GitHubの[compare](https://github.com/rtree/kalash/compare/e17994904e21e9d472ea1d1d7d71612073081ba4...8ef70e0750f36b289d8e43d817698f510d7b20f0)は `diverged`、ahead 1／behind 4、共通祖先 `5bc559ada99a3e394c64e8d308c91f285cddb6cf`。この時点で別系統の変更だったことまでは確認できる。「削除された」「誰かが失念した」という理由は確認できない。

## 3. UIに載せるURLとエンコード

以下は配備前のプレースホルダー。実際のorigin／pathは統合担当が確定する。ルート配信なら次の組：

```text
通常の到達先：
https://<POC_HOST>/?mode=phone&case=external-qr

主QR／「MetaMaskで開く」：
https://link.metamask.io/dapp/<POC_HOST>/?mode=phone&case=external-qr
```

サブパス配信なら、例えば到達先の `/lab/` をdeeplink側でも `<POC_HOST>/lab/?mode=phone&case=external-qr` と保持する。

- 許可したHTTPS originとpathnameから組み立て、元ページの任意query／hashは引き継がない。PoCのqueryは `mode=phone` と `case=external-qr` のみ。
- `/dapp/` の後ろは **host＋pathname＋search**。`https://` は公式例に合わせて省く。全体を `encodeURIComponent` で包まない。構造を表す `/`、`?`、`&`、`=` は保持し、値やpath要素に必要なエスケープだけを通常のURL処理で行う。
- 既に `%xx` になったpathを二重エンコード／二重デコードしない。QR本文の区切りは `&` であり、HTML表記の `&amp;` を文字列として入れない。
- 認証token、署名、WalletConnect URI、任意の転送先、資格情報はURLに含めない。deeplink resolverもURLを扱う外部サービスであり、秘密を運ぶ経路ではない。

現行公式ページは構文と裸のhostの例を示す一方、全query／fragmentの厳密な搬送契約までは定義していない。[M1]
固定版の公式Mobile `getDappUrlFromUniversalLink` は `/dapp/` 以降を取り出してHTTPSを補い、`handleBrowserUrl` が `newTabUrl` に渡す。[M4]
これは上記形式の実装根拠だが、resolver・OS・ストア配布版を含む成功保証ではない。特殊文字やfragmentの一般対応は今回のASCII queryの合格から推定しない。

`metamask.app.link` は旧形式として見かけるが、主リンクには使わない。調査した公式Android manifestは新旧両hostを宣言しており、旧hostが全面廃止・全端末非対応と断定する根拠もない。[M5]

## 4. 到達・provider・カメラを別に判定

**QR → リーダーの確認／外部ブラウザ → MetaMask起動 → 正しいorigin/path/query → provider → 明示接続 → camera preview** を別々に記録する。前面にMetaMaskが出ただけでは到達成功ではない。warm起動で以前の無関係なページが残る場合を必ず試す。

QRリーダーはURLを文字列として表示するだけの場合も、独自WebViewで開く場合もある。OSのリンク関連付け、本人のタップ、インストール状態にも依存する。公式も第三者in-app browserのdeeplink挙動の不一致を注意している。[M2] 失敗時は通常HTTPS URLを本人がMetaMask Browserへ手入力する救済経路を残すが、その成功をQR成功に置き換えない。

### Provider

- EIP-6963で候補を発見し、本人が選んだ同一providerに対して操作する。発見だけで接続許可済みとは扱わない。必要なら `window.ethereum` を明示的なfallback候補にする。[M3]
- `info.rdns`／名前／アイコンは自己申告、`uuid` はページ内の識別子。`io.metamask` や `isMetaMask === true` は認証されたMetaMask本体の証明ではない。EIP-6963もなりすまし可能性を明記する。[M3, E1]
- EIP-6963の存在だけでinjected／relayの経路も証明できない。公式SDK自身もproviderをannounceできる。[M3] 本PoCはSDKを読み込まない構成と本人の実環境選択を合わせて扱う。
- 本人の接続ボタンからの `eth_requestAccounts` と、アカウント数・`eth_chainId` の確認まで。署名、chain切替、送金を自動要求しない。chain接続の `isConnected()` はアカウント共有許可と別。

### Camera

- 有効なHTTPS、`isSecureContext`、`navigator.mediaDevices.getUserMedia`、activeなページ、OS側のMetaMask権限とサイト側の許可が必要。iframeではPermissions Policyも関係するため、PoCはトップレベルで開く。[W1]
- 本人の開始操作で `audio: false` の映像のみ。`facingMode` は希望指定に留め、非対応の厳格な制約で起動を妨げない。videoは `muted`／`playsinline` を用い、再生拒否と権限拒否を区別する。
- 許可済み・Promise成功だけでなく、本人が動く非私的な対象を見て、正のvideo寸法、video trackの `live` を照合する。公式camera fixtureはAPI成功の存在証拠であり、利用端末のlive preview成功証拠ではない。[M6]
- 停止・画面離脱・背景化では全trackを停止し、videoの `srcObject` を外す。復帰後は本人が再開。許可待ち中の停止後に遅れてstreamが届いても停止する。[W2]
- `NotAllowedError` は拒否だけでなく権限policy等でも起こる。`NotFoundError`、`NotReadableError`、`OverconstrainedError` を別に扱う。OSのcamera表示だけで、本PoCが使うtrackの状態を断定しない。
- 静止画取得・録画・画像uploadはしない。映像そのものや生のエラー／provider objectを証拠として保存しない。

## 5. 今回確認した一次資料

Context7は `/metamask/metamask-docs` を解決し、deeplink・provider・mobile cameraの3照会を実施。camera照会には具体的な動作保証が出なかったため、Web標準資料と公式ソースで補った。以下のWeb本文／ソースを確認し、先行資料の記述だけに依存していない。

- [M1：MetaMask公式deeplink](https://docs.metamask.io/metamask-connect/evm/guides/metamask-exclusive/use-deeplinks/) — 現行host、DApp構文、未導入時download案内。
- [M2：公式supported platforms](https://docs.metamask.io/metamask-connect/supported-platforms/) — in-app DAppリンクと第三者WebViewの注意。SDK全体の対応表をSDKなしPoCの実績に転用しない。
- [M3：公式provider API](https://docs.metamask.io/metamask-connect/evm/reference/provider-api/)、[E1：EIP-6963](https://eips.ethereum.org/EIPS/eip-6963) — 発見方法、自己申告identityの限界。
- [M4：公式handleDappUrl](https://github.com/MetaMask/metamask-mobile/blob/49d569cee6aafad37923b4ba71c84204ce851ea6/app/core/DeeplinkManager/handlers/intent/handleDappUrl.ts)、[handleBrowserUrl](https://github.com/MetaMask/metamask-mobile/blob/49d569cee6aafad37923b4ba71c84204ce851ea6/app/core/DeeplinkManager/handlers/intent/handleBrowserUrl.ts)、[extractURLParams](https://github.com/MetaMask/metamask-mobile/blob/49d569cee6aafad37923b4ba71c84204ce851ea6/app/core/DeeplinkManager/utils/extractURLParams.ts)。
- [M5：公式AndroidManifest](https://github.com/MetaMask/metamask-mobile/blob/49d569cee6aafad37923b4ba71c84204ce851ea6/android/app/src/main/AndroidManifest.xml) — 新旧host宣言。
- [M6：公式camera fixture](https://github.com/MetaMask/metamask-mobile/blob/49d569cee6aafad37923b4ba71c84204ce851ea6/tests/fixtures/security/camera.html) — ストア版／本人端末での合格ではない。
- [W1：MDN getUserMedia](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia)、[W2：MDN MediaStreamTrack.stop](https://developer.mozilla.org/en-US/docs/Web/API/MediaStreamTrack/stop) — 権限、secure context、停止条件。

次は [本人用試験表](manual-test.md)。配備URL・UIの最終照合は統合担当、実端末操作と許可は本人のみ。
