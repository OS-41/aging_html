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
 *   /view.html      閲覧ブース用
 *
 * エンドポイント(2ブース構成):
 *   POST   /api/entries                       写真を受け取り受付番号を返す。aging処理は裏で進む
 *   GET    /api/entries                       受付一覧(撮影時刻の古い順)
 *   GET    /api/entries/next                  未閲覧かつ生成済みで最も古いもの＝次の人
 *   GET    /api/entries/:id                   受付1件の詳細
 *   POST   /api/entries/:id/viewed            閲覧済みにする
 *   DELETE /api/entries/:id                   受付を取り消す(係員用)
 *   GET    /api/entries/:id/images/:index     取り込み済みの結果画像
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

  const isCodespaces = url.protocol === 'https:' && /\.app\.github\.dev$/.test(url.hostname);
  const isLocal = ['localhost', '127.0.0.1'].includes(url.hostname);
  return isCodespaces || isLocal ? url.origin : null;
}

// ルート定義はrouterにまとめ、公開パス(BASE_PATH)配下へまとめてマウントする
const router = express.Router();

app.use(express.json());

// CORS設定: どのオリジン(index.htmlを配信しているCodespaceのポート)からでも
// アクセスできるようにする。Codespaceごとにポート転送URLのサブドメインが
// 変わる（例: iOSのCodespacesアプリから開いた場合など）ため、オリジンを
// 固定せず "*" を許可する。認証情報(Cookie)は使わないため credentials は
// 有効にしない。
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type']
}));

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
      console.log(`ファイル削除に失敗しました(${fileId}): ${err.message}`);
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
const ENTRY_TTL_MS = 60 * 60 * 1000; // 60分
const RESULT_IMAGE_MAX_BYTES = 15 * 1024 * 1024;

