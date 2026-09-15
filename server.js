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
 * エンドポイント:
 *   POST /files   画像をアップロードし、file_idを返す
 *   GET  /files/:file_id   file_idに対応する画像を返す
 *   DELETE /files/:file_id file_idに対応する画像を削除する
 */

const express = require('express');
const multer = require('multer');
const cors = require('cors');
const { randomUUID } = require('crypto');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 5000;

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
    fileSize: 10 * 1024 * 1024 // 10MB
  },
  fileFilter: (req, file, cb) => {
    // jpg/jpeg以外は拒否
    const allowed = ['image/jpeg'];
    if (!allowed.includes(file.mimetype)) {
      return cb(new Error('jpg/jpeg形式の画像のみアップロード可能です'));
    }
    cb(null, true);
  }
});

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
  // res.send({msg:"posted."});
  upload.single('file')(req, res, (err) => {
    console.log("upload");
    console.log("req listened:"+req);
    if (err) {
      res.send({msg:"somethinig went wrong!\nerror:"+err.message});
      return res.status(400).json({ error: err.message });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'ファイルが送信されていません' });
    }
    console.log("file confirmed.");
    const fileId = req.generatedFileId;

    fileStore.set(fileId, {
      filePath: req.file.path,
      originalName: req.file.originalname,
      mimeType: req.file.mimetype,
      size: req.file.size,
      uploadedAt: new Date().toISOString()
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

app.listen(PORT, () => {
  console.log(`サーバーが起動しました: http://localhost:${PORT}`);
});