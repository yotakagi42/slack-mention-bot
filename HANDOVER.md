# 引き継ぎ書

追客くん（Slack催促Bot）の運用を引き継ぐ人向け。移管手順・日常運用・障害対応をまとめる。
コードの設計意図は `CLAUDE.md`、初期セットアップの背景は `README.md` を参照。

## 1. このBotは何をするか

Slackのリアクションをトリガーに、対応漏れを自動で追いかける。機能は独立した2つ。

**chase（追客）**

投稿者が自分の投稿に `:kakunin_yoro:` を付けると監視が始まる。投稿から48時間経っても `:kakunin_zumi:` を付けていないメンバーがいれば、4時間ごとにスレッドへメンション付きで催促する。経過時間で文面が変わる（48-72h 通常 / 72-96h 警告 / 96h以降 緊急）。全員が確認済みになると投稿に `:zennin_kakunin:` が付き、以後スキップされる。

要件定義者は成田彩香さん（U0AJVQWFRGW）。

**shift-remind（休み明けリマインド）**

依頼者がメンション付き投稿に `:kyuake_yoro:` を付けると登録される。毎朝9:00 JSTにGoogleスプレッドシートのシフト表を見て、昨日が休みで今日は出勤の人がいればその人だけにスレッドでリマインドする。メンションされた全員を処理し終えると親メッセージに `:white_check_mark:` が付く。

依頼者は堀江昂汰さん（U0ADVCK5ALT）。

**状態はどこにも保存していない。** DBを持たず、Slack上のリアクション（完了絵文字）が唯一の状態。だからサーバーを作り直しても過去分の二重催促は起きないし、逆に完了絵文字を手で外すと催促が再開する。

## 2. 移管チェックリスト

コードを渡すだけでは動かない。以下5つが別々のアカウントに紐付いているので、全部動かす必要がある。

### 2-1. GitHubリポジトリ

現在 `github.com/yotakagi42/slack-mention-bot`（private）。
Settings > General > 最下部の Transfer ownership で引き継ぎ先へ。旧URLは自動でリダイレクトされる。

### 2-2. Vercel（一番手間がかかる）

現在は高木の個人アカウント（Hobbyプラン）にある。**Hobbyプランはチームにメンバーを招待できない**ので、権限を渡すことができない。引き継ぎ先のアカウントで作り直すのが実質唯一の道。

1. 引き継ぎ先がVercelアカウントを作り、上記GitHubリポジトリを Import
2. 環境変数を15個登録（次項の一覧。値は移管時に高木から受け取る）
3. `vercel --prod` でデプロイ、新しいURLを控える
4. cron-job.org のジョブURLを新URLに差し替える（2-3）
5. 動作確認が取れてから旧プロジェクトを削除

環境変数の登録は必ず `printf` を使う。`echo` だと末尾に改行が入ってトークンが壊れる。

```bash
printf '%s' 'ここに値' | vercel env add SLACK_BOT_TOKEN production
```

### 2-3. cron-job.org

chase を4時間ごとに叩いている外部cron。Vercel Cronは Hobbyプランだと1日1回しか回せないため外に出してある。

引き継ぎ先のアカウントでジョブを作り直す。設定内容は次の通り。

- URL: `https://<新しいVercelドメイン>/api/chase`
- 実行間隔: 4時間ごと
- HTTPヘッダ: `Authorization: Bearer <CRON_SECRET の値>`

shift-remind の方は `vercel.json` の `crons` に書いてあり、Vercel Cronが毎日0:00 UTC（= 9:00 JST）に叩く。こちらは移管に自動で付いてくるので作業不要。

### 2-4. Slack App

https://api.slack.com/apps の当該Appを開き、Settings > Collaborators に引き継ぎ先を追加する。ワークスペース管理者の承認が要る場合がある。

Bot Tokenはワークスペースに紐付くので、Appの持ち主が変わってもトークンは有効なまま。ただし完全に手を離すなら OAuth & Permissions で Regenerate して新トークンをVercelに入れ直すのが安全。

必要なBot Token Scopes（変更しないこと）:
現在付いているもの:
`channels:history` `groups:history` `groups:read` `reactions:read` `reactions:write` `usergroups:read` `chat:write` `users:read`

