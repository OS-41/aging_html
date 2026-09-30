/**
 * 2ブース構成(撮影ブース / 閲覧ブース)の展示用サーバー（Express.js）
 *
 * 事前にインストールが必要なパッケージ:
 *   npm install express multer cors dotenv
 *
 * 起動方法:
 *   node server.js
 *   -> http://localhost:5000 で待ち受け
 *
 * 静的配信は public/ 配下だけに限る。リポジトリのルートを配信すると
 * .env / .git / uploads / results まで公開されてしまうため。
 *
 * 画面:
 *   /               設営用の案内(各画面への行き先だけ)
 *   /capture.html   撮影ブース用
 *   /view.html      閲覧ブース用(職員が入れ替えるまで同じ内容を映し続ける)
 *   /staff.html     係員用(表示の操作・保管一覧・処理履歴)
 *
 * エンドポイント:
 *   POST   /api/entries                       写真を受け取り受付番号を返す。aging処理は裏で進む
 *   GET    /api/entries                       受付一覧(撮影時刻の古い順)
 *   GET    /api/entries/:id                   受付1件の詳細
 *   DELETE /api/entries/:id                   受付を取り消す(係員用)
 *   GET    /api/entries/:id/images/:index     取り込み済みの結果画像
 *   GET    /api/display                       閲覧ブースに映している内容
 *   POST   /api/display/advance               次のDISPLAY_SLOT_COUNT人分に入れ替える(係員用)
 *   POST   /api/display/clear                 表示を消す(係員用)
 *   GET    /api/logs                          処理履歴(サーバー・クライアント双方)
 *   POST   /api/logs                          クライアントからの履歴を記録する
 *   GET    /api/status                        各ブース・aging API・サーバーの状況
 *   POST   /api/heartbeat                     各ブースからの生存確認
 *   GET    /api/display                       閲覧ブースに映している内容
 *   POST   /api/display/theme                 待機演出の絵柄を切り替える(係員用)
 *   POST   /api/display/updates               閲覧ブースの入れ替えを許すか(係員用)
 *   POST   /api/service                       本日の受付を終える/再開する・人数上限(係員用)
 *   POST   /api/dev                           開発モードの出入り(係員用)
 *   GET    /api/dev/placeholder/:index        開発モードの見本画像(SVG)
 *   GET    /files/:file_id                    aging APIが元画像を取りに来る先。**唯一Basic認証の外**
 *
 * aging APIへの通信はすべてサーバー側で行う。ブラウザからaging APIを
 * 叩く経路は置かない(APIキーを渡さずに済み、利用枠を使う入口も1つで済む)。
 *
 * APIキーはリポジトリに含めず、.env(.gitignore対象)の AGING_API_KEY に設定する。
 * .env.example を参考にすること。
 */

const express = require('express');
const multer = require('multer');
const cors = require('cors');
const { randomUUID, timingSafeEqual } = require('crypto');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 5000;

const AGING_API_BASE_URL = 'https://yce-api-01.makeupar.com/s2s/v2.0/task/aging';
const AGING_API_KEY = process.env.AGING_API_KEY;

// このサーバーの公開URL。設定されていればクライアント申告のoriginより優先する。
const PUBLIC_ORIGIN = process.env.PUBLIC_ORIGIN;

//NOTE: ここからRender公開用のアクセス制限。展示中にURLを知った第三者からAPIキーの利用枠を消費されないよう、Basic認証と推測困難な公開パスで入口を絞る。環境変数が未設定のCodespace開発環境では自動的に無効になるため、開発時の起動方法はこれまでと変わらない
const BASIC_AUTH_USER = process.env.BASIC_AUTH_USER;
const BASIC_AUTH_PASSWORD = process.env.BASIC_AUTH_PASSWORD;

/*
 * 公開パス。例: APP_BASE_PATH=/k7f3m2q8 とするとアプリ全体が
 * https://<host>/k7f3m2q8/ 配下でのみ動く。未設定ならルート直下。
 *
 * **書き方の揺れをここで吸収する。** 先頭の / を忘れると、
 * Expressはどのパスにも当てはまらなくなり、**起動には成功するのに
 * どの画面も開けない**という状態になる。ヘルスチェックは公開パスの外に
 * あるので通ってしまい、デプロイは成功したように見える。
 * 会場で気づくと復旧に再デプロイ(=再起動)が要るため、ここで直す。
 *
 * 併せて、そのままでは届かない書き方を起動時に警告する。
 */
function normaliseBasePath(raw) {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return { path: '', warning: null };

  // 先頭に / を足し、末尾と重複した / を落とす
  const path = ('/' + trimmed).replace(/\/+/g, '/').replace(/\/+$/, '');

  // URLに載せるとブラウザが書き換えてしまう文字が入っていないか。
  // (日本語や空白は送信時に%エンコードされ、こちらの文字列と一致しなくなる)
  const warning = /^[A-Za-z0-9\-._~/]+$/.test(path)
    ? null
    : `APP_BASE_PATH に英数字と - . _ ~ / 以外が入っています(${path})。`
      + 'ブラウザが書き換えるため、どの画面も開けない可能性があります';

  return { path, warning };
}

const { path: BASE_PATH, warning: BASE_PATH_WARNING } = normaliseBasePath(process.env.APP_BASE_PATH);

/**
 * 文字列を長さの差も含めて一定時間で比較する(総当たり時の情報漏れを防ぐ)。
 */
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

/**
 * Basic認証を要求するミドルウェア。
 * 展示用PCでは設営時に一度入力すればブラウザが保持するため、
 * 来場者の操作を妨げずに第三者のアクセスだけを遮断できる。
 * BASIC_AUTH_USER / BASIC_AUTH_PASSWORD が未設定の場合は素通しする。
 */
/*
 * 認証に失敗した回数を接続元ごとに数え、続くようなら応答を遅らせる。
 *
 * 狙いは2つ。
 *  - 誰かが入口を叩いていることを、係員画面の処理履歴に残す
 *  - 総当たりの速さを落とす(1件あたり2秒待たせる)
 *
 * **正しい資格情報は、失敗が続いたあとでも必ず通す。** 締め出す作りにすると
 * 係員が打ち間違えたときに自分たちが入れなくなる。正しい値を知っている
 * 相手を止めても意味はないので、遅らせるのは間違えた側だけにする。
 */
const AUTH_FAIL_LIMIT = 20;
const AUTH_FAIL_WINDOW_MS = 10 * 60 * 1000; // 10分
const AUTH_FAIL_DELAY_MS = 2000;
const authFailures = new Map();

/*
 * 接続元ごとの数えかたに加えて、**全体でも数える。**
 *
 * 接続元ごとだけに頼ると、前段の作り次第で効かなくなる。実際、Renderの前には
 * CDN(Cloudflare)が入っていて、こちらから見える接続元がそのCDNの出口に
 * なるため、1人が叩いていても複数の接続元に散って、どの1つも上限に届かない。
 * 実サーバーで25回続けて間違えても遅延が掛からなかったのはこれが理由。
 *
 * 前段の段数を推測して trust proxy を増やす手もあるが、読み違えると
 * **利用者が自由に書ける値を接続元として扱うことになり、かえって危ない**
 * (偽装で回避も、他人になすりつけることもできてしまう)。
 * そこで、前段がどうであっても効く全体の数えかたを足す。
 *
 * **正しい資格情報はここを通らない**ので、全体で遅らせてもブースには
 * 影響しない。遅くなるのは間違えた側だけ。
 */
const AUTH_FAIL_TOTAL_LIMIT = 40;
let authFailTotal = 0;
let authFailTotalAtMs = 0;

setInterval(() => {
  const expiry = Date.now() - AUTH_FAIL_WINDOW_MS;
  for (const [key, record] of authFailures) {
    if (record.lastAtMs < expiry) authFailures.delete(key);
  }
  if (authFailTotalAtMs && authFailTotalAtMs < expiry) {
    authFailTotal = 0;
    authFailTotalAtMs = 0;
  }
}, 60 * 1000).unref();

/**
 * 認証の失敗を数える。遅らせる段階に入っていたら true を返す。
 * @param {string} source - 接続元(前段の作りによっては皆同じ値になりうる)
 */
function recordAuthFailure(source) {
  const now = Date.now();
  const record = authFailures.get(source) || { count: 0, lastAtMs: 0 };
  // 前の失敗から時間が空いていれば数え直す
  if (now - record.lastAtMs > AUTH_FAIL_WINDOW_MS) record.count = 0;
  record.count += 1;
  record.lastAtMs = now;
  authFailures.set(source, record);

  // 全体の数。接続元が当てにならない場合でもここで止まる
  if (now - authFailTotalAtMs > AUTH_FAIL_WINDOW_MS) authFailTotal = 0;
  authFailTotal += 1;
  authFailTotalAtMs = now;

  if (record.count === AUTH_FAIL_LIMIT) {
    addLog({
      level: 'error',
      event: 'auth:throttled',
      status: 401,
      message: `${source} からの認証失敗が${record.count}回。以後この接続元への応答を遅らせます`
    });
  } else if (authFailTotal === AUTH_FAIL_TOTAL_LIMIT) {
    addLog({
      level: 'error',
      event: 'auth:throttled',
      status: 401,
      message: `10分間の認証失敗が全体で${authFailTotal}回。以後、間違えた応答を遅らせます(正しい資格情報はそのまま通ります)`
    });
  } else if (record.count === 1 || record.count % 5 === 0) {
    // 履歴を埋めないよう、最初と5回ごとだけ残す
    addLog({
      level: 'warn',
      event: 'auth:failed',
      status: 401,
      message: `${source} から認証に失敗(この接続元から${record.count}回目 / 全体で${authFailTotal}回目)`
    });
  }

  return record.count >= AUTH_FAIL_LIMIT || authFailTotal >= AUTH_FAIL_TOTAL_LIMIT;
}

async function requireBasicAuth(req, res, next) {
  if (!BASIC_AUTH_USER || !BASIC_AUTH_PASSWORD) {
    return next();
  }

  const source = req.ip || 'unknown';
  const [scheme, encoded] = (req.get('authorization') || '').split(' ');

  if (scheme === 'Basic' && encoded) {
    const decoded = Buffer.from(encoded, 'base64').toString();
    const separator = decoded.indexOf(':');
    const user = decoded.slice(0, separator);
    const password = decoded.slice(separator + 1);
    if (safeEqual(user, BASIC_AUTH_USER) && safeEqual(password, BASIC_AUTH_PASSWORD)) {
      // 通ったら数え直す(打ち間違えたあとも尾を引かない)
      authFailures.delete(source);
      return next();
    }
  }

  // 資格情報を送ってこなかった最初の1回は、ブラウザが必ず出す普通の流れ。
  // 数えるのは「送ってきたが違った」場合だけにする
  if (encoded && recordAuthFailure(source)) {
    await new Promise((resolve) => setTimeout(resolve, AUTH_FAIL_DELAY_MS));
  }

  res.set('WWW-Authenticate', 'Basic realm="aging", charset="UTF-8"');
  res.status(401).json({ error: '認証が必要です' });
}
//NOTE: ここまでRender公開用のアクセス制限

