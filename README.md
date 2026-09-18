# aging_html

Webカメラで撮影した画像をaging APIに送り、生成結果を表示するデモ。

## セットアップ

```bash
npm install
cp .env.example .env   # AGING_API_KEY に自分のキーを設定する
```

`.env` は `.gitignore` 対象。APIキーをコミットしないこと。
Codespacesでは `.env` を毎回作らずに、Codespaces secrets に `AGING_API_KEY`
を登録しておくこともできる(環境変数が既にあれば dotenv は上書きしない)。

## 起動(Codespaceでの開発)

バックエンド(ポート5000):

```bash
npm start
```

フロントエンド(ポート3000):

```bash
npm run serve:web
```

フロントエンドの配信は必ず `public/` ディレクトリのみを対象にすること。
リポジトリのルートを静的配信(`npx serve` を引数なしで実行)すると、
`.env`(APIキー)・`.git`(コミット履歴)・`uploads`(アップロードされた写真)
まで誰でも取得できる状態になる。

## 公開(Render)

`npm start` だけでフロントエンドとAPIを同一オリジンで配信する。
`server.js` 内の `//NOTE:` コメントで囲まれた箇所が公開用の設定。

Renderのダッシュボードで設定する環境変数:

| 変数 | 例 | 用途 |
| --- | --- | --- |
| `AGING_API_KEY` | `sk-...` | aging APIのキー(必須) |
| `PUBLIC_ORIGIN` | `https://aging-demo.onrender.com` | aging APIに渡す画像URLの組み立てに使う |
| `BASIC_AUTH_USER` / `BASIC_AUTH_PASSWORD` | 任意 | 入口のパスワード保護 |
| `APP_BASE_PATH` | `/k7f3m2q8` | 推測困難な公開パス |

上記を設定した場合のアクセス先は
`https://<host>/k7f3m2q8/`(Basic認証あり)になる。
`https://<host>/healthz` だけは認証・公開パスの外でヘルスチェック用に応答する。

無料プランは無操作でスリープし復帰に時間がかかるため、展示など常時利用する
期間は有料プランで常時起動にすること。
