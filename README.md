# ボランティア証明書 Discord Bot

Cloudflare Workers 上で動作する TypeScript 製 Discord Bot です。指定したサーバーで `/issue` を実行すると、登録済みの正式氏名、サーバー参加日、最上位ロールを載せた日本語PDFを本人の DM に送信します。

発行履歴および発行済みPDFは保存しません。D1 には Discord ユーザーIDと正式氏名だけを保存し、PDF生成時には R2 内の日本語フォントを読み取ります。

## コマンド

| コマンド | 利用者 | 動作 |
| --- | --- | --- |
| `/issue` | 全メンバー | 本人の活動証明書PDFをDMへ送信 |
| `/register user:@ユーザー name:氏名` | Administrator | 証明書に使う正式氏名を登録・更新 |

`/issue` は、`@everyone` を除く最上位ロールを役職欄に表示します。氏名が未登録、または DM が許可されていない場合、PDFは送られず本人だけに案内が表示されます。

Botは `GUILD_MEMBER_REMOVE` をDiscord Gatewayで受信し、`/register` または `/issue` の実行時点で保存した参加日・最終ロールのスナップショットを使って、退出時にも本人へ証明書をDMします。退出・キック・BANはいずれも同じDiscordイベントとして扱われます。

## 初期セットアップ

### 必要な値・トークン

| 値 | 入手先 | 用途 |
| --- | --- | --- |
| `DISCORD_BOT_TOKEN` | Discord Developer Portal → Application → **Bot** → Reset Token | DM送信、ロール取得、コマンド登録 |
| `DISCORD_PUBLIC_KEY` | Discord Developer Portal → Application → **General Information** → Public Key | Interaction リクエストの Ed25519 署名検証 |
| `DISCORD_APPLICATION_ID` | Discord Developer Portal → Application → **General Information** → Application ID | ローカルでのコマンド登録 |
| `GUILD_ID` | Discordで開発者モードを有効化 → 対象サーバーを右クリック → サーバーIDをコピー | 利用サーバーの固定、コマンド登録 |
| `ORGANIZATION_NAME` / `ORGANIZATION_ADDRESS` | 運用者が決定 | PDF上の団体名・住所 |
| `ISSUER_TITLE` / `ISSUER_NAME` / `CONTACT_EMAIL` | 運用者が決定 | PDF上の発行者・連絡先 |

このプロジェクトでは、上表のうち Worker が使用する全値（`DISCORD_APPLICATION_ID` を除く）を **Cloudflare Worker Secret** として保存します。公開鍵・サーバーIDは本来は公開情報ですが、運用情報をGitに残さないという方針に合わせて Secret 化しています。Discord の **Client Secret** は不要です。Cloudflare はローカルからのデプロイなら `npx wrangler login` で認証するため、Cloudflare API Token は不要です。CI/CDからデプロイする場合にだけ、Cloudflareで最小権限の API Token を別途発行してください。

1. Discord Developer Portal で Application を作成し、Bot を追加します。Installation では `bot` と `applications.commands` を有効にして、対象サーバーへ招待します。Bot ページの **Privileged Gateway Intents** で **Server Members Intent** も有効にしてください。
2. Bot token、Application ID、Public Key、対象サーバーの Guild ID を控えます。Bot はサーバーのロール一覧を読み取れる必要があります。
3. 依存関係を入れ、Cloudflare にログインします。

   ```sh
   npm install
   npx wrangler login
   ```

4. D1 と R2 を作成します。

   ```sh
   npx wrangler d1 create zuikaku-volunteer-profiles
   npx wrangler r2 bucket create zuikaku-certificate-assets
   ```

   出力された D1 の `database_id` を `wrangler.jsonc` の `database_id` に設定します。`wrangler.jsonc` には秘密情報・団体情報・Discord IDを記載しません。

5. D1 マイグレーションを反映します。

   ```sh
   npx wrangler d1 migrations apply zuikaku-volunteer-profiles --remote
   ```