/**
 * aging APIに渡すsrc_file_urlの組み立てに使う公開オリジンを決定する。
 * クライアントから受け取った値をそのまま信用すると、外部APIに任意のURLを
 * 取得させる踏み台(SSRF)にできてしまうため、許可された形式のみ受け入れる。
 * @param {unknown} candidate - クライアントが申告したorigin
 * @returns {string|null} 使用してよいオリジン。許可できない場合はnull
 */
function resolvePublicOrigin(candidate) {
  if (PUBLIC_ORIGIN) {
    return PUBLIC_ORIGIN.replace(/\/+$/, '');
  }

  if (typeof candidate !== 'string') {
    return null;
  }

  let url;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }

  // パスやクエリ、認証情報が付いたものはオリジンとして受け付けない
  if (url.origin !== candidate.replace(/\/+$/, '')) {
    return null;
  }

  return isDevelopmentOrigin(candidate) ? url.origin : null;
}

/**
 * Codespacesの転送URLか、ローカル開発用のホストか。
 * 外部APIに渡すURLの検証と、開発時のCORS許可の両方で使う。
 * @param {string} candidate
 */
function isDevelopmentOrigin(candidate) {
  let url;
  try {
    url = new URL(candidate);
  } catch {
    return false;
  }
  const isCodespaces = url.protocol === 'https:' && /\.app\.github\.dev$/.test(url.hostname);
  const isLocal = ['localhost', '127.0.0.1'].includes(url.hostname);
  return isCodespaces || isLocal;
}

// ルート定義はrouterにまとめ、公開パス(BASE_PATH)配下へまとめてマウントする
const router = express.Router();

/*
 * 中身が変わっていなければ、本文を送らずに304で返す。
 *
 * 3つの画面は3〜5秒ごとに同じ場所を見に来る。表示が変わっていない間も
 * 毎回まるごと送っていると、一覧が育つほど通信量が増えていく
 * (受付300件で1回120KB。3秒ごとなら140MB/時)。
 *
 * Expressはres.jsonにETagを付けるので、あとは「毎回必ず確かめてから使う」
 * と伝えれば、変わっていない回はブラウザ側のif-none-matchで304になり、
 * 本文が流れない。no-store ではなく no-cache であることが要点で、
 * no-store だと確かめ直す材料ごと捨ててしまい毎回まるごと送ることになる。
 *
 * Renderの送信量はワークスペースごとの月単位で、使い切るとサービスが
 * 止まる。展示中に止まらないよう、出ていく量そのものを減らしておく。
 */
function revalidate(req, res, next) {
  res.setHeader('Cache-Control', 'no-cache, private');
  next();
}

/*
 * Renderはリバースプロキシの後ろでアプリを動かす。1段だけ信用して、
 * X-Forwarded-For の先頭を接続元として扱う(認証の失敗回数を接続元ごとに
 * 数えるため)。信用しないと全員が同じ接続元に見え、1人の総当たりで
 * ブースまで締め出してしまう。
 */
app.set('trust proxy', 1);

// Expressであることを名乗らない。版に紐づく既知の弱点を探す手間を増やすだけの
// 情報で、こちらが得るものは何も無い。
app.disable('x-powered-by');

app.use(express.json());

//NOTE: ここからRender公開用の共通ヘッダー
/*
 * どの応答にも付ける安全側のヘッダー。
 *
 * - Strict-Transport-Security: 以後このホストへはHTTPSでしか繋がせない
 *   (Basic認証は毎回資格情報を送るため、平文で出す機会を作らない)
 * - Referrer-Policy: 外部へ出ていく通信に参照元URLを載せない。
 *   公開パスは推測困難であることが前提なので、外部に渡す機会を作らない
 *   (最近のブラウザは既定でもパスまでは送らないが、明示しておく)
 * - X-Content-Type-Options: 中身を見て型を推測させない
 * - X-Frame-Options: 他所のページの枠に埋め込ませない
 */
/*
 * 画面が読み込んでよい先を、ここに挙げたものだけに絞る(CSP)。
 *
 * いまのところ画面に危険な組み立て(innerHTML等)は無いが、これは
 * 「万一それが入り込んだときに、外へ持ち出させない」ための上乗せ。
 * connect-src を自分自身だけにしてあるので、仮に何かを差し込まれても
 * 撮った写真や資格情報を他所へ送る先が無い。
 *
 * - 'unsafe-inline': 各画面は <script> と <style> を直接書いているため必要。
 *   外部からの読み込み(script-src 'self')は塞がるので、持ち出しは止まる
 * - blob: と data:: 撮影した写真をcanvasから取り出すのに使う
 * - worker-src に blob:: MediaPipeが切り抜きを別スレッドで動かすため
 * - frame-ancestors 'none': X-Frame-Options と同じことを新しい書き方でも
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "worker-src 'self' blob:",
  "connect-src 'self' blob:",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'"
].join('; ');

app.use((req, res, next) => {
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', CSP);
  if (PUBLIC_ORIGIN) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
});

/*
 * 他所のページから引かれた「状態を変える要求」を断る(CSRF対策)。
 *
 * Basic認証は、一度通したブラウザが以後すべての要求に資格情報を自動で
 * 付ける仕組み。そのため、係員画面を開いたままの端末で別のページを踏むと、
 * そのページに置かれた <form action="…/api/display/advance"> が
 * 資格情報つきで送られ、来場者の目の前で画面が切り替わってしまう。
 * (本文の要る操作はexpress.jsonが弾くが、advance と clear は本文が要らない)
 *
 * Sec-Fetch-Site は、その要求がどこから出たかをブラウザ自身が付ける値で、
 * ページ側から書き換えられない。同一オリジン以外からの状態変更は断る。
 *
 * ヘッダーが無いもの(curlや、この値を送らない古いブラウザ)は通す。
 * 狙いはブラウザ経由の誘導だけで、そこは会場で使う端末すべてが対応している。
 */
const SAFE_METHODS = ['GET', 'HEAD', 'OPTIONS'];
// 断ったことを履歴に残す間隔。誰でも(認証を通さなくても)送れる要求なので、
// 1件ごとに残すと処理履歴500件を埋めて、本当に見たい記録を押し出せてしまう
const CROSS_SITE_LOG_INTERVAL_MS = 60 * 1000;
let crossSiteRejected = 0;
let crossSiteLoggedAtMs = 0;

app.use((req, res, next) => {
  if (SAFE_METHODS.includes(req.method)) return next();

  const site = req.get('sec-fetch-site');
  // 'none' はアドレス欄やブックマークからの操作。'same-origin' は自分の画面
  if (!site || site === 'same-origin' || site === 'none') return next();

  crossSiteRejected += 1;
  const now = Date.now();
  if (now - crossSiteLoggedAtMs >= CROSS_SITE_LOG_INTERVAL_MS) {
    crossSiteLoggedAtMs = now;
    addLog({
      level: 'warn',
      event: 'request:cross-site',
      status: 403,
      message: `他所のページからの操作を拒否(直近 ${req.method} ${req.path} / 起動から計${crossSiteRejected}件)`
    });
  }
  res.status(403).json({ error: '他のページからの操作は受け付けません' });
});
//NOTE: ここまでRender公開用の共通ヘッダー

//NOTE: ここからRender公開用のCORS設定。公開時はフロントとAPIを同一オリジンで配信するためCORSそのものが不要になる
// 本番(PUBLIC_ORIGINあり)ではCORSヘッダーを一切付けない。ブラウザの
// 同一オリジンポリシーがそのまま効き、他所のページからAPIを叩けなくなる。
//
// Codespaceでの開発時(PUBLIC_ORIGINなし)だけ、フロントを3000番から
// 配信して5000番のAPIを叩く構成になるため許可する。ただし以前の "*" は
// やめ、Codespacesの転送URLとローカルホストに限る。
if (!PUBLIC_ORIGIN) {
  app.use(cors({
    origin: (origin, callback) => {
      // Originヘッダーが無いものはCORSの対象外(curlや同一オリジン)
      callback(null, !origin || isDevelopmentOrigin(origin));
    },
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type']
  }));
}
//NOTE: ここまでRender公開用のCORS設定

// アップロード先ディレクトリ（存在しなければ作成）
const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

// file_id -> ファイル情報 の対応表（本番運用ではDB等に置き換える想定）
const fileStore = new Map();

/*
 * 元画像の保持期間。
 *
 * 件数の上限は受付側(MAX_ENTRIES)で足りている。ここに入る元画像は
 * POST /api/entries で受け付けた受付1件につき1枚だけで、aging APIが
 * 取得し終えた時点(または失敗した時点)で消すため、常に処理中の数しか残らない。
 * それでも取りこぼしに備えて期限を切る。顔写真を無期限に持たないためでもある。
 */
const FILE_TTL_MS = 30 * 60 * 1000; // 30分

function deleteStoredFile(fileId) {
  const fileInfo = fileStore.get(fileId);
  if (!fileInfo) return;
  fileStore.delete(fileId);
  fs.unlink(fileInfo.filePath, (err) => {
    if (err && err.code !== 'ENOENT') {
      addLog({ level: 'warn', event: 'file:delete', message: `アップロード画像を削除できません(${fileId}): ${err.message}` });
    }
  });
}

// 期限切れのファイルを定期的に削除する
setInterval(() => {
  const expiry = Date.now() - FILE_TTL_MS;
  for (const [fileId, fileInfo] of fileStore) {
    if (fileInfo.uploadedAtMs < expiry) {
      deleteStoredFile(fileId);
    }
  }
}, 60 * 1000).unref();

// 再起動時はfileStoreが空になり、uploads/内のファイルは参照不能な
// 孤児として残り続けるため、起動時にまとめて削除する。
for (const entry of fs.readdirSync(UPLOAD_DIR, { withFileTypes: true })) {
  if (entry.isFile()) {
    fs.unlinkSync(path.join(UPLOAD_DIR, entry.name));
  }
}

// ---- 2ブース構成（撮影ブース / 閲覧ブース）のための受付管理 ----
//
// 撮影ブースと閲覧ブースは別の端末で、間に10分以内の移動時間が挟まる。
// 来場者は撮影した順に閲覧ブースへ到着するため、撮影時刻順の待ち行列として扱う。
//
// 撮影ブースは写真を送るだけで、aging処理はサーバーが裏で進める。移動時間が
// そのまま生成時間になるので、閲覧ブースでは待たずに結果を出せる。
// 生成結果はaging API側のURLが短時間で失効しても表示できるよう、
// 完成時にこちらのディスクへ取り込んで保管する。

const RESULTS_DIR = path.join(__dirname, 'results');
if (!fs.existsSync(RESULTS_DIR)) {
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
}
for (const entry of fs.readdirSync(RESULTS_DIR, { withFileTypes: true })) {
  if (entry.isFile()) {
    fs.unlinkSync(path.join(RESULTS_DIR, entry.name));
  }
}

// 受付ID -> 受付情報
const entryStore = new Map();
let entrySequence = 0;

