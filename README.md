# aging_html

Webカメラで撮影した画像をaging APIに送り、生成結果を表示するデモ。

## セットアップ

```bash
npm install
cp .env.example .env   # AGING_API_KEY に自分のキーを設定する
```

`.env` は `.gitignore` 対象。APIキーをコミットしないこと。

## 起動

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
