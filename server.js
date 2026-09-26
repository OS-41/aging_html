/**
 * file_idベースの画像アップロード・取得サーバー（Express.js）
 *
 * 事前にインストールが必要なパッケージ:
 *   npm install express multer cors
 *
 * 起動方法:
 *   node server.js
 *   -> http://localhost:5000 で待ち受け
 *
 * フロントエンド(public/index.html)の配信は `npx serve public` で行う。
 * リポジトリのルートを静的配信すると .env / .git / uploads まで公開されて
 * しまうため、公開してよいファイルだけを置いた public/ 配下のみを配信する。
 *
 * 画面:
 *   /               1台で完結する単体版(開発・動作確認用)
 *   /capture.html   撮影ブース用
 *   /view.html      閲覧ブース用(職員が入れ替えるまで同じ内容を映し続ける)
 *   /staff.html     係員用(表示の操作・保管一覧・処理履歴)
 *
 * エンドポイント(2ブース構成):
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
 *
 * エンドポイント(単体版):
 *   POST /files   画像をアップロードし、file_idを返す
 *   GET  /files/:file_id   file_idに対応する画像を返す(aging APIがここから取得する)
 *   DELETE /files/:file_id file_idに対応する画像を削除する
 *   POST /api/aging/start/:file_id  アップロード済みfile_idを元にaging APIへタスクを開始する(APIキーはサーバー側の.envから使用)
 *   GET  /api/aging/:taskId         aging APIのタスク状況をポーリングする
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

// 公開パス。例: APP_BASE_PATH=/k7f3m2q8 とするとアプリ全体が
// https://<host>/k7f3m2q8/ 配下でのみ動く。未設定ならルート直下。
const BASE_PATH = (process.env.APP_BASE_PATH || '').replace(/\/+$/, '');

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
function requireBasicAuth(req, res, next) {
  if (!BASIC_AUTH_USER || !BASIC_AUTH_PASSWORD) {
    return next();
  }

  const [scheme, encoded] = (req.get('authorization') || '').split(' ');
  if (scheme === 'Basic' && encoded) {
    const decoded = Buffer.from(encoded, 'base64').toString();
    const separator = decoded.indexOf(':');
    const user = decoded.slice(0, separator);
    const password = decoded.slice(separator + 1);
    if (safeEqual(user, BASIC_AUTH_USER) && safeEqual(password, BASIC_AUTH_PASSWORD)) {
      return next();
    }
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

app.use(express.json());

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

// アップロードは認証なしで受け付けるため、保持上限と保持期間を設けて
// ディスクを使い切られること(DoS)と、顔写真が無期限に残ることを防ぐ。
const MAX_STORED_FILES = 100;
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
    theme: displayTheme,
    themes: DISPLAY_THEMES,
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
 */