// 滞留するのは「移動時間 × 撮影ペース」の分だけなので、10分運用なら
// 数十件程度。余裕をみた上限と、閉場後に残さないための保持期間を設ける。
const MAX_ENTRIES = 300;
const ENTRY_TTL_MS = 30 * 60 * 1000; // 30分
const RESULT_IMAGE_MAX_BYTES = 15 * 1024 * 1024;

// 閲覧ブースの画面は職員が任意のタイミングでまとめて入れ替える。
// 一度に何人分を並べるかはここで決める。
const DISPLAY_SLOT_COUNT = 6;

/*
 * 取り込む結果画像の年齢。
 *
 * aging APIは複数の年齢を返すが、閲覧ブースで見せるのは1枚だけなので、
 * その1枚しか取り込まない。ディスクと取り込み時間が枚数ぶん減り、
 * 1枚でも取得に失敗すると受付ごと失敗する範囲も狭くなる。
 *
 * `public/view.html` の DISPLAY_AGE と合わせること。
 * **null にすると、APIが返した全年齢を取り込む(以前の動作)。**
 * 表示する年齢を後から変えたくなったとき、または複数年齢を見せる仕様に
 * 戻すときは、ここを null にすれば保存側は元に戻る。
 */
const SAVED_RESULT_AGE = 70;

// 現在、閲覧ブースに映している受付ID
let displayBatch = [];
let displayUpdatedAtMs = null;

// 閲覧ブースが今どちらの画面かを係員が切り替える。
// 'waiting' は背景の演出だけ、'results' は結果の区画を並べる。
let displayMode = 'waiting';

// 閲覧ブースの入れ替えを受け付けるか。無効にすると advance / clear を拒む。
// 会場での調整中に誤って画面を変えてしまうのを防ぐための鍵。
let displayUpdatesEnabled = true;

// 閲覧ブースの待機演出の絵柄。係員画面から切り替える(仮運用)
const DISPLAY_THEMES = ['realistic', 'storybook', 'picturebook', 'tamatebako'];
let displayTheme = 'realistic';

/*
 * ---- 本日の受付終了 ----
 *
 * 1日の上限に達したら、撮影ブースと閲覧ブースの両方に「今日はもうできない」
 * ことを出す。締め切り方は2つあり、どちらか一方でも成立していれば終了とする。
 *
 *  1. 強制終了  … 係員が押した時点で即終了(閉場、機材の不調、時間切れなど)
 *  2. 人数上限  … 係員が上限を入れた「その時点から」受け付けた人数を数え、
 *                 上限に達した時点で終了
 *
 * 2の数え始めを「入力した時点」にしてあるのは、前日の試写や当日朝の試運転も
 * 受付として数えてしまうと、実際に来場者を通せる人数が減ってしまうため。
 * 上限を入れ直すと、その時点からまた0人で数え直す。
 *
 * どちらも再起動で消える(受付や結果と同じ)。会場で再起動が要る事態に
 * なったら、係員が入れ直す。処理履歴には残す。
 */
let serviceClosedManually = false;
let serviceClosedAtMs = null;
// 受け付ける人数の上限。未設定(null)なら数えない
let serviceLimit = null;
// 上限を入れた時刻と、そこから受け付けた人数
let serviceLimitSetAtMs = null;
let serviceCounted = 0;

// 上限として受け付ける最大値。会期2日で1200人の想定なので、打ち間違いを
// 弾ける程度に広く取る(桁を1つ多く打ったときに気づけるようにするため)
const MAX_SERVICE_LIMIT = 10000;

/** 人数上限に達しているか。上限が未設定なら常に false。 */
function serviceLimitReached() {
  return serviceLimit !== null && serviceCounted >= serviceLimit;
}

/** 本日の受付を終えているか。 */
function serviceIsClosed() {
  return serviceClosedManually || serviceLimitReached();
}

/**
 * 各ブースと係員画面に渡す締め切りの状態。
 * 撮影ブースと閲覧ブースは closed と reason だけを見れば表示を切り替えられる。
 */
function serviceState() {
  const closed = serviceIsClosed();
  return {
    closed,
    // どちらで終わったか。係員画面の文言と、再開のしかたが変わる
    reason: closed ? (serviceClosedManually ? 'manual' : 'limit') : null,
    limit: serviceLimit,
    counted: serviceLimit === null ? 0 : serviceCounted,
    remaining: serviceLimit === null ? null : Math.max(0, serviceLimit - serviceCounted),
    counting_since: serviceLimitSetAtMs ? new Date(serviceLimitSetAtMs).toISOString() : null,
    closed_at: serviceClosedAtMs ? new Date(serviceClosedAtMs).toISOString() : null
  };
}

/*
 * ---- 開発モード ----
 *
 * aging APIのユニットが尽きている間や、会場の設営中でまだ誰も撮影して
 * いない間でも、各画面の見た目と切り替えを確認できるようにするための状態。
 * 係員画面から入り、次の二つだけが変わる。
 *
 *  - 有効な撮影結果が無くても、結果画面を見本の画像で埋められる
 *  - 撮影ブースに、表示する状態を選ぶ欄が出る(撮影ブース側だけの表示)
 *
 * 見本の画像はサーバーが生成するSVGで、aging APIは一切呼ばない。
 * 本番中に入ったままにならないよう、係員画面と閲覧ブースの両方に
 * 開発モードである旨を出す。
 */
let devMode = false;

// 結果画面のうち、見本で埋めている区画の数(開発モードのときだけ0より大きい)
let displayPlaceholders = 0;

// 開発モードで結果画面を埋めるときの人数。
// 本番は届いた人数ぶんだけを並べるので、人数ごとの並び(1人なら全画面、
// 3人なら上2枚+下1枚)を確かめるには、ここで人数を選べる必要がある。
let devPlaceholderCount = DISPLAY_SLOT_COUNT;

// 見本画像の寸法。よくあるWebカメラのフレーム(4:3)に合わせてある。
// 閲覧ブースは最初に届いた画像の縦横比で区画を組み直すため、見本でも
// 本番に近い並びが確認できる。
const DEV_PLACEHOLDER_SIZE = { width: 1440, height: 1080 };

// 見本の区画をひと目で見分けられるよう、順番に色を変える
const DEV_PLACEHOLDER_COLORS = ['#2f4858', '#33658a', '#55828b', '#7a5c61', '#86644b', '#4f6457'];

// ---- 処理履歴 ----
// 係員が会場でトラブルを追えるよう、サーバーの処理とクライアント(各ブースの
// ブラウザ)の通信結果を同じ時系列に残す。ステータスコードとエラーメッセージも含める。
const MAX_LOG_ENTRIES = 500;
const logStore = [];
let logSequence = 0;

// ---- 各ブースとの通信状況 ----
// どのブースが今も繋がっているかを係員が把握できるよう、各ページから
// 定期的に届く鼓動(heartbeat)を記録する。一定時間途絶えたら切断とみなす。
const CLIENT_OFFLINE_MS = 20 * 1000;
const clientStore = new Map();

/*
 * 覚えておくブースの数。
 *
 * client_id はブラウザが名乗るだけの値なので、毎回違う値で鼓動を送られると
 * 表がいくらでも膨らむ。会場で使うのは3〜5台なので、余裕をみた上限を置き、
 * 溢れたら最も長く音沙汰のないものから捨てる。係員画面に出るのは実際に
 * 動いているブースなので、捨てられるのは古い(もう使っていない)側になる。
 */
const MAX_CLIENTS = 32;
// 名乗ってきたIDは、この長さに切ってから表の鍵として使う
const CLIENT_ID_MAX_CHARS = 64;

// aging APIとの通信状況
const agingApiHealth = {
  lastStatus: null,
  lastAtMs: null,
  lastError: null,
  okCount: 0,
  errorCount: 0
};

function recordAgingApiCall(status, errorMessage = null) {
  agingApiHealth.lastStatus = status;
  agingApiHealth.lastAtMs = Date.now();
  agingApiHealth.lastError = errorMessage;
  if (errorMessage || !status || status >= 400) {
    agingApiHealth.errorCount += 1;
  } else {
    agingApiHealth.okCount += 1;
  }
}

const SERVER_STARTED_AT_MS = Date.now();

/*
 * いま動いているコードの版。
 * 「直したはずの動きにならない」のが、古いビルドを見ているせいなのかを
 * 係員画面だけで確かめられるようにするため。Renderがデプロイ時に渡す
 * コミットIDを使い、無ければ不明として扱う。
 */
const SERVER_COMMIT = (process.env.RENDER_GIT_COMMIT || process.env.GIT_COMMIT || '').slice(0, 7) || null;

/*
 * ---- 処理履歴の詳細 ----
 *
 * 一覧の「内容」は一行で読める長さに保ち、原因を追うための材料は
 * detail に入れて係員画面で開けるようにする。中身は次の4つ。
 *
 *   where    どのファイルの何行目で記録したか(サーバー側は自動で取る)
 *   error    catchで受け取った例外の内容(stack込み)
 *   request  HTTP通信の要求の全文(JSON)
 *   response HTTP通信の応答の全文(JSON)
 *
 * 展示中にメモリを食いつぶさないよう、1項目あたりの長さを制限する。
 */
const DETAIL_MAX_CHARS = 4000;

/**
 * 長すぎる文字列を切り詰める。切ったことが分かるよう残りの文字数を添える。
 */
