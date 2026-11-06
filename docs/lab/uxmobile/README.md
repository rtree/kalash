# UX-mobile 限定PoC

本体を変えず、PCはChromeのMetaMask拡張、モバイルはMetaMask内蔵Browserに
限定できるかを確認する実験。調査・画面実装・統合検証の3名体制。
進捗の正本は[共有TASKS](../../TASKS.md)。本番のReown削除や認証方式変更はしない。

## 開始URL

PCで[独立PoC](https://kalash-uxmobile-548318651344.asia-south1.run.app/)を開く。
表示された主QRの行き先は同じサイトのスマホ表示。
配備版・確認結果は[共有TASKS](../../TASKS.md)を参照。
カメラ許可と実機テストは本人が行う。

## 次はこれだけ

以降のモバイル試験は **PCでCloud RunのPoCを開いてQR表示 → スマホのQRリーダー
→ Cloud Runの試験ページをMetaMask内蔵Browserで開く** に統一する。
スマホから開発PCのlocalhostへアクセスする試験は行わない。

QRの行き先は既定の「この独立PoC」のままでよい。スマホで正しいページに着いたら、
「スマホのMetaMask内蔵Browser」を選んで接続を1回、その後カメラ開始→preview→停止。
結果は「開いた／接続できた／映像が見えた」の3点だけでよい。
以下の詳細手順・ケース分けは追加の切り分けが必要な場合に使う。

## テストの順序

1. 独立HTTPSサイトをPCで開き、寺院端末相当のQRを表示する。
2. スマホの普段のQRリーダーで読み、MetaMaskを開く。
   **アプリが開くだけでは成功ではない**。内蔵Browserのホスト、パス、
   case表示を見て、目的のページに到達したことを確認する。
3. 同じページで本人が接続ボタンを押す。アカウント数とchainの表示を確認する。
   これは接続だけで、本人認証・署名・寄付の検証ではない。
4. URL到達に成功した後、本人がカメラ開始を押し、OS/WebViewの許可を判断する。
   ライブpreviewを目視し、停止・背景移動でカメラ使用が終了することを確認する。
5. 本番Kalash URLのQRは対照実験。本番にはまだReownがあるため、
   その到達成功を「Reownなしの製品フロー成功」と扱わない。

署名、chain切替、送金、撮影、画像保存、upload、DBアクセスはない。
許可操作は本人のみ。ウォレットアドレス、写真、秘密付きURLを記録しない。
汎用QRリーダーすべてで自動的に開く保証はなく、OS・関連付け・リーダーによって
外部ブラウザや中間ページで止まる場合も結果として残す。

詳細は[調査](research.md)と[本人向け試験表](manual-test.md)。

## ローカル起動（開発者のPC内確認のみ）

リポジトリルートで、固定Node 26.13.0 / pnpm 10.34.9を使用する。
依存追加・install・ダウンロードは不要。既存の検証済みlockから
`qrcode@1.5.3`とそのQR用依存だけをブラウザ向けにbundleする。
build時の解決起点は既存AppKitの依存関係だが、AppKit/WalletConnect/SDK自体は
bundleにも実行時にも入らず、buildが依存のallowlistを検証する。
同梱ライセンスは公開サイトの`/third-party-notices.txt`。
`encode-utf8@1.0.3`はMIT表記のみでlicense本文を同梱しないため、
[upstreamの本文と固定参照](encode-utf8.LICENSE.txt)を補完する。

```powershell
node scripts\check-policy.mjs
node --test docs\lab\uxmobile\probe.test.mjs docs\lab\uxmobile\server.test.mjs
node docs\lab\uxmobile\build.mjs
node docs\lab\uxmobile\server.mjs
```

ローカルは`http://127.0.0.1:3107/`。スマホからのlocalhost到達や、
HTTP LAN URLのカメラ動作は保証しない。QRとスマホは公開HTTPSで試す。
テストは模擬provider/streamを使う。実MetaMask・実カメラ成功の証拠ではない。

## 隔離配備

専用Cloud Runサービス`kalash-uxmobile`、専用の権限未付与service accountを使う。
min instances=0、max instances=1。秘密・Firebase設定・Central API接続は渡さない。
既存`kalash-central`のコード、traffic、環境変数、IAMは変更しない。
公開サイトはstatic assetと`/lab-health.json`だけで、POST等は405。
cameraのみself許可、microphone禁止、script/styleはself、connect-srcはnone。
`/healthz`は実配備先でアプリ外のHTML 404になったため使用しない。
healthは専用パスで実HTTPS応答まで確認する。

手順（リポジトリルート、作業をcommitしてからbuild）:

```powershell
node scripts\check-policy.mjs
node docs\lab\uxmobile\build.mjs
$revision = git rev-parse --short=12 HEAD
$image = "asia-south1-docker.pkg.dev/kalash-donation/kalash/uxmobile:$revision"
node scripts\check-policy.mjs
gcloud builds submit docs\lab\uxmobile --project kalash-donation --tag $image
node scripts\check-policy.mjs
gcloud run deploy kalash-uxmobile --project kalash-donation --region asia-south1 `
  --image $image --service-account kalash-uxmobile@kalash-donation.iam.gserviceaccount.com `
  --allow-unauthenticated --min-instances 0 --max-instances 1 `
  --cpu 1 --memory 256Mi --concurrency 20 --timeout 60 --port 8080 --quiet
```

初回だけ専用service accountを作り、project IAMのroleを付与しない。
`dist/`は生成物でGit対象外。Cloud Buildへ送るのはDockerfile・server・distだけ。
`/build-meta.json`でsourceとdirtyを照合し、dirtyの配備を確定版と扱わない。
停止時はユーザー確認後、このPoCサービスだけを削除する。本番には触れない。