チャンネル自動検出（7章）を使うなら `channels:read` を追加する。

Botは監視対象チャンネル全部に `/invite` されている必要がある。

### 2-5. Google Service Account

shift-remind がシフト表を読むのに使っている（`GOOGLE_SERVICE_ACCOUNT_JSON`）。GCPプロジェクトのオーナー権限ごと渡すか、引き継ぎ先で新しいサービスアカウントを作り、シフト表スプレッドシートをそのアカウントのメールアドレスに閲覧権限で共有し直す。後者の方が権限の分離としては素直。

権限は `spreadsheets.readonly` だけあればいい。

## 3. 環境変数一覧（16個）

値はリポジトリに入っていない。移管時に高木から受け取るか、Vercelの管理画面からコピーする。

### 共通

| 変数 | 内容 |
|---|---|
| `SLACK_BOT_TOKEN` | `xoxb-` で始まるBot Token |
| `CHANNEL_IDS` | 監視対象チャンネルID。カンマ区切りで複数可。**chase と shift-remind の両方が使う。空にすると shift-remind が500で停止する** |
| `CRON_SECRET` | 外部からエンドポイントを叩かれないための共有シークレット |
| `ADMIN_USER_ID` | 障害時にDMが飛ぶ先。現在は高木。**引き継ぎ先のIDに必ず変更する** |

### chase

| 変数 | 現在の値 | 内容 |
|---|---|---|
| `CHASE_AUTO_CHANNELS` | 未設定 | `1` か `true` でチャンネル自動検出を有効化。7章参照 |
| `TRIGGER_EMOJI` | `kakunin_yoro` | 監視を開始する絵文字。投稿者本人が付ける必要がある |
| `CONFIRM_EMOJI` | `kakunin_zumi` | メンバーが確認済みを示す絵文字 |
| `DONE_EMOJI` | `zennin_kakunin` | 全員完了時にBotが付ける絵文字 |
| `BOT_EXCLUDE_USERS` | | 催促対象から外すユーザーID（カンマ区切り） |
| `BOT_EXCLUDE_GROUPS` | | 催促対象から外すユーザーグループID（CEOグループ等） |

### shift-remind

| 変数 | 現在の値 | 内容 |
|---|---|---|
| `SHIFT_REMIND_EMOJI` | `kyuake_yoro` | リマインド登録の絵文字 |
| `SHIFT_DONE_EMOJI` | `white_check_mark` | 処理完了時にBotが付ける絵文字 |
| `SHIFT_SHEET_ID` | | シフト表スプレッドシートのID |
| `SHIFT_MEMBER_MAP` | | `{"U01234": "山田太郎"}` 形式のJSON。SlackユーザーID → シフト表の列見出し名 |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | | サービスアカウントの鍵JSON全文 |
| `SHIFT_LOOKBACK_DAYS` | `14` | 何日前までの投稿を走査するか |

`ADMIN_USER_ID` の変更を忘れると、障害通知が引き継ぎ先ではなく高木に飛び続ける。移管作業で最初にやること。

## 4. シフト表の前提（shift-remind）

Botはスプレッドシートの構造を決め打ちで読んでいる。ここが崩れると黙って動かなくなる。

- **タブ名は `YY/MM` 形式**（2026年9月なら `26/09`）。月をまたぐ前に翌月タブを作っておく必要がある
- **A列が `M/D` 形式の日付**（`9/1` など。ゼロ埋めなし）
- **1行目が見出し行**で、そこに各メンバーの名前が入る。この名前が `SHIFT_MEMBER_MAP` の値と完全一致する必要がある
- **セルの値**: `×` が休み、`O`（大文字オー）または空欄が出勤
- 読み取り範囲は `A1:ZZ50` 固定

当月タブの見出しをダンプするヘルパーがある。`SHIFT_MEMBER_MAP` を作り直すときに使う。

```bash
npx tsx scripts/list-shift-columns.ts
```

SlackユーザーIDの一覧は `npx tsx scripts/list-users.ts` で取れる。

## 5. よくある障害と対処