function trimDetailText(value, max = DETAIL_MAX_CHARS) {
  if (value === null || value === undefined) return null;
  const text = String(value);
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n…(以下略 ${text.length - max}文字)`;
}

/**
 * 詳細に載せるJSON。読めるように整形してから切り詰める。
 */
function formatDetailJson(value) {
  try {
    return trimDetailText(JSON.stringify(value, null, 2));
  } catch (err) {
    return trimDetailText(String(value));
  }
}

/**
 * ヘッダーからAPIキーを伏せる。処理履歴は係員画面に出るため、
 * Authorization をそのまま残さない。
 */
function redactHeaders(headers) {
  const out = {};
  for (const [key, value] of Object.entries(headers || {})) {
    out[key] = /^authorization$/i.test(key) ? 'Bearer ***(伏せ字)' : value;
  }
  return out;
}

/**
 * HTTP通信の要求と応答を、詳細に載せる形へまとめる。
 * @param {{method: string, url: string, headers?: object, body?: unknown}} request
 * @param {{status: number, statusText?: string, headers?: object, body?: unknown}} response
 */
function httpDetail(request, response) {
  return {
    request: formatDetailJson({
      method: request.method,
      url: request.url,
      headers: redactHeaders(request.headers),
      body: request.body ?? null
    }),
    response: formatDetailJson({
      status: response.status,
      status_text: response.statusText || '',
      headers: response.headers || null,
      body: response.body ?? null
    })
  };
}

/**
 * この記録を残した場所(ファイル名と行・桁)をスタックから取り出す。
 * 係員が「どこで起きたか」を追えるようにするため、サーバー側の記録には
 * 呼び出し元を自動で添える。
 */
function callerLocation() {
  const stack = (new Error().stack || '').split('\n').slice(1);
  for (const line of stack) {
    // この関数自身と addLog の枠は飛ばし、実際に記録した場所を返す
    if (/\bat (callerLocation|addLog)\b/.test(line)) continue;
    const match = line.match(/\(?([^()\s]+):(\d+):(\d+)\)?\s*$/);
    if (!match) continue;
    return { file: path.basename(match[1]), line: Number(match[2]), column: Number(match[3]) };
  }
  return null;
}

/**
 * 詳細を保存できる形に整える。クライアントから届いたものもここを通す。
 */
function normaliseDetail(detail) {
  const out = {};
  if (!detail || typeof detail !== 'object') return out;

  const where = detail.where;
  if (where && typeof where === 'object' && where.file) {
    out.where = {
      file: String(where.file).slice(0, 120),
      line: Number.isFinite(Number(where.line)) ? Number(where.line) : null,
      column: Number.isFinite(Number(where.column)) ? Number(where.column) : null
    };
  }
  for (const key of ['error', 'request', 'response']) {
    if (detail[key]) out[key] = trimDetailText(detail[key]);
  }
  return out;
}

/**
 * 処理履歴を1件追加する。古いものから捨てて件数を抑える。
 *
 * サーバー側の記録はすべてここを通す。console.log は使わない。
 *
 * 警告と異常、および echo を指定したものは、ホスティング側のログにも流す。
 * 処理履歴はメモリ上にあるため再起動で消えるうえ、起動に失敗した場合は
 * 係員画面自体が開けないため、そこだけは二重に残す。
 * @param {boolean} [options.echo] - infoでもホスティング側のログに出すか
 * @param {object} [options.detail] - 係員画面で開く詳細(where/error/request/response)
 */
function addLog({ source = 'server', level = 'info', event, message = '', status = null, sequence = null, echo = false, detail = null }) {
  const info = normaliseDetail(detail);
  // サーバー側は記録した場所を自動で添える(クライアント側は届いたものを使う)
  if (source === 'server' && !info.where) {
    const where = callerLocation();
    if (where) info.where = where;
  }

  logSequence += 1;
  logStore.push({
    id: logSequence,
    at: new Date().toISOString(),
    source,
    level,
    event,
    message: String(message).slice(0, 500),
    status,
    sequence,
    detail: Object.keys(info).length > 0 ? info : null
  });
  if (logStore.length > MAX_LOG_ENTRIES) {
    logStore.splice(0, logStore.length - MAX_LOG_ENTRIES);
  }

  if (echo || level === 'warn' || level === 'error') {
    const label = sequence ? `[${event} #${sequence}]` : `[${event}]`;
    const line = `${label} ${message}${status ? ` (status ${status})` : ''}`;
    if (level === 'warn' || level === 'error') {
      console.error(line);
    } else {
      console.info(line);
    }
  }
}

function deleteEntry(entryId) {
  const entry = entryStore.get(entryId);
  if (!entry) return;
  entryStore.delete(entryId);

  for (const output of entry.outputs) {
    fs.unlink(output.filePath, (err) => {
      if (err && err.code !== 'ENOENT') {
        addLog({
          level: 'warn',
          event: 'entry:delete',
          sequence: entry.sequence,
          message: `結果画像を削除できません: ${err.message}`
        });
      }
    });
  }
  if (entry.sourceFileId) {
    deleteStoredFile(entry.sourceFileId);
  }
}

setInterval(() => {
  const expiry = Date.now() - ENTRY_TTL_MS;
  for (const [entryId, entry] of entryStore) {
    if (entry.capturedAtMs < expiry) {
      deleteEntry(entryId);
    }
  }
}, 60 * 1000).unref();

/**
 * 撮影時刻の古い順に受付を並べて返す。
 */
function entriesInOrder() {
  return [...entryStore.values()].sort((a, b) => a.capturedAtMs - b.capturedAtMs);
}

/**
 * 開発モードで結果画面を埋めるための見本を、閲覧ブースに渡す形で作る。
 * 実体は無く、画像だけを /api/dev/placeholder/:index が返す。
 * @param {number} index - 0から始まる区画の位置
 */
function placeholderEntry(index) {
  const at = new Date(displayUpdatedAtMs || Date.now()).toISOString();
  return {
    id: `dev-placeholder-${index}`,
    sequence: index + 1,
    status: 'ready',
    error: null,
    error_code: null,
    // 閲覧ブースがこれを見て「見本」と分かるようにする
    placeholder: true,
    files: [],
    captured_at: at,
    viewed_at: at,
    age: null,
    age_idx: null,
    age_min: null,
    age_max: null,
    outputs: [{
      res_age: SAVED_RESULT_AGE === null ? 70 : SAVED_RESULT_AGE,
      url: `${BASE_PATH}/api/dev/placeholder/${index}`
    }]
  };
}

/**
 * 閲覧ブースに映している内容。期限切れで消えた受付は除いて返す。
 * 開発モードで見本を出している場合は、そのぶんを後ろに足して返す。
 */
function currentDisplay() {
  const entries = displayBatch
    .map((entryId) => entryStore.get(entryId))
    .filter(Boolean)
    .map(toPublicEntry);

  // 見本は実際の受付の後ろに並べる。開発モードを抜けたら数が0になるので、
  // 本番の表示に見本が混ざることはない。
  const placeholders = devMode ? Math.min(displayPlaceholders, DISPLAY_SLOT_COUNT - entries.length) : 0;
  for (let i = 0; i < placeholders; i++) {
    entries.push(placeholderEntry(entries.length));
  }

  return {
    slot_count: DISPLAY_SLOT_COUNT,
    updated_at: displayUpdatedAtMs ? new Date(displayUpdatedAtMs).toISOString() : null,
    mode: displayMode,
    updates_enabled: displayUpdatesEnabled,
    dev_mode: devMode,
    placeholders,
    dev_placeholder_count: devPlaceholderCount,
    theme: displayTheme,
    themes: DISPLAY_THEMES,
    // 本日の受付を終えたか。撮影ブースと閲覧ブースはこれを見て掲示を出す
    service: serviceState(),
    entries
  };
}

/**
 * 閲覧ブースに渡す形へ整形する。結果画像はこのサーバーのURLで返すため、
 * aging API側のURLが失効していても表示できる。
 */
function toPublicEntry(entry) {
  // 係員向け一覧では写真そのものは映さず、ファイル名と撮影時刻だけを見せる
  const files = entry.outputs.length > 0
    ? entry.outputs.map((output) => path.basename(output.filePath))
    : (entry.sourceFileId ? [`${entry.sourceFileId}.jpg`] : []);

  return {
    id: entry.id,
    sequence: entry.sequence,
    status: entry.status,
    error: entry.error,
    error_code: entry.errorCode,
    // 加工できず、元の写真をそのまま出しているもの(開発モードのみ)
    fallback: entry.fallback === true,
    files,
    captured_at: new Date(entry.capturedAtMs).toISOString(),
    viewed_at: entry.viewedAtMs ? new Date(entry.viewedAtMs).toISOString() : null,
    age: entry.age,
    age_idx: entry.ageIdx,
    age_min: entry.ageMin,
    age_max: entry.ageMax,
    outputs: entry.outputs.map((output, index) => ({
      res_age: output.resAge,
      url: `${BASE_PATH}/api/entries/${entry.id}/images/${index}`
    }))
  };
}

// multerの設定
// - ファイル名: file_id（拡張子はjpg固定。クライアント側でjpegにリサイズ済み前提）
// - サイズ上限: 10MB（クライアント側のリサイズと合わせる）
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      cb(null, UPLOAD_DIR);
    },
    filename: (req, file, cb) => {
      const fileId = randomUUID();
      req.generatedFileId = fileId; // 後続処理で参照するために保持
      cb(null, `${fileId}.jpg`);
    }
  }),
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB
    files: 1
  },
  fileFilter: (req, file, cb) => {
    // jpg/jpeg以外は拒否
    // ※ ここで見ているmimetypeはクライアントの自己申告であり、実体が
    //   JPEGであることは保存後にマジックバイトで検証する。
    const allowed = ['image/jpeg'];
    if (!allowed.includes(file.mimetype)) {
      return cb(new Error('jpg/jpeg形式の画像のみアップロード可能です'));
    }
    cb(null, true);
  }
});

/**
 * 保存されたファイルの先頭がJPEGのマジックバイト(FF D8 FF)かを検証する。
 * Content-Typeは詐称できるため、実体が画像であることを確認して
 * HTML等の別形式のコンテンツをホストさせられるのを防ぐ。
 *
 * 読めなかった場合は「JPEGではない」として扱う。ここで例外を投げると
 * 受け口の非同期処理の外へ出てしまい、プロセスごと落ちる道になる。
 */