function deleteEntry(entryId) {
  const entry = entryStore.get(entryId);
  if (!entry) return;
  entryStore.delete(entryId);

  for (const output of entry.outputs) {
    fs.unlink(output.filePath, (err) => {
      if (err && err.code !== 'ENOENT') {
        console.log(`結果画像の削除に失敗しました(${entryId}): ${err.message}`);
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
 * 閲覧ブースに渡す形へ整形する。結果画像はこのサーバーのURLで返すため、
 * aging API側のURLが失効していても表示できる。
 */
function toPublicEntry(entry) {
  return {
    id: entry.id,
    sequence: entry.sequence,
    status: entry.status,
    error: entry.error,
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

/**
 * aging APIにタスクを開始させ、task_idを返す。
 * @param {string} srcFileUrl - 外部から取得できる元画像のURL
 */
async function startAgingTask(srcFileUrl) {
  const res = await fetch(AGING_API_BASE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${AGING_API_KEY}`
    },
    body: JSON.stringify({ request_id: 0, src_file_url: srcFileUrl })
  });

  const payload = await res.json().catch(() => ({}));
  const taskId = payload?.data?.task_id;
  if (!taskId) {
    throw new Error(`タスクを開始できませんでした (${res.status}): ${JSON.stringify(payload)}`);
  }
  return taskId;
}

/**
 * タスクの完了を待ち、results を返す。
 */
async function pollAgingTask(taskId, { intervalMs = 3000, maxAttempts = 100 } = {}) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const res = await fetch(`${AGING_API_BASE_URL}/${taskId}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${AGING_API_KEY}` }
    });
    const payload = await res.json().catch(() => ({}));
    const taskStatus = payload?.data?.task_status;

    if (taskStatus === 'success') {
      return payload.data.results;
    }
    if (taskStatus === 'error') {
      throw new Error(payload?.data?.error_message || payload?.data?.error || '生成に失敗しました');
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
async function downloadResultImage(entryId, index, output) {
  const res = await fetch(output.url);
  if (!res.ok) {
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
    entry.taskId = await startAgingTask(srcFileUrl);

    const results = await pollAgingTask(entry.taskId);

    // 元画像はaging APIが取得し終えているので、ここで削除してよい
    deleteStoredFile(entry.sourceFileId);
    entry.sourceFileId = null;

    const outputs = results?.output || [];
    if (outputs.length === 0) {
      throw new Error('生成結果が空でした');
    }

    entry.outputs = await Promise.all(
      outputs.map((output, index) => downloadResultImage(entry.id, index, output))
    );
    entry.age = results.age ?? null;
    entry.ageIdx = Number.isInteger(results.age_idx) ? results.age_idx : null;
    entry.ageMin = results.age_min ?? null;
    entry.ageMax = results.age_max ?? null;
    entry.status = 'ready';
    console.log(`[entry ${entry.sequence}] 生成完了 (${entry.outputs.length}枚)`);
  } catch (err) {
    entry.status = 'error';
    entry.error = err.message;
    if (entry.sourceFileId) {
      deleteStoredFile(entry.sourceFileId);
      entry.sourceFileId = null;
    }
    console.log(`[entry ${entry.sequence}] 生成失敗: ${err.message}`);
  }
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
 * GET /api/entries/next
 * まだ見ていない中で最も古い、生成済みの受付を返す。
 * 来場者は撮影した順に到着するため、これが「次の人」になる。
 */
router.get('/api/entries/next', requireBasicAuth, (req, res) => {
  const next = entriesInOrder().find((entry) => entry.status === 'ready' && !entry.viewedAtMs);
  if (!next) {
    const processing = entriesInOrder().filter((entry) => entry.status === 'processing').length;
    return res.status(404).json({ error: '表示できる受付がありません', processing });
  }
  res.json(toPublicEntry(next));
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
 * POST /api/entries/:entry_id/viewed
 * 閲覧済みにして待ち行列から外す。
 */
router.post('/api/entries/:entry_id/viewed', requireBasicAuth, (req, res) => {
  const entry = entryStore.get(req.params.entry_id);
  if (!entry) {
    return res.status(404).json({ error: '指定された受付は存在しません' });
  }
  entry.viewedAtMs = Date.now();
  res.status(204).send();
});

/**
 * DELETE /api/entries/:entry_id
 * 係員が個別に取り消す用。結果画像もまとめて削除する。
 */
router.delete('/api/entries/:entry_id', requireBasicAuth, (req, res) => {
  if (!entryStore.has(req.params.entry_id)) {
    return res.status(404).json({ error: '指定された受付は存在しません' });
  }
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
  console.log("posted.");
  upload.single('file')(req, res, (err) => {
    console.log("upload");
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

    if (fileStore.size >= MAX_STORED_FILES) {
      fs.unlinkSync(req.file.path);
      return res.status(507).json({ error: '保存できるファイル数の上限に達しています。しばらく待ってから再試行してください' });
    }

    console.log("file confirmed.");
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
    console.log("AGING_API_KEY is not available. process discontinued");
    return res.status(500).json({ error: 'サーバーにAGING_API_KEYが設定されていません(.envを確認してください)' });
  }
  console.log("AGING_API_KEY is available.");
  const fileInfo = fileStore.get(req.params.file_id);
  if (!fileInfo) {
    console.log("Specified file_id is not available. process discontinued");
    return res.status(404).json({ error: '指定されたfile_idは存在しません' });
  }
  console.log("file_id is available.\ntry api fetch");

  const origin = resolvePublicOrigin(req.body?.origin);
  if (!origin) {
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
    console.log("fetch completed.");
    const payload = await apiRes.json().catch(() => ({}));
    console.log("process finished.\nreturn data");
    res.status(apiRes.status).json(payload);
  } catch (err) {
    console.log("Error occurred! Detail:\n"+err);
    res.status(502).json({ error: 'aging APIへの接続に失敗しました', detail: err.message });
  }
});

/**
 * GET /api/aging/:taskId
 * aging APIのタスク状況をポーリングするプロキシ。
 */
router.get('/api/aging/:taskId', requireBasicAuth, async (req, res) => {
  if (!AGING_API_KEY) {
    return res.status(500).json({ error: 'サーバーにAGING_API_KEYが設定されていません(.envを確認してください)' });
  }
  console.log("AGING_API_KEY is available.\ntry api fetch");
  try {
    const apiRes = await fetch(`${AGING_API_BASE_URL}/${req.params.taskId}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${AGING_API_KEY}` }
    });
    console.log("fetch completed.");
    const payload = await apiRes.json().catch(() => ({}));
    console.log("process finished.\nreturn data");
    res.status(apiRes.status).json(payload);
  } catch (err) {
    console.log("Error occurred! Detail:\n"+err);
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
  console.log(`サーバーが起動しました: http://localhost:${PORT}${BASE_PATH || ''}/`);
});