| 症状 | 原因 | 対処 |
|---|---|---|
| 新しいチャンネルで反応しない | `CHANNEL_IDS` に登録していない | 7章の手順で追加する |
| 5日以上前の投稿が追われない | 走査範囲が直近10日・200件まで | 仕様。長期放置分は手で対応する |
| 催促が全く来ない | `:kakunin_yoro:` を投稿者本人以外が付けた | 投稿者本人が付け直す。仕様で本人のリアクションしか見ていない |
| 催促が全く来ない | 本文にユーザーグループのメンションがない | `@グループ名` でのメンションが必須。個人メンションだけでは動かない |
| 古い投稿が追われなくなった | chaseは各チャンネルの直近50件しか見ない | チャンネルが賑やかだと未完了のまま脱落する。仕様上の制限 |
| 休み明けリマインドが来ない | 当月のタブが未作成 | シフト表に `YY/MM` 形式のタブを作る |
| 特定の人だけリマインドされない | `SHIFT_MEMBER_MAP` の名前とシフト表の見出しが不一致 | `list-shift-columns.ts` で実際の見出しを確認して直す |
| `vercel` コマンドが `Not authorized` で失敗する | `.vercel/project.json` の組織IDが古い | `npx vercel link --project slack-mention-bot --yes` で貼り直す。projectId は変わらない |
| Botから警告DMが届く | Slack認証失敗、シフト表の行/列が見つからない等 | DM本文にエラー内容が入っている。多くは上記のどれか |
| 完了絵文字が付いているのに催促を再開したい | 完了絵文字が状態そのもの | 投稿から完了絵文字を手で外す |

手動で動かして挙動を見たいときは直接叩ける。

```bash
curl -H "Authorization: Bearer $CRON_SECRET" https://<ドメイン>/api/chase
curl -H "Authorization: Bearer $CRON_SECRET" https://<ドメイン>/api/shift-remind
```

レスポンスのJSONに各メッセージの処理結果（`chased:2` `too-early` `no-usergroup` `marked-done` など）が入るので、なぜ催促されなかったかが分かる。

## 6. コードを直すとき

```bash
npx tsc --noEmit   # 型チェック
vercel --prod      # デプロイ
```

テストは無い。変更したらテスト用チャンネルで実際にリアクションを付けて確かめる。本番チャンネルで試すと関係のない人にメンションが飛ぶ。

`slack-chase-bot.n8n.json` は廃止済みの旧n8nワークフロー。参考用に残しているだけで動いていない。

## 7. 新しいチャンネルで使いたいとき

### 当面の手順（設定を1回変える）

`CHANNEL_IDS` にチャンネルIDを足して再デプロイする。

```bash
vercel env rm CHANNEL_IDS production --yes
printf '%s' 'C0AJGUBLC6B,C0AKJFVUJ6M,C0AK20E971S,<新しいID>' | vercel env add CHANNEL_IDS production
vercel --prod
```

チャンネルIDはSlackでチャンネル名をクリックした先の最下部に出る。Botの `/invite` も忘れずに。

### 招待するだけで済むようにする（任意）

`CHASE_AUTO_CHANNELS=1` を入れると、Botが参加しているチャンネルを毎回自動で拾うようになる。チャンネル追加のたびに設定を触る必要がなくなる。

有効にする前に、Slack Appに `channels:read` を追加して再インストールする。これが無いとpublicチャンネルの一覧が取れず、Botは催促を送らずに管理者へDMして終了する（黙って壊れることはない）。

```bash
printf '%s' '1' | vercel env add CHASE_AUTO_CHANNELS production
vercel --prod
```

有効時は `CHANNEL_IDS` の値は無視される。ただし shift-remind は `CHANNEL_IDS` を使い続けるので、**空にしてはいけない**。

戻すときは `vercel env rm CHASE_AUTO_CHANNELS production --yes` して再デプロイすれば元の動作に戻る。

privateチャンネルだけなら `groups:read` が既にあるので、`channels:read` を追加しなくても自動検出は動く。

## 8. 未確認事項

- cron-job.org の実際のジョブ設定はダッシュボードを直接見て確認していない。上記の内容は `CLAUDE.md` の記述とコードから再構成したもの。移管作業時に実物を開いて突き合わせること