function isJpegFile(filePath) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const header = Buffer.alloc(3);
    const bytesRead = fs.readSync(fd, header, 0, 3, 0);
    return bytesRead === 3 && header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff;
  } catch (err) {
    addLog({ level: 'warn', event: 'file:verify', message: `受け取った画像を確認できません: ${err.message}` });
    return false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/**
 * 受け取ったばかりの一時ファイルを消す。
 *
 * 既に無い場合も、消せない場合も、そのまま進む。保持期間の掃除と
 * 重なって先に消えていることがあり、そこで例外を投げると受け口の
 * 非同期処理の外へ出てプロセスごと落ちる道になる。
 */
function discardUpload(filePath) {
  try {
    fs.unlinkSync(filePath);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      addLog({ level: 'warn', event: 'file:delete', message: `受け取った画像を削除できません: ${err.message}` });
    }
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/*
 * aging APIが返す技術的なエラー。いずれも来場者の姿勢では直らない。
 * 係員が「課金の問題か、設定の誤りか、鍵の問題か」を処理履歴だけで
 * 判別できるよう、日本語の説明を添える。
 */
const AGING_API_ERRORS = {
  InvalidParameters: 'リクエストの内容が不正です',
  CreditInsufficiency: 'APIのユニットが不足しています(追加購入が必要)',
  BadRequest: '想定外のリクエスト内容です',
  InvalidStyleGroup: 'スタイルグループIDが不正です',
  InvalidStyle: 'スタイルIDが不正です'
};

// 本文にコードが無く、HTTPステータスだけで分かるもの
const AGING_API_STATUS_ERRORS = {
  400: 'リクエストが不正です(task_idの誤りを含む)',
  401: 'APIキーが無効です',
  429: 'リクエストが多すぎます(レート制限)',
  500: 'aging API側で処理が時間切れになりました'
};

/**
 * エラーコードとHTTPステータスから、係員向けの説明を組み立てる。
 *
 * 一覧には summary(原因だけの短い一行)を出し、コードやAPIの原文を含む
 * full は詳細と、撮影ブースに出す係員向けの行に回す。
 *
 * @param {string|null} code
 * @param {number|null} status
 * @param {string} message - APIが返した説明
 * @returns {{summary: string, full: string}}
 */
function describeAgingError(code, status, message) {
  const known = code && AGING_API_ERRORS[code];
  const byStatus = status && AGING_API_STATUS_ERRORS[status];
  const summary = known || byStatus || code || message || '生成に失敗しました';

  const parts = [];
  if (known || byStatus) parts.push(known || byStatus);
  if (code) parts.push(`code=${code}`);
  if (status) parts.push(`HTTP ${status}`);
  if (message && message !== code) parts.push(message);
  return { summary, full: parts.join(' / ') };
}

/**
 * aging APIの応答からエラーコードと説明を取り出す。
 * コード(error_face_angle_upward など)は撮影ブースで来場者向けの
 * 案内に読み替えるため、説明とは別に持っておく。
 * 応答の形が変わっても拾えるよう、data配下と直下の両方を見る。
 * @param {object} payload
 */
function agingErrorFrom(payload) {
  const data = payload?.data || {};
  const code = typeof data.error === 'string' ? data.error
    : (typeof payload?.error === 'string' ? payload.error : null);
  const message = data.error_message || payload?.error_message || code || '生成に失敗しました';
  return { code, message };
}

/**
 * aging APIにタスクを開始させ、task_idを返す。
 * @param {string} srcFileUrl - 外部から取得できる元画像のURL
 */
async function startAgingTask(srcFileUrl, sequence) {
  const requestHeaders = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${AGING_API_KEY}`
  };
  const requestBody = { request_id: 0, src_file_url: srcFileUrl };

  const res = await fetch(AGING_API_BASE_URL, {
    method: 'POST',
    headers: requestHeaders,
    body: JSON.stringify(requestBody)
  });

  const payload = await res.json().catch(() => ({}));
  const taskId = payload?.data?.task_id;
  // やり取りの全文は詳細へ回し、一覧には短い一行だけを出す
  const exchange = httpDetail(
    { method: 'POST', url: AGING_API_BASE_URL, headers: requestHeaders, body: requestBody },
    { status: res.status, statusText: res.statusText, headers: Object.fromEntries(res.headers), body: payload }
  );

  if (!taskId) {
    // 原因を短くまとめてから記録する。ユニット不足と鍵の誤りとレート制限は
    // 対処がまるで違うため、係員画面でそのまま読めるようにしておく。
    const { code, message } = agingErrorFrom(payload);
    const described = describeAgingError(code, res.status, message);
    recordAgingApiCall(res.status, described.summary);
    addLog({
      level: 'error',
      event: 'aging:start',
      status: res.status,
      sequence,
      message: described.summary,
      detail: { ...exchange, error: described.full }
    });
    const err = new Error(`タスクを開始できませんでした: ${described.full}`);
    err.code = code;
    throw err;
  }

  recordAgingApiCall(res.status);
  addLog({ event: 'aging:start', status: res.status, sequence, message: 'タスクを開始', detail: exchange });
  return taskId;
}

/**
 * タスクの完了を待ち、results を返す。
 */
async function pollAgingTask(taskId, sequence, { intervalMs = 3000, maxAttempts = 100 } = {}) {
  const url = `${AGING_API_BASE_URL}/${taskId}`;
  const requestHeaders = { Authorization: `Bearer ${AGING_API_KEY}` };

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const res = await fetch(url, { method: 'GET', headers: requestHeaders });
    const payload = await res.json().catch(() => ({}));
    const taskStatus = payload?.data?.task_status;
    const exchange = httpDetail(
      { method: 'GET', url, headers: requestHeaders, body: null },
      { status: res.status, statusText: res.statusText, headers: Object.fromEntries(res.headers), body: payload }
    );

    if (taskStatus === 'success') {
      recordAgingApiCall(res.status);
      addLog({
        event: 'aging:success',
        status: res.status,
        sequence,
        message: `生成が完了(${attempt}回目)`,
        detail: exchange
      });
      return payload.data.results;
    }
    if (taskStatus === 'error') {
      const { code, message } = agingErrorFrom(payload);
      const described = describeAgingError(code, null, message);
      recordAgingApiCall(res.status, described.summary);
      addLog({
        level: 'error',
        event: 'aging:failed',
        status: res.status,
        sequence,
        message: described.summary,
        detail: { ...exchange, error: described.full }
      });
      const err = new Error(described.full);
      err.code = code;
      throw err;
    }
    if (!res.ok) {
      const { code, message } = agingErrorFrom(payload);
      const described = describeAgingError(code, res.status, message);
      addLog({
        level: 'warn',
        event: 'aging:poll',
        status: res.status,
        sequence,
        message: `${attempt}回目: ${described.summary}`,
        detail: { ...exchange, error: described.full }
      });
    }

    await sleep(intervalMs);
  }
  throw new Error('生成が時間内に完了しませんでした');
}

/**
 * 生成結果の画像をこちらのディスクへ取り込む。
 * aging API側のURLが短時間で失効しても閲覧ブースで表示できるようにするため、
 * 完成した時点で必ずコピーを持つ。
 * @returns {Promise<{resAge: number, filePath: string}>}
 */
async function downloadResultImage(entryId, index, output, sequence) {
  const res = await fetch(output.url);
  if (!res.ok) {
    addLog({
      level: 'error',
      event: 'result:download',
      status: res.status,
      sequence,
      message: `${index}枚目を取得できません`,
      detail: httpDetail(
        { method: 'GET', url: output.url, headers: {}, body: null },
        {
          status: res.status,
          statusText: res.statusText,
          headers: Object.fromEntries(res.headers),
          // 本文は画像(またはエラー本文)。長さだけを控える
          body: `(本文は画像データのため省略 / content-length: ${res.headers.get('content-length') || '不明'})`
        }
      )
    });
    throw new Error(`結果画像を取得できませんでした (${res.status})`);
  }

  // 申告された長さで先に断る。読み切ってから確かめると、その分を
  // いったんメモリに載せることになる(Renderの512MBでは効く)
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > RESULT_IMAGE_MAX_BYTES) {
    throw new Error('結果画像のサイズが大きすぎます');
  }

  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length > RESULT_IMAGE_MAX_BYTES) {
    throw new Error('結果画像のサイズが大きすぎます');
  }

  const filePath = path.join(RESULTS_DIR, `${entryId}-${index}.jpg`);
  await fs.promises.writeFile(filePath, buffer);
  return { resAge: output.res_age, filePath };
}

/**
 * 撮影された1件を、開始からダウンロードまで通して処理する。
 * 撮影ブースのリクエストとは切り離して裏で進めるため、例外は
 * 受付情報のstatusに記録して握りつぶす。
 */
async function processEntry(entry, origin) {
  /*
   * 開発モードではaging APIを呼ばない。撮った写真をそのまま結果にする。
   *
   * ユニットを1つも使わずに、撮影から閲覧までを実際の写真で通せる。
   * 生成を待たないぶん、受付から表示までも速い。
   * 本番では通らない道なので、加工前の写真が「未来のあなた」として
   * 出ることはない(開発モードを終えるとこの受付は削除される)。
   */
  // ここは try の外なので、投げれば呼び出し元(受け口)の外へ出る。
  // keepOriginalAsResult と deleteStoredFile は自分で失敗を処理するが、
  // 将来ここに手を入れたときのために、この段も囲っておく
  if (devMode) {
    /*
     * **開発モードでは、何があってもaging APIを呼ばない。**
     *
     * 以前はここで控えに失敗したとき「通常どおりAPIに投げる」ようにして
     * いたが、それだと開発モードの意味が「たいていユニットを使わない」に
     * なってしまう。ユニットを使わずに通しで確かめられることがこのモードの
     * 唯一の存在理由なので、控えられなければ受付を失敗として終える。
     *
     * 失敗するのはディスクが埋まったときなど限られた場合だが、
     * 「限られた場合には課金される」作りにしておくと、いざそれが起きた
     * ときに気づけないまま枠を減らすことになる。
     */
    let shown = false;
    try {
      shown = await keepOriginalAsResult(entry);
    } catch (devErr) {
      addLog({
        level: 'error',
        event: 'entry:fallback',
        sequence: entry.sequence,
        message: `開発モードの控えに失敗: ${devErr.message}`,
        detail: { error: devErr.stack || String(devErr) }
      });
    }

    if (shown) {
      deleteStoredFile(entry.sourceFileId);
      entry.sourceFileId = null;
      return;
    }

    entry.status = 'error';
    entry.error = '開発モードのため、撮影した写真をそのまま出そうとしましたが控えられませんでした';
    if (entry.sourceFileId) {
      deleteStoredFile(entry.sourceFileId);
      entry.sourceFileId = null;
    }
    addLog({
      level: 'error',
      event: 'entry:error',
      sequence: entry.sequence,
      message: '開発モードのため、aging APIには送らずに失敗として終えました'
    });
    return;
  }

  try {
    const srcFileUrl = `${origin}${BASE_PATH}/files/${entry.sourceFileId}`;
    entry.taskId = await startAgingTask(srcFileUrl, entry.sequence);

    const results = await pollAgingTask(entry.taskId, entry.sequence);

    // 元画像はaging APIが取得し終えているので、ここで削除してよい
    deleteStoredFile(entry.sourceFileId);
    entry.sourceFileId = null;
    addLog({ event: 'source:deleted', sequence: entry.sequence, message: '元画像を削除' });

    const outputs = results?.output || [];
    if (outputs.length === 0) {
      throw new Error('生成結果が空でした');
    }

    const wanted = selectSavedOutputs(outputs);
    entry.outputs = await Promise.all(
      wanted.map((output, index) => downloadResultImage(entry.id, index, output, entry.sequence))
    );
    entry.age = results.age ?? null;
    // age_idx は「いまの年齢」がAPIの返した何枚目かを指す。絞り込むと
    // 番号がずれるうえ、その1枚は取り込んでいないので持たない
    entry.ageIdx = wanted.length === outputs.length && Number.isInteger(results.age_idx)
      ? results.age_idx
      : null;
    entry.ageMin = results.age_min ?? null;
    entry.ageMax = results.age_max ?? null;
    entry.status = 'ready';
    addLog({
      event: 'entry:ready',
      sequence: entry.sequence,
      message: wanted.length === outputs.length
        ? `結果画像 ${entry.outputs.length}枚を保存`
        : `結果画像 ${entry.outputs.length}枚を保存(${outputs.length}枚中、${wanted.map((o) => `${o.res_age}歳`).join('/')})`
    });
  } catch (err) {
    entry.status = 'error';
    entry.error = err.message;
    entry.errorCode = err.code || null;
    if (entry.sourceFileId) {
      deleteStoredFile(entry.sourceFileId);
      entry.sourceFileId = null;
    }
    addLog({
      level: 'error',
      event: 'entry:error',
      sequence: entry.sequence,
      // 一覧には原因の頭だけ(describeAgingErrorの summary にあたる部分)。
      // コードやAPIの原文、例外の全文は詳細で見る
      message: (err.message || '生成に失敗').split(' / ')[0],
      detail: { error: err.stack || String(err) }
    });
  }
}

/**
 * 撮った写真を、加工せずそのまま閲覧ブースに出せるようにする。
 *
 * **開発モードのときだけ呼ぶ。** 本番でこれをやると、加工されていない写真が
 * 「未来のあなた」として出てしまう。
 *
 * 元の写真は uploads 側の保持期間で消えるため、results 側へ複製して
 * 受付と寿命を揃える(受付を削除すれば一緒に消える)。
 *
 * @param {object} entry
 * @returns {Promise<boolean>} 出せるようにできたか
 */
async function keepOriginalAsResult(entry) {
  const source = entry.sourceFileId && fileStore.get(entry.sourceFileId);
  if (!source) return false;

  try {
    const filePath = path.join(RESULTS_DIR, `${entry.id}-original.jpg`);
    await fs.promises.copyFile(source.filePath, filePath);
    // 年齢は無い。閲覧ブースと係員画面はこれを見て「元の写真」と分かる
    entry.outputs = [{ resAge: null, filePath }];
    entry.fallback = true;
    entry.status = 'ready';
    addLog({
      level: 'warn',
      event: 'entry:fallback',
      sequence: entry.sequence,
      message: '開発モードのため、aging APIに送らず撮影した写真をそのまま表示します'
    });
    return true;
  } catch (copyErr) {
    addLog({
      level: 'error',
      event: 'entry:fallback',
      sequence: entry.sequence,
      message: `元の写真を控えられません: ${copyErr.message}`,
      detail: { error: copyErr.stack || String(copyErr) }
    });
    return false;
  }
}

/**
 * APIが返した結果のうち、実際に取り込むものを選ぶ。
 * SAVED_RESULT_AGE が null なら全部、そうでなければその年齢に最も近い1枚。
 * (依頼内容によってAPIが返す年齢は変わるため、完全一致は求めない)
 * @param {Array<{res_age: number, url: string}>} outputs
 */
function selectSavedOutputs(outputs) {
  if (SAVED_RESULT_AGE === null || outputs.length === 0) {
    return outputs;
  }
  const nearest = outputs.reduce((best, output) =>
    Math.abs(output.res_age - SAVED_RESULT_AGE) < Math.abs(best.res_age - SAVED_RESULT_AGE) ? output : best
  );
  return [nearest];
}

/**
 * POST /api/entries
 * 撮影ブースから写真を受け取り、受付番号を返してaging処理を裏で開始する。
 * multipart/form-data: file(JPEG), origin(公開オリジン)
 */
router.post('/api/entries', requireBasicAuth, (req, res) => {
  if (!AGING_API_KEY) {
    return res.status(500).json({ error: 'サーバーにAGING_API_KEYが設定されていません(.envを確認してください)' });
  }

  upload.single('file')(req, res, async (err) => {
    if (err) {
      return res.status(400).json({ error: err.message });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'ファイルが送信されていません' });
    }
    /*
     * 本日の受付を終えていたら受け取らない。他の検査より先に見る。
     *
     * 撮影ブースは締め切りを見て撮影そのものを出さなくなるため、ここに
     * 来るのは「押した直後に締め切られた」場合だけ。念のための最後の砦で、
     * 上限を1人でも超えないようにするためにサーバー側でも断る。
     * 締め切っているのに「JPEGではありません」と返すと、撮影ブースが
     * 掲示ではなく撮り直しの案内を出してしまうため、ここが先。
     */
    if (serviceIsClosed()) {
      discardUpload(req.file.path);
      addLog({ level: 'warn', event: 'entry:closed', status: 409, message: '本日の受付終了後に写真が届いたため受け取りませんでした' });
      return res.status(409).json({ error: '本日の受付は終了しました', service: serviceState() });
    }
    if (!isJpegFile(req.file.path)) {
      discardUpload(req.file.path);
      return res.status(400).json({ error: 'JPEG画像として認識できないファイルです' });
    }

    const origin = resolvePublicOrigin(req.body?.origin);
    if (!origin) {
      discardUpload(req.file.path);
      return res.status(400).json({ error: '許可されていないoriginです' });
    }
    if (entryStore.size >= MAX_ENTRIES) {
      discardUpload(req.file.path);
      return res.status(507).json({ error: '受付の上限に達しています' });
    }
    const capturedAtMs = Date.now();
    const sourceFileId = req.generatedFileId;
    fileStore.set(sourceFileId, {
      filePath: req.file.path,
      originalName: req.file.originalname,
      mimeType: req.file.mimetype,
      size: req.file.size,
      uploadedAtMs: capturedAtMs,
      uploadedAt: new Date(capturedAtMs).toISOString()
    });

    entrySequence += 1;
    const entry = {
      id: randomUUID(),
      sequence: entrySequence,
      capturedAtMs,
      status: 'processing',
      error: null,
      errorCode: null,
      // 加工できず、元の写真をそのまま出しているか(開発モードのみ)
      fallback: false,
      sourceFileId,
      taskId: null,
      outputs: [],
      age: null,
      ageIdx: null,
      ageMin: null,
      ageMax: null,
      viewedAtMs: null
    };
    entryStore.set(entry.id, entry);

    addLog({ event: 'entry:created', status: 201, sequence: entry.sequence, message: `${req.file.size}バイトを受信` });

    // 上限を入れてあるときだけ数える。達した時点で、この先の受付が止まる
    if (serviceLimit !== null) {
      serviceCounted += 1;
      if (serviceLimitReached()) {
        serviceClosedAtMs = Date.now();
        addLog({
          level: 'warn',
          event: 'service:closed',
          echo: true,
          message: `人数上限 ${serviceLimit}人に達したため本日の受付を終了しました`
        });
      }
    }

    // 撮影ブースを待たせないよう、生成はレスポンス後に裏で進める。
    // 待たない代わりに、失敗の行き先をここで必ず受けておく
    // (受けないと、拾われなかったPromiseの失敗としてプロセスごと落ちる)
    processEntry(entry, origin).catch((err) => {
      entry.status = 'error';
      entry.error = err.message;
      addLog({
        level: 'error',
        event: 'entry:error',
        sequence: entry.sequence,
        message: (err.message || '生成に失敗').split(' / ')[0],
        detail: { error: err.stack || String(err) }
      });
    });

    res.status(201).json({
      entry_id: entry.id,
      sequence: entry.sequence,
      captured_at: new Date(capturedAtMs).toISOString()
    });
  });
});

/**
 * GET /api/entries
 * 受付の一覧を撮影時刻の古い順に返す(閲覧ブースの一覧・係員の確認用)。
 */
router.get('/api/entries', requireBasicAuth, revalidate, (req, res) => {
  const entries = entriesInOrder().map(toPublicEntry);
  res.json({
    entries,
    waiting: entries.filter((entry) => entry.status === 'ready' && !entry.viewed_at).length,
    processing: entries.filter((entry) => entry.status === 'processing').length
  });
});

/**
 * GET /api/display
 * 閲覧ブースに映している内容。職員が入れ替えるまで変わらない。
 */
router.get('/api/display', requireBasicAuth, revalidate, (req, res) => {
  res.json(currentDisplay());
});

/**
 * POST /api/display/advance
 * 未表示のうち古い順に DISPLAY_SLOT_COUNT 人分を画面に載せ替え、
 * 閲覧ブースを結果画面に切り替える(係員の「結果画面に移行」)。
 */
router.post('/api/display/advance', requireBasicAuth, (req, res) => {
  if (!displayUpdatesEnabled) {
    addLog({ level: 'warn', event: 'display:locked', message: '更新が無効のため結果画面に移行できません' });
    return res.status(409).json({ error: '閲覧ブースの更新が無効になっています', ...currentDisplay() });
  }

  const next = entriesInOrder()
    .filter((entry) => entry.status === 'ready' && !entry.viewedAtMs)
    .slice(0, DISPLAY_SLOT_COUNT);

  // 開発モードでは、足りないぶんを見本で埋めて結果画面を出せる。
  // 通常は1件も無ければ何もしない(誤って空の結果画面を出さないため)。
  if (next.length === 0 && !devMode) {
    addLog({ level: 'warn', event: 'display:advance', message: '表示できる受付がありませんでした' });
    return res.status(409).json({ error: '表示できる受付がありません', ...currentDisplay() });
  }

  const now = Date.now();
  for (const entry of next) {
    entry.viewedAtMs = now;
  }
  displayBatch = next.map((entry) => entry.id);
  /*
   * 並べるのは届いた人数ぶんだけ(空きは作らない)。
   *
   * 開発モードでも、実際の受付があるときは本番とまったく同じ人数で出す。
   * 見本で水増しすると、本物の写真が出ているときの見え方が変わってしまうため。
   * 受付が1件も無いときだけ、選んだ人数を見本で埋める。
   */
  displayPlaceholders = devMode && next.length === 0 ? devPlaceholderCount : 0;
  displayUpdatedAtMs = now;
  displayMode = 'results';

  const shown = next.length > 0 ? `番号 ${next.map((entry) => entry.sequence).join(', ')} を表示` : '受付なし';
  addLog({
    level: displayPlaceholders > 0 ? 'warn' : 'info',
    event: 'display:advance',
    message: displayPlaceholders > 0 ? `${shown}(開発モード: 見本 ${displayPlaceholders}件を追加)` : shown
  });
  res.json(currentDisplay());
});

/**
 * POST /api/display/theme
 * 閲覧ブースの待機演出の絵柄を切り替える(仮運用)。
 * body: { "theme": "realistic" | "storybook" }
 */
router.post('/api/display/theme', requireBasicAuth, (req, res) => {
  const theme = req.body?.theme;
  if (!DISPLAY_THEMES.includes(theme)) {
    return res.status(400).json({ error: '未知の絵柄です', themes: DISPLAY_THEMES });
  }

  displayTheme = theme;
  addLog({ event: 'display:theme', message: `待機演出を ${theme} に切り替え` });
  res.json(currentDisplay());
});

/**
 * POST /api/display/clear
 * 閲覧ブースを待機画面に戻す(係員の「待機画面に移行」)。
 * 待機画面では背景の演出だけを映し、結果の区画は出さない。
 */
router.post('/api/display/clear', requireBasicAuth, (req, res) => {
  if (!displayUpdatesEnabled) {
    addLog({ level: 'warn', event: 'display:locked', message: '更新が無効のため待機画面に移行できません' });
    return res.status(409).json({ error: '閲覧ブースの更新が無効になっています', ...currentDisplay() });
  }

  displayBatch = [];
  displayPlaceholders = 0;
  displayUpdatedAtMs = Date.now();
  displayMode = 'waiting';
  addLog({ event: 'display:clear', message: '待機画面に移行' });
  res.json(currentDisplay());
});

/**
 * POST /api/service
 * 本日の受付を終える / 再開する / 人数上限を決める(係員用)。
 *
 * body の項目はどれも省略でき、届いたものだけを変える。
 *   { "closed": true }        強制終了。この時点で撮影ブースと閲覧ブースに掲示が出る
 *   { "closed": false }       再開。上限に達して止まっていた場合は0人から数え直す
 *   { "limit": 120 }          上限を120人にして、この時点から数え始める(0人に戻す)
 *   { "limit": null }         上限を解除する(強制終了は解除しない)
 */
router.post('/api/service', requireBasicAuth, (req, res) => {
  const body = req.body || {};
  const hasClosed = Object.prototype.hasOwnProperty.call(body, 'closed');
  const hasLimit = Object.prototype.hasOwnProperty.call(body, 'limit');

  if (!hasClosed && !hasLimit) {
    return res.status(400).json({ error: 'closed か limit のどちらかを指定してください' });
  }
  if (hasClosed && typeof body.closed !== 'boolean') {
    return res.status(400).json({ error: 'closed には true か false を指定してください' });
  }
  /*
   * 数として受け取れるかではなく、**数で送られてきたか**を見る。
   *
   * Number() に通すだけだと true が 1 に、[5] が 5 に、"0x10" が 16 になる。
   * とくに true → 1 は、送る側の取り違え1つで「1人で本日の受付終了」に
   * なってしまい、しかも 200 が返るので気づけない。
   * 上限は展示そのものを止める値なので、曖昧な受け取り方をしない。
   */
  if (hasLimit && body.limit !== null) {
    const wanted = body.limit;
    if (typeof wanted !== 'number' || !Number.isInteger(wanted) || wanted < 1 || wanted > MAX_SERVICE_LIMIT) {
      return res.status(400).json({ error: `limit は 1〜${MAX_SERVICE_LIMIT} の整数(数値)か null で指定してください` });
    }
  }

  if (hasLimit) {
    if (body.limit === null) {
      serviceLimit = null;
      serviceLimitSetAtMs = null;
      serviceCounted = 0;
      addLog({ level: 'warn', event: 'service:limit', message: '人数上限を解除しました(以後は数えません)' });
    } else {
      serviceLimit = Number(body.limit);
      serviceLimitSetAtMs = Date.now();
      // 入れ直したらその時点から数え直す。前日の試写や朝の試運転を
      // 来場者ぶんとして数えてしまわないようにするため
      serviceCounted = 0;
      addLog({
        level: 'warn',
        event: 'service:limit',
        echo: true,
        message: `人数上限を ${serviceLimit}人に設定しました(いまから0人で数え直します)`
      });
    }
  }

  if (hasClosed) {
    if (body.closed) {
      serviceClosedManually = true;
      serviceClosedAtMs = Date.now();
      addLog({ level: 'warn', event: 'service:closed', echo: true, message: '係員の操作により本日の受付を終了しました' });
    } else {
      serviceClosedManually = false;
      serviceClosedAtMs = null;
      // 上限に達したまま再開すると、その場でまた終了してしまう。
      // 再開と言われたら実際に受け付けられる状態にする
      if (serviceLimitReached()) {
        serviceCounted = 0;
        serviceLimitSetAtMs = Date.now();
        addLog({ level: 'warn', event: 'service:limit', message: `上限に達していたため、いまから0人で数え直します(上限 ${serviceLimit}人)` });
      }
      addLog({ level: 'warn', event: 'service:open', echo: true, message: '本日の受付を再開しました' });
    }
  }

  res.json(currentDisplay());
});

/**
 * POST /api/display/updates
 * 閲覧ブースの入れ替えを受け付けるかを切り替える(係員用)。
 * body: { "enabled": true | false }
 */
router.post('/api/display/updates', requireBasicAuth, (req, res) => {
  const enabled = req.body?.enabled;
  if (typeof enabled !== 'boolean') {
    return res.status(400).json({ error: 'enabled には true か false を指定してください' });
  }

  displayUpdatesEnabled = enabled;
  addLog({
    level: enabled ? 'info' : 'warn',
    event: 'display:updates',
    message: enabled ? '閲覧ブースの更新を有効化' : '閲覧ブースの更新を無効化'
  });
  res.json(currentDisplay());
});

/**
 * POST /api/dev
 * 開発モードの出入りと、見本で埋める人数の指定(係員用)。
 * 抜けるときは、出していた見本をその場で片付ける。
 * body: { "enabled": true | false, "placeholders": 1〜DISPLAY_SLOT_COUNT }
 */
router.post('/api/dev', requireBasicAuth, (req, res) => {
  const enabled = req.body?.enabled;
  if (typeof enabled !== 'boolean') {
    return res.status(400).json({ error: 'enabled には true か false を指定してください' });
  }

  // 人数ごとの並びを確かめられるよう、見本の枚数を選べる
  // 上限と同じ理由で、数で送られてきたときだけ受ける(true が 1 にならないように)
  const wanted = req.body?.placeholders;
  if (wanted !== undefined && wanted !== null) {
    if (typeof wanted !== 'number' || !Number.isInteger(wanted)) {
      return res.status(400).json({ error: `placeholders は 1〜${DISPLAY_SLOT_COUNT} の整数(数値)で指定してください` });
    }
    if (wanted < 1 || wanted > DISPLAY_SLOT_COUNT) {
      return res.status(400).json({ error: `placeholders は 1〜${DISPLAY_SLOT_COUNT} で指定してください` });
    }
    devPlaceholderCount = wanted;
    // すでに見本だけを出しているなら、その場で枚数を合わせる
    // (本物の受付を出しているときは触らない。本番と同じ見え方を保つため)
    if (devMode && displayPlaceholders > 0 && displayBatch.length === 0) {
      displayPlaceholders = devPlaceholderCount;
      displayUpdatedAtMs = Date.now();
    }
  }

  devMode = enabled;
  if (!devMode) {
    /*
     * 開発モードのものを本番に持ち越さない。
     * 加工前の写真をそのまま出している受付は、ここで消す。
     * 残すと「未来のあなた」として加工されていない写真が出てしまう。
     */
    const fallbacks = [...entryStore.values()].filter((entry) => entry.fallback);
    for (const entry of fallbacks) deleteEntry(entry.id);
    if (fallbacks.length > 0) {
      addLog({
        level: 'warn',
        event: 'dev:mode',
        message: `加工前の写真で出していた受付 ${fallbacks.length}件を削除`
      });
    }

    if (displayPlaceholders > 0 || fallbacks.length > 0) {
      // 見本を出したまま本番に戻さない。実際の受付が1件も無ければ待機画面へ。
      displayPlaceholders = 0;
      displayBatch = displayBatch.filter((id) => entryStore.has(id));
      if (displayBatch.length === 0) {
        displayMode = 'waiting';
      }
      displayUpdatedAtMs = Date.now();
    }
  }

  addLog({
    level: enabled ? 'warn' : 'info',
    event: 'dev:mode',
    message: enabled ? '開発モードに移行(見本での表示を許可)' : '開発モードを終了'
  });
  res.json(currentDisplay());
});

/**
 * GET /api/dev/placeholder/:index
 * 開発モードで結果画面を埋める見本画像。SVGをその場で組んで返すため、
 * aging APIもディスクも使わない。開発モードでないときは返さない。
 */
router.get('/api/dev/placeholder/:index', requireBasicAuth, (req, res) => {
  if (!devMode) {
    return res.status(409).json({ error: '開発モードではありません' });
  }

  const index = Number(req.params.index);
  if (!Number.isInteger(index) || index < 0 || index >= DISPLAY_SLOT_COUNT) {
    return res.status(404).json({ error: '見本の番号が範囲外です' });
  }

  const { width, height } = DEV_PLACEHOLDER_SIZE;
  const color = DEV_PLACEHOLDER_COLORS[index % DEV_PLACEHOLDER_COLORS.length];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`
    + `<rect width="${width}" height="${height}" fill="${color}"/>`
    + `<rect x="24" y="24" width="${width - 48}" height="${height - 48}" fill="none" stroke="#ffffff" stroke-opacity="0.5" stroke-width="8" stroke-dasharray="32 24"/>`
    + `<text x="50%" y="42%" text-anchor="middle" font-family="sans-serif" font-size="${Math.round(height * 0.22)}" font-weight="bold" fill="#ffffff">${index + 1}</text>`
    + `<text x="50%" y="60%" text-anchor="middle" font-family="sans-serif" font-size="${Math.round(height * 0.075)}" fill="#ffffff" fill-opacity="0.9">開発モードの見本</text>`
    + `<text x="50%" y="70%" text-anchor="middle" font-family="sans-serif" font-size="${Math.round(height * 0.05)}" fill="#ffffff" fill-opacity="0.75">${width} × ${height}</text>`
    + '</svg>';

  res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.send(svg);
});

/**
 * POST /api/heartbeat
 * 各ブースのページから定期的に届く生存確認。往復時間やエラー件数も受け取り、
 * 係員画面で「どのブースが今も繋がっているか」を見えるようにする。
 */
router.post('/api/heartbeat', requireBasicAuth, (req, res) => {
  const { client_id: rawClientId, role, page, latency_ms: latencyMs, error_count: errorCount } = req.body || {};
  if (!rawClientId) {
    return res.status(400).json({ error: 'client_idが指定されていません' });
  }

  // 表の鍵も切り詰めた値にする。切る前の値を鍵にすると、長さの違うだけの
  // IDを送られたぶん表が伸びてしまう
  const clientId = String(rawClientId).slice(0, CLIENT_ID_MAX_CHARS);

  const known = clientStore.get(clientId);
  // 上限を超えたら、最も長く音沙汰のないものから捨てる
  if (!known && clientStore.size >= MAX_CLIENTS) {
    const oldest = [...clientStore.entries()].sort((a, b) => a[1].lastSeenMs - b[1].lastSeenMs)[0];
    if (oldest) clientStore.delete(oldest[0]);
  }
  clientStore.set(clientId, {
    id: clientId,
    role: String(role || 'unknown').slice(0, 32),
    page: String(page || '').slice(0, 64),
    firstSeenMs: known?.firstSeenMs || Date.now(),
    lastSeenMs: Date.now(),
    latencyMs: Number.isFinite(latencyMs) ? Math.round(latencyMs) : null,
    errorCount: Number.isInteger(errorCount) ? errorCount : 0,
    beats: (known?.beats || 0) + 1
  });

  res.json({ server_time: new Date().toISOString() });
});

/**
 * GET /api/status
 * 各ブースとの通信状況、aging APIとの通信状況、サーバーの稼働状況。
 */
router.get('/api/status', requireBasicAuth, (req, res) => {
  const now = Date.now();

  // 長く音沙汰のないクライアントは一覧から落とす
  for (const [clientId, client] of clientStore) {
    if (now - client.lastSeenMs > 10 * 60 * 1000) {
      clientStore.delete(clientId);
    }
  }

  res.json({
    server: {
      now: new Date(now).toISOString(),
      commit: SERVER_COMMIT,
      started_at: new Date(SERVER_STARTED_AT_MS).toISOString(),
      uptime_ms: now - SERVER_STARTED_AT_MS,
      entries: entryStore.size,
      logs: logStore.length,
      /*
       * このサーバーから見た「要求の出どころ」。
       * 前段(CDNなど)が入ると、ここが皆同じ値になったり、要求ごとに
       * 散ったりする。認証の失敗を接続元ごとに数える仕組みが効いているか、
       * ここを見れば分かる(散っていれば効かない)。
       */
      client_ip: req.ip || null,
      forwarded_for: req.get('x-forwarded-for') || null,
      auth_failures_10min: authFailTotal
    },
    aging_api: {
      last_status: agingApiHealth.lastStatus,
      last_at: agingApiHealth.lastAtMs ? new Date(agingApiHealth.lastAtMs).toISOString() : null,
      last_error: agingApiHealth.lastError,
      ok_count: agingApiHealth.okCount,
      error_count: agingApiHealth.errorCount
    },
    clients: [...clientStore.values()]
      .sort((a, b) => a.role.localeCompare(b.role) || a.firstSeenMs - b.firstSeenMs)
      .map((client) => ({
        id: client.id,
        role: client.role,
        page: client.page,
        online: now - client.lastSeenMs <= CLIENT_OFFLINE_MS,
        last_seen_at: new Date(client.lastSeenMs).toISOString(),
        silent_ms: now - client.lastSeenMs,
        latency_ms: client.latencyMs,
        error_count: client.errorCount,
        beats: client.beats
      }))
  });
});

/**
 * GET /api/logs
 * 処理履歴(サーバー・クライアント双方)を新しい順に返す。
 *
 * **詳細(where/error/request/response)はここでは返さない。**
 * 係員画面はこれを3秒ごとに取りに来る。詳細は1件あたり最大4000文字×3項目
 * あるため、全部載せると1回の応答が数MBになり、それを1時間に1200回
 * 繰り返すことになる(実測でGB/時の桁)。Renderの送信量はワークスペース
 * ごとの月単位で、使い切るとサービスが止まるため、ここで通信量が
 * 増えるほど展示そのものが危うくなる。しかも詳細が大きくなるのは
 * 異常が続いているときなので、いちばん止まってほしくないときに
 * いちばん速く使い切る作りになってしまう。
 *
 * 代わりに has_detail だけを返し、実際の中身は開いたときに
 * GET /api/logs/:id で1件だけ取りに来てもらう。
 */
function toPublicLog(log) {
  const { detail, ...rest } = log;
  return { ...rest, has_detail: detail !== null && detail !== undefined };
}

router.get('/api/logs', requireBasicAuth, revalidate, (req, res) => {
  // クエリは必ず文字列で来るので数に直す。負の数や桁違いはここで丸める
  // (負のまま slice に渡すと、新しい順のはずが末尾を削る動きになる)
  const asked = Number(req.query.limit);
  const limit = Number.isFinite(asked) && asked > 0
    ? Math.min(Math.floor(asked), MAX_LOG_ENTRIES)
    : 100;
  res.json({ logs: [...logStore].reverse().slice(0, limit).map(toPublicLog) });
});

/**
 * GET /api/logs/:id
 * 1件の処理履歴を、詳細つきで返す(係員が「内容」を押したとき)。
 */
router.get('/api/logs/:id', requireBasicAuth, (req, res) => {
  const id = Number(req.params.id);
  const log = Number.isInteger(id) ? logStore.find((entry) => entry.id === id) : null;
  if (!log) {
    // 古いものは押すまでに流れていることがある。係員画面はこれを見て案内を出す
    return res.status(404).json({ error: 'その記録はもう残っていません' });
  }
  res.json(log);
});

/**
 * POST /api/logs
 * 各ブースのブラウザから通信結果を送ってもらい、同じ時系列に残す。
 */
router.post('/api/logs', requireBasicAuth, (req, res) => {
  const { level, event, message, status, sequence, detail } = req.body || {};
  if (!event) {
    return res.status(400).json({ error: 'eventが指定されていません' });
  }

  addLog({
    source: 'client',
    level: ['info', 'warn', 'error'].includes(level) ? level : 'info',
    event: String(event).slice(0, 80),
    message,
    status: Number.isInteger(status) ? status : null,
    sequence: Number.isInteger(sequence) ? sequence : null,
    // 届いた詳細は normaliseDetail が形と長さを整える
    detail
  });
  res.status(204).send();
});

/**
 * GET /api/entries/:entry_id
 */
router.get('/api/entries/:entry_id', requireBasicAuth, (req, res) => {
  const entry = entryStore.get(req.params.entry_id);
  if (!entry) {
    return res.status(404).json({ error: '指定された受付は存在しません' });
  }
  res.json(toPublicEntry(entry));
});

/**
 * DELETE /api/entries/:entry_id
 * 係員が個別に取り消す用。結果画像もまとめて削除する。
 */
router.delete('/api/entries/:entry_id', requireBasicAuth, (req, res) => {
  const entry = entryStore.get(req.params.entry_id);
  if (!entry) {
    return res.status(404).json({ error: '指定された受付は存在しません' });
  }
  addLog({ level: 'warn', event: 'entry:deleted', sequence: entry.sequence, message: '係員が取り消し' });
  deleteEntry(req.params.entry_id);
  res.status(204).send();
});

/**
 * GET /api/entries/:entry_id/images/:index
 * 取り込み済みの結果画像を返す。
 */
router.get('/api/entries/:entry_id/images/:index', requireBasicAuth, (req, res) => {
  const entry = entryStore.get(req.params.entry_id);
  const output = entry?.outputs[Number(req.params.index)];
  if (!output) {
    return res.status(404).json({ error: '指定された結果画像は存在しません' });
  }
  if (!fs.existsSync(output.filePath)) {
    return res.status(410).json({ error: '結果画像は既に削除されています' });
  }

  res.setHeader('Content-Type', 'image/jpeg');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.sendFile(output.filePath);
});

/**
 * GET /files/:file_id
 *
 * aging APIに渡した src_file_url の実体。**ここだけはBasic認証の外に置く。**
 * 生成を頼む相手(aging API)が、こちらの資格情報を持たないまま元画像を
 * 取りに来るため。file_idは推測できない値(UUID v4)で、生成が終わった時点で
 * 消えるので、公開しているのは「たまたまURLを知り得た短い間だけ」になる。
 */
router.get('/files/:file_id', (req, res) => {
  const fileInfo = fileStore.get(req.params.file_id);

  if (!fileInfo) {
    return res.status(404).json({ error: '指定されたfile_idは存在しません' });
  }

  if (!fs.existsSync(fileInfo.filePath)) {
    return res.status(410).json({ error: 'ファイルは既に削除されています' });
  }

  res.setHeader('Content-Type', fileInfo.mimeType);
  // 万一JPEG以外の内容が紛れ込んでも、ブラウザに別形式として解釈させない
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.sendFile(fileInfo.filePath);
});

//NOTE: ここからRender公開用の配信設定。フロントエンドとAPIを同一オリジンで配信し、全体をAPP_BASE_PATHの推測困難なパス配下に隠す。Renderのヘルスチェックだけは認証と公開パスの外に置く必要があるため別扱いにしている
app.get('/healthz', (req, res) => {
  res.type('text/plain').send('ok');
});

/*
 * フロントエンドの静的配信。Basic認証の対象にする。
 * (Codespaceでは従来通り `npm run serve:web` で別ポートから配信してもよい)
 *
 * public/vendor には、外部から取ってきてそのまま同梱しているものが入る
 * (撮影ブースの背景合成に使う MediaPipe Selfie Segmentation)。
 * .wasm は型が合っていないとブラウザが読み込みを拒むため明示する。
 * .tflite や .binarypb はもともと型を持たないので既定のまま
 * (application/octet-stream) でよい。
 */
router.use(requireBasicAuth, express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.wasm')) {
      res.setHeader('Content-Type', 'application/wasm');
    }
  }
}));