6. [Noto Sans JP Regular](https://fonts.google.com/noto/specimen/Noto+Sans+JP) の TTF または OTF を取得し、指定のキーにアップロードします。

   ```sh
   npx wrangler r2 object put zuikaku-certificate-assets/fonts/NotoSansJP-Regular.ttf --file ./NotoSansJP-Regular.ttf --remote
   ```

7. Worker が使用する値をすべて Secret として設定します。各コマンドは値を求める対話入力を開くため、値をコマンドライン履歴に残しません。

   ```sh
   npx wrangler secret put DISCORD_BOT_TOKEN
   npx wrangler secret put DISCORD_PUBLIC_KEY
   npx wrangler secret put GUILD_ID
   npx wrangler secret put ORGANIZATION_NAME
   npx wrangler secret put ORGANIZATION_ADDRESS
   npx wrangler secret put ISSUER_TITLE
   npx wrangler secret put ISSUER_NAME
   npx wrangler secret put CONTACT_EMAIL
   ```

   `.dev.vars` の例:

   ```dotenv
   DISCORD_BOT_TOKEN=your-bot-token
   DISCORD_PUBLIC_KEY=your-discord-public-key
   GUILD_ID=your-discord-guild-id
   ORGANIZATION_NAME=your-organization-name
   ORGANIZATION_ADDRESS=your-organization-address
   ISSUER_TITLE=your-issuer-title
   ISSUER_NAME=your-issuer-name
   CONTACT_EMAIL=your-contact-email
   ```

8. Worker をデプロイし、出力された URL を Discord Developer Portal の **Interactions Endpoint URL** に設定します。Discord は PING と Ed25519署名検証を行うため、先にデプロイしてください。

   ```sh
   npm run deploy
   ```

9. Guild command を登録します。環境変数を渡して実行してください。

   ```sh
   DISCORD_APPLICATION_ID=... GUILD_ID=... DISCORD_BOT_TOKEN=... npm run register-commands
   ```

Guild command のため、指定サーバー内では即時に反映されます。

## 開発・検証

```sh
npm run dev
npm run check
npm test
```

`npm run check` は TypeScript 型検証と Worker 型定義の最新性を検証します。`wrangler.jsonc` を変更した場合は `npx wrangler types` を実行して `worker-configuration.d.ts` を更新してください。

## VC録音はRenderの常駐サービスで動かす

証明書発行Workerとは別に、`recorder/`がVC録音を担当します。先にこの章を通読し、日常運用では「コマンド」と「障害時」を必要に応じて参照してください。音声を受信するには常駐プロセス、Opusデコーダ、FFmpegが必要なため、Cloudflare Workersには配置しません。

### 初回設定はR2・Render・Workerの順で行う

1. R2に録音専用バケットを作成し、`recordings/`を30日後に削除するライフサイクルルールと公開ドメインを設定します。証明書用バケットは使いません。
2. Renderで`render.recorder.yaml`をBlueprintとして登録します。Dockerのビルド対象は`recorder/`です。常時接続が必要なため、スリープするFree Web Serviceは使わず、常駐するプランを選びます。
3. `recorder/.env.example`にある値をRenderのSecretとして設定します。`RECORDING_RESULT_CHANNEL_ID`には結果Embedを送る専用テキストチャンネルのIDを指定します。
4. Renderの公開URLを控え、Workerへ次のSecretを設定します。`RECORDER_SHARED_SECRET`はRender側と同じ十分に長いランダム値にします。

   ```sh
   npx wrangler secret put RECORDER_SERVICE_URL
   npx wrangler secret put RECORDER_SHARED_SECRET
   ```

5. Workerを再デプロイし、コマンドを登録します。

   ```sh
   npm run deploy
   DISCORD_APPLICATION_ID=... GUILD_ID=... DISCORD_BOT_TOKEN=... npm run register-commands
   ```

Botには対象VCの閲覧・接続・発言、および専用結果チャンネルへのメッセージ送信権限が必要です。Discord Developer Portalでは **Server Members Intent** に加え、**Voice States Intent** を有効にしてください。

### `/start` と `/stop` は録音対象VCの参加者が実行する

`/start`は実行者が参加中のVCを録音します。開始音が流れた時点から、発話者ごとの音声をMP3へ合成します。`/stop`は録音対象VCにいる参加者なら誰でも実行できます。VCから人がいなくなった場合も録音を停止します。

停止後は開始者へDMを送り、専用結果チャンネルのEmbedに公開URLを表示します。URLを知る人は再生でき、録音は30日後にR2から自動削除されます。DMが受信拒否でも録音処理は続きます。

### 録音できないときはRenderの状態と権限を確認する

`/healthz`がHTTP 200なら、録音サービスはDiscord接続済みです。503の場合はRenderログで`discord_login_failed`を確認し、Bot TokenとVoice States Intentを見直してください。保存失敗は結果Embedに表示されるため、R2の認証情報、公開URL、FFmpegのログを確認します。

## 運用上の注意

- Bot token はソース、`wrangler.jsonc`、ログに絶対に含めないでください。
- 構造化ログには個人名を出力せず、DiscordユーザーIDと発行結果だけを記録します。
- Discord の API 制限や DM 拒否により送信できない場合があります。その場合はユーザーにDM許可後の再実行を案内します。