function isJpegFile(filePath) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const header = Buffer.alloc(3);
    const bytesRead = fs.readSync(fd, header, 0, 3, 0);
    return bytesRead === 3 && header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff;
  } finally {
    fs.closeSync(fd);
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
    if (!isJpegFile(req.file.path)) {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: 'JPEG画像として認識できないファイルです' });
    }

    const origin = resolvePublicOrigin(req.body?.origin);
    if (!origin) {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: '許可されていないoriginです' });
    }
    if (entryStore.size >= MAX_ENTRIES) {
      fs.unlinkSync(req.file.path);
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

    // 撮影ブースを待たせないよう、生成はレスポンス後に裏で進める
    processEntry(entry, origin);

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
router.get('/api/entries', requireBasicAuth, (req, res) => {
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
router.get('/api/display', requireBasicAuth, (req, res) => {
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
  displayPlaceholders = devMode ? DISPLAY_SLOT_COUNT - next.length : 0;
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
 * 開発モードの出入り(係員用)。
 * 抜けるときは、出していた見本をその場で片付ける。
 * body: { "enabled": true | false }
 */
router.post('/api/dev', requireBasicAuth, (req, res) => {
  const enabled = req.body?.enabled;
  if (typeof enabled !== 'boolean') {
    return res.status(400).json({ error: 'enabled には true か false を指定してください' });
  }

  devMode = enabled;
  if (!devMode && displayPlaceholders > 0) {
    // 見本を出したまま本番に戻さない。実際の受付が1件も無ければ待機画面へ。
    displayPlaceholders = 0;
    if (displayBatch.length === 0) {
      displayMode = 'waiting';
    }
    displayUpdatedAtMs = Date.now();
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
  const { client_id: clientId, role, page, latency_ms: latencyMs, error_count: errorCount } = req.body || {};
  if (!clientId) {
    return res.status(400).json({ error: 'client_idが指定されていません' });
  }

  const known = clientStore.get(clientId);
  clientStore.set(clientId, {
    id: String(clientId).slice(0, 64),
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
      started_at: new Date(SERVER_STARTED_AT_MS).toISOString(),
      uptime_ms: now - SERVER_STARTED_AT_MS,
      entries: entryStore.size,
      logs: logStore.length
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
 */
router.get('/api/logs', requireBasicAuth, (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 100, MAX_LOG_ENTRIES);
  res.json({ logs: [...logStore].reverse().slice(0, limit) });
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
 * POST /files
 * multipart/form-dataでフィールド名 "file" として画像を送信する
 * レスポンス例: { "file_id": "3fa85f64-5717-4562-b3fc-2c963f66afa6" }
 */
router.post('/files', requireBasicAuth, (req, res) => {
  upload.single('file')(req, res, (err) => {
    if (err) {
      addLog({ level: 'warn', event: 'file:upload', status: 400, message: `受け取れません: ${err.message}` });
      return res.status(400).json({ error: err.message });
    }
    if (!req.file) {
      addLog({ level: 'warn', event: 'file:upload', status: 400, message: 'ファイルが送信されていません' });
      return res.status(400).json({ error: 'ファイルが送信されていません' });
    }

    if (!isJpegFile(req.file.path)) {
      fs.unlinkSync(req.file.path);
      addLog({ level: 'warn', event: 'file:upload', status: 400, message: 'JPEGとして認識できないファイル' });
      return res.status(400).json({ error: 'JPEG画像として認識できないファイルです' });
    }

    if (fileStore.size >= MAX_STORED_FILES) {
      fs.unlinkSync(req.file.path);
      addLog({ level: 'error', event: 'file:upload', status: 507, message: `保管上限 ${MAX_STORED_FILES} 件に達しています` });
      return res.status(507).json({ error: '保存できるファイル数の上限に達しています。しばらく待ってから再試行してください' });
    }

    const fileId = req.generatedFileId;
    const uploadedAtMs = Date.now();

    fileStore.set(fileId, {
      filePath: req.file.path,
      originalName: req.file.originalname,
      mimeType: req.file.mimetype,
      size: req.file.size,
      uploadedAtMs,
      uploadedAt: new Date(uploadedAtMs).toISOString()
    });

    addLog({ event: 'file:upload', status: 201, message: `${Math.round(req.file.size / 1024)}KB を受け付け (${fileId})` });
    res.status(201).json({ file_id: fileId });
  });
});

/**
 * GET /files/:file_id
 * file_idに対応する画像バイナリを返す
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

/**
 * DELETE /files/:file_id
 * file_idに対応する画像を削除する
 */
router.delete('/files/:file_id', requireBasicAuth, (req, res) => {
  const fileInfo = fileStore.get(req.params.file_id);

  if (!fileInfo) {
    return res.status(404).json({ error: '指定されたfile_idは存在しません' });
  }

  fs.unlink(fileInfo.filePath, (err) => {
    if (err && err.code !== 'ENOENT') {
      return res.status(500).json({ error: '削除に失敗しました' });
    }
    fileStore.delete(req.params.file_id);
    res.status(204).send();
  });
});

/**
 * POST /api/aging/start/:file_id
 * 事前に POST /files でアップロード済みの file_id を指定してaging APIへ
 * タスク開始をリクエストするプロキシ。
 * aging API自体は画像バイナリではなく「外部から取得可能なURL」を要求するため、
 * このサーバーがホストしている GET /files/:file_id のURLをsrc_file_urlとして
 * 渡す必要がある。GitHub Codespacesのポート転送プロキシ経由だとリクエストの
 * Hostヘッダーが"localhost"に書き換えられてしまい外部から到達できないURLに
 * なってしまうため、ブラウザ側が既に把握している転送後の公開オリジンを
 * body.origin として送ってもらい、それを使って組み立てる。
 * ただしbody.originはクライアントが自由に指定できてしまうため、そのまま
 * 外部APIに渡すと任意のURLを取得させる踏み台(SSRF)にできてしまう。
 * .envのPUBLIC_ORIGINが設定されていればそれを優先し、無い場合でも
 * Codespacesの転送URLかローカル開発用のホストのみを許可する。
 * APIキーはクライアントに渡さず、ここ(サーバー側)でのみ.envから読んで付与する。
 * body: { "origin": "https://xxxx-5000.app.github.dev" }
 */
router.post('/api/aging/start/:file_id', requireBasicAuth, async (req, res) => {
  if (!AGING_API_KEY) {
    addLog({ level: 'error', event: 'aging:start', status: 500, message: 'AGING_API_KEYが設定されていません' });
    return res.status(500).json({ error: 'サーバーにAGING_API_KEYが設定されていません(.envを確認してください)' });
  }
  const fileInfo = fileStore.get(req.params.file_id);
  if (!fileInfo) {
    addLog({ level: 'warn', event: 'aging:start', status: 404, message: `存在しないfile_id: ${req.params.file_id}` });
    return res.status(404).json({ error: '指定されたfile_idは存在しません' });
  }

  const origin = resolvePublicOrigin(req.body?.origin);
  if (!origin) {
    addLog({ level: 'warn', event: 'aging:start', status: 400, message: `許可されていないorigin: ${req.body?.origin}` });
    return res.status(400).json({ error: '許可されていないoriginです(Codespacesの転送URLを指定してください)' });
  }

  const srcFileUrl = `${origin}${BASE_PATH}/files/${req.params.file_id}`;

  try {
    const apiRes = await fetch(AGING_API_BASE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${AGING_API_KEY}`
      },
      body: JSON.stringify({
        request_id: 0,
        src_file_url: srcFileUrl
      })
    });
    const payload = await apiRes.json().catch(() => ({}));
    recordAgingApiCall(apiRes.status, apiRes.ok ? null : payload?.error_message || null);
    addLog({
      level: apiRes.ok ? 'info' : 'error',
      event: 'aging:start',
      status: apiRes.status,
      message: apiRes.ok ? `生成を依頼 (task_id: ${payload?.data?.task_id ?? '不明'})` : `依頼に失敗: ${payload?.error_message ?? ''}`
    });
    res.status(apiRes.status).json(payload);
  } catch (err) {
    recordAgingApiCall(null, err.message);
    addLog({ level: 'error', event: 'aging:start', message: `aging APIへ接続できません: ${err.message}` });
    res.status(502).json({ error: 'aging APIへの接続に失敗しました', detail: err.message });
  }
});

/**
 * GET /api/aging/:taskId
 * aging APIのタスク状況をポーリングするプロキシ。
 */
router.get('/api/aging/:taskId', requireBasicAuth, async (req, res) => {
  if (!AGING_API_KEY) {
    addLog({ level: 'error', event: 'aging:poll', status: 500, message: 'AGING_API_KEYが設定されていません' });
    return res.status(500).json({ error: 'サーバーにAGING_API_KEYが設定されていません(.envを確認してください)' });
  }
  try {
    const apiRes = await fetch(`${AGING_API_BASE_URL}/${req.params.taskId}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${AGING_API_KEY}` }
    });
    const payload = await apiRes.json().catch(() => ({}));
    recordAgingApiCall(apiRes.status, apiRes.ok ? null : payload?.error_message || null);
    // 進行確認は短い間隔で何度も来るため、異常時だけ履歴に残す
    if (!apiRes.ok) {
      addLog({
        level: 'error',
        event: 'aging:poll',
        status: apiRes.status,
        message: `進行確認に失敗: ${payload?.error_message ?? ''}`
      });
    }
    res.status(apiRes.status).json(payload);
  } catch (err) {
    recordAgingApiCall(null, err.message);
    addLog({ level: 'error', event: 'aging:poll', message: `aging APIへ接続できません: ${err.message}` });
    res.status(502).json({ error: 'aging APIへの接続に失敗しました', detail: err.message });
  }
});

//NOTE: ここからRender公開用の配信設定。フロントエンドとAPIを同一オリジンで配信し、全体をAPP_BASE_PATHの推測困難なパス配下に隠す。Renderのヘルスチェックだけは認証と公開パスの外に置く必要があるため別扱いにしている
app.get('/healthz', (req, res) => {
  res.type('text/plain').send('ok');
});

// フロントエンドの静的配信。Basic認証の対象にする。
// (Codespaceでは従来通り `npm run serve:web` で別ポートから配信してもよい)
router.use(requireBasicAuth, express.static(path.join(__dirname, 'public')));

app.use(BASE_PATH || '/', router);
//NOTE: ここまでRender公開用の配信設定

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
});