app.use(BASE_PATH || '/', router);

/*
 * どこを叩いても、資格情報が無ければ同じ401を返す。
 *
 * 公開パスは「推測困難であること」を頼りにしている。ところが、正しいパスは
 * 認証を求めて401、外れたパスは404、と応答が違うと、**資格情報を一つも
 * 持たない相手でも、応答の違いだけで公開パスを総当たりで探し当てられる。**
 * 401が返った時点で「ここが入口だ」と分かってしまう。
 *
 * そこで、routerが受け取らなかった要求もこの中継を通し、資格情報が無ければ
 * 401、あれば普通の404を返す。外から見ると、どのパスも区別なく401になる。
 * 総当たりは処理履歴にも残り、続けば応答が遅くなる(requireBasicAuthと同じ)。
 *
 * ヘルスチェック(/healthz)はこれより前に登録してあるので影響を受けない。
 * Expressの既定のエラー画面(Expressだと分かるHTML)もここで置き換わる。
 */
app.use(requireBasicAuth, (req, res) => {
  res.status(404).json({ error: '見つかりません' });
});
//NOTE: ここまでRender公開用の配信設定

/*
 * 想定していない例外で、プロセスごと落ちないようにする。
 *
 * Node 22は、拾われなかった例外と拾われなかったPromiseの失敗で
 * プロセスを終了させる。ここでのそれは「Renderが新しいインスタンスを
 * 立ち上げる」という意味になり、**保管していた受付と結果が全部消え、
 * 受付番号も1番に戻る**。展示中にこれが起きるのがいちばん困る。
 *
 * ふつうのサーバーなら、状態が壊れている可能性があるので落として
 * 入れ直すのが正しい。ここでそうしないのは、
 *
 *  - 落ちたときに失われるものが、来場者の写真そのものだから
 *  - ここで起きうる例外は要求1件ぶんの処理の中の出来事(消そうとした
 *    ファイルがもう無い、など)で、他の受付の状態を壊すものではないから
 *  - 落ちれば「確実に全部消える」のに対し、続ければ「その1件だけが
 *    失敗する」で済むから
 *
 * の3つによる。握りつぶすのではなく、処理履歴とホスティング側のログの
 * 両方に必ず残すので、あとから追える。
 */
function survive(kind, err) {
  addLog({
    level: 'error',
    event: 'server:survived',
    echo: true,
    message: `${kind}: ${err?.message || String(err)}（処理を続けます）`,
    detail: { error: err?.stack || String(err) }
  });
}

process.on('uncaughtException', (err) => survive('拾われなかった例外', err));
process.on('unhandledRejection', (reason) => survive('拾われなかったPromiseの失敗', reason));

// "0.0.0.0"を明示することで、IPv6優先バインドとの相性問題により
// GitHub Codespacesのポート転送プロキシ(IPv4経由)から到達できず
// Bad Gatewayになるケースを避ける。
app.listen(PORT, '0.0.0.0', () => {
  // 処理履歴の先頭に残す。再起動すると受付中の写真と結果が消えるため、
  // 係員が「なぜ番号が出てこないのか」を追えるようにしておく。
  // echo でホスティング側のログにも出す。起動した事実と待ち受けポートは、
  // 係員画面を開けないうちに確認したい唯一の情報のため。
  addLog({
    event: 'server:start',
    echo: true,
    message: `http://localhost:${PORT}${BASE_PATH || ''}/ で待ち受け開始(保管中の受付と結果は初期化されています)`
  });

  // 公開パスの書き方が怪しいときは、起動直後に気づけるようにする。
  // 会場で「どの画面も開けない」となってから探すことにならないため
  if (BASE_PATH_WARNING) {
    addLog({ level: 'error', event: 'server:start', echo: true, message: BASE_PATH_WARNING });
  }
  if (process.env.APP_BASE_PATH && process.env.APP_BASE_PATH.trim() !== BASE_PATH) {
    addLog({
      level: 'warn',
      event: 'server:start',
      echo: true,
      message: `APP_BASE_PATH を "${process.env.APP_BASE_PATH}" から "${BASE_PATH}" として扱いました`
    });
  }
  if (!BASIC_AUTH_USER || !BASIC_AUTH_PASSWORD) {
    addLog({ level: 'error', event: 'server:start', echo: true, message: 'Basic認証が無効です(BASIC_AUTH_USER と BASIC_AUTH_PASSWORD の両方が必要)' });
  }
});