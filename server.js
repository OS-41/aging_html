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
 * エンドポイント:
 *   POST /files   画像をアップロードし、file_idを返す
 *   GET  /files/:file_id   file_idに対応する画像を返す
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
const { randomUUID } = require('crypto');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 5000;

const AGING_API_BASE_URL = 'https://yce-api-01.makeupar.com/s2s/v2.0/task/aging';
const AGING_API_KEY = process.env.AGING_API_KEY;

// このサーバーの公開URL。設定されていればクライアント申告のoriginより優先する。
const PUBLIC_ORIGIN = process.env.PUBLIC_ORIGIN;

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

/**
 * POST /files
 * multipart/form-dataでフィールド名 "file" として画像を送信する
 * レスポンス例: { "file_id": "3fa85f64-5717-4562-b3fc-2c963f66afa6" }
 */
app.get('/',(req,res) => {
  console.log("test");
  res.send({msg:'Test!'});
})
app.post('/files', (req, res) => {
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
app.get('/files/:file_id', (req, res) => {
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
app.delete('/files/:file_id', (req, res) => {
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
app.post('/api/aging/start/:file_id', async (req, res) => {
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

  const srcFileUrl = `${origin}/files/${req.params.file_id}`;

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
app.get('/api/aging/:taskId', async (req, res) => {
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

// "0.0.0.0"を明示することで、IPv6優先バインドとの相性問題により
// GitHub Codespacesのポート転送プロキシ(IPv4経由)から到達できず
// Bad Gatewayになるケースを避ける。
app.listen(PORT, '0.0.0.0', () => {
  console.log(`サーバーが起動しました: http://localhost:${PORT}`);
});