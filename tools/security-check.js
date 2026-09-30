#!/usr/bin/env node
/*
 * 展示用サーバーのセキュリティ確認。
 *
 * 使い方:
 *   node tools/security-check.js <入口のURL> <ユーザー> <パスワード>
 *
 *   例(手元):   node tools/security-check.js http://127.0.0.1:5000/k7f3m2q8 booth '****'
 *   例(本番):   node tools/security-check.js https://xxx.onrender.com/k7f3m2q8 booth '****'
 *
 * URLは「Basic認証を入れて各画面が出てくる場所」をそのまま渡す
 * (末尾の / は付けても付けなくてよい)。
 *
 * ---- 本番サーバーに対して流すときの注意 ----
 *
 *  1. **先に係員画面で開発モードに入れること。**
 *     このスクリプトは写真の受け口(POST /api/entries)も叩く。開発モード中は
 *     aging APIを一切呼ばないので、ユニットを1つも使わない。
 *     入っていないと、通った受付のぶんだけ本当に課金される。
 *  2. 送信量はカレンダー月ごとの集計。このスクリプト1回で使うのは数MB程度。
 *  3. 終わったら開発モードを切る。切った時点で、ここで作られた受付は消える。
 *  4. 認証を20回以上わざと失敗させるので、実行した端末のIPは10分間だけ
 *     「失敗したときの応答が2秒遅い」状態になる。**正しい資格情報は
 *     いつでも通る**ので、ブースの動作には影響しない。
 *
 * 出力は「確認したこと / 危険 / 要確認」の3つに分かれる。
 * 危険が1件でもあれば終了コード1で終わる。
 */

const BASE = (process.argv[2] || '').replace(/\/+$/, '');
const USER = process.argv[3] || '';
const PASS = process.argv[4] || '';

if (!BASE) {
  console.error('使い方: node tools/security-check.js <入口のURL> <ユーザー> <パスワード>');
  process.exit(2);
}

const AUTH = USER ? 'Basic ' + Buffer.from(`${USER}:${PASS}`).toString('base64') : null;
const ORIGIN = new URL(BASE).origin;

const pass = [];
const fail = [];
const warn = [];

const ok = (name, note = '') => pass.push({ name, note });
const bad = (name, note = '') => fail.push({ name, note });
const hmm = (name, note = '') => warn.push({ name, note });

/**
 * 1回の要求。認証と、状態を変える要求に必要なヘッダーを既定で付ける。
 */
async function req(path, options = {}) {
  const {
    method = 'GET', headers = {}, body, auth = true,
    crossSite = false, raw = false, redirect = 'manual'
  } = options;
  const h = { ...headers };
  if (auth && AUTH) h.Authorization = AUTH;
  // ブラウザが付ける値を真似る。状態を変える要求はこれが無いと断られる
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
    h['Sec-Fetch-Site'] = crossSite ? 'cross-site' : 'same-origin';
  }
  const url = raw ? path : BASE + path;
  try {
    const res = await fetch(url, { method, headers: h, body, redirect });
    const text = await res.text();
    return { status: res.status, headers: res.headers, text, json: safeJson(text) };
  } catch (err) {
    return { status: 0, headers: new Headers(), text: String(err), json: null, error: err };
  }
}

function safeJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

/**
 * 生のhttp/httpsで1回取る。
 * Nodeのfetch(undici)は304を受け取っても控えた本文を200として見せるため、
 * 「本当に304が返っているか」はfetchでは確かめられない。
 */
function rawGet(path, headers = {}) {
  const url = new URL(BASE + path);
  const lib = url.protocol === 'https:' ? require('https') : require('http');
  const h = { ...headers };
  if (AUTH) h.Authorization = AUTH;
  return new Promise((resolve) => {
    const r = lib.get(
      { protocol: url.protocol, host: url.hostname, port: url.port || undefined, path: url.pathname + url.search, headers: h },
      (res) => {
        let d = '';
        res.on('data', (c) => { d += c; });
        res.on('end', () => resolve({ status: res.statusCode, text: d, headers: res.headers }));
      }
    );
    r.on('error', (err) => resolve({ status: 0, text: String(err), headers: {} }));
  });
}

/** 最小の正しいJPEG(1×1)。実体がJPEGであることの検査を通る */
const REAL_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a'
  + 'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA'
  + 'AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==', 'base64');

function uploadForm(bytes, { type = 'image/jpeg', name = 'shot.jpg', origin = ORIGIN } = {}) {
  const fd = new FormData();
  fd.append('file', new Blob([bytes], { type }), name);
  fd.append('origin', origin);
  return fd;
}

// ============================================================
async function run() {
  console.log(`対象: ${BASE}`);
  console.log(`認証: ${AUTH ? `${USER} / ${'*'.repeat(Math.min(PASS.length, 12))}` : '(なし)'}\n`);

  // ---- 0. 届いているか ----
  const hello = await req('/api/display');
  if (hello.status === 0) {
    console.error(`到達できません: ${hello.text}`);
    process.exit(2);
  }
  if (hello.status === 401) {
    console.error('認証に通りませんでした。ユーザー名とパスワードを確認してください。');
    process.exit(2);
  }
  if (hello.status !== 200) {
    console.error(`想定外の応答: ${hello.status} ${hello.text.slice(0, 200)}`);
    process.exit(2);
  }
  const devMode = hello.json?.dev_mode === true;
  console.log(devMode
    ? '開発モード: 入っています（aging APIは呼ばれません）\n'
    : '開発モード: 入っていません ★写真を送る確認は飛ばします\n');

  // ---- 1. 入口 ----
  {
    const r = await req('/staff.html', { auth: false });
    (AUTH ? r.status === 401 : r.status === 200)
      ? ok('認証なしでは画面が出ない', `${r.status}`)
      : bad('認証なしで画面が出てしまう', `${r.status}`);

    if (AUTH) {
      const w = await req('/api/display', { auth: false });
      (w.headers.get('www-authenticate') || '').includes('Basic')
        ? ok('401にWWW-Authenticateが付く')
        : hmm('401にWWW-Authenticateが無い', 'ブラウザが入力欄を出さない');

      const wrong = await req('/api/display', {
        auth: false, headers: { Authorization: 'Basic ' + Buffer.from(`${USER}:wrong`).toString('base64') }
      });
      wrong.status === 401 ? ok('誤ったパスワードは通らない') : bad('誤ったパスワードで通ってしまう', `${wrong.status}`);

      const noUser = await req('/api/display', {
        auth: false, headers: { Authorization: 'Basic ' + Buffer.from(`wrong:${PASS}`).toString('base64') }
      });
      noUser.status === 401 ? ok('誤ったユーザー名は通らない') : bad('誤ったユーザー名で通ってしまう', `${noUser.status}`);

      // 認証の形を崩したもの
      for (const [label, value] of [
        ['空のBasic', 'Basic '],
        ['base64でない', 'Basic @@@@'],
        ['区切りが無い', 'Basic ' + Buffer.from('nocolon').toString('base64')],
        ['Bearer', 'Bearer ' + PASS],
        ['ユーザー名に改行', 'Basic ' + Buffer.from(`${USER}\n:${PASS}`).toString('base64')],
        ['パスワードが前方一致', 'Basic ' + Buffer.from(`${USER}:${PASS.slice(0, -1)}`).toString('base64')],
        ['パスワードに余分な文字', 'Basic ' + Buffer.from(`${USER}:${PASS}x`).toString('base64')]
      ]) {
        const r2 = await req('/api/display', { auth: false, headers: { Authorization: value } });
        r2.status === 401 ? ok(`崩した認証は通らない (${label})`) : bad(`崩した認証で通ってしまう (${label})`, `${r2.status}`);
      }
    }
  }

  // ---- 2. 公開パスの外 ----
  {
    const r = await req(ORIGIN + '/', { raw: true, auth: false });
    [401, 404].includes(r.status) ? ok('公開パスの外は出ない', `/ → ${r.status}`) : hmm('公開パスの外が応答する', `/ → ${r.status}`);

    const h = await req(ORIGIN + '/healthz', { raw: true, auth: false });
    h.status === 200 && h.text.trim() === 'ok'
      ? ok('/healthz は認証の外で ok だけ返す')
      : hmm('/healthz の応答が想定と違う', `${h.status} ${h.text.slice(0, 80)}`);
    if (h.text.length > 10) hmm('/healthz が余計な情報を返している', h.text.slice(0, 120));
  }

  // ---- 3. 安全側のヘッダー ----
  {
    const r = await req('/');
    const want = {
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
      'referrer-policy': 'no-referrer'
    };
    for (const [k, v] of Object.entries(want)) {
      const got = r.headers.get(k);
      got === v ? ok(`${k}: ${v}`) : bad(`${k} が ${v} でない`, String(got));
    }
    r.headers.get('x-powered-by') ? bad('X-Powered-By が出ている', r.headers.get('x-powered-by')) : ok('X-Powered-By を出していない');

    const hsts = r.headers.get('strict-transport-security');
    if (BASE.startsWith('https://')) {
      hsts ? ok('Strict-Transport-Security', hsts) : bad('HTTPSなのにHSTSが無い');
    }
    const cors = r.headers.get('access-control-allow-origin');
    cors ? bad('CORSを許可してしまっている', cors) : ok('CORSヘッダーを出していない');
  }

  // ---- 4. 他所のページからの操作(CSRF) ----
  {
    for (const p of ['/api/display/advance', '/api/display/clear', '/api/display/updates', '/api/dev', '/api/service']) {
      const r = await req(p, { method: 'POST', crossSite: true });
      r.status === 403 ? ok(`他所からのPOSTを断る (${p})`) : bad(`他所からのPOSTを断っていない (${p})`, `${r.status}`);
    }
    const del = await req('/api/entries/00000000-0000-0000-0000-000000000000', { method: 'DELETE', crossSite: true });
    del.status === 403 ? ok('他所からのDELETEを断る') : bad('他所からのDELETEを断っていない', `${del.status}`);

    // same-site(同じ登録ドメインの別サブドメイン)も断るか
    const ss = await req('/api/display/clear', { method: 'POST', headers: { 'Sec-Fetch-Site': 'same-site' }, crossSite: true });
    ss.status === 403 ? ok('same-site からのPOSTも断る') : hmm('same-site からのPOSTが通る', `${ss.status}`);
  }

  // ---- 5. パスの抜け道 ----
  {
    const targets = [
      '/../server.js', '/../../etc/passwd', '/..%2fserver.js', '/%2e%2e/server.js',
      '/%2e%2e%2fserver.js', '/..%252fserver.js', '/.env', '/../.env', '/package.json',
      '/uploads/x.jpg', '/results/x.jpg', '/.git/config', '/node_modules/express/package.json',
      '/vendor/../../server.js', '/icons/../../.env'
    ];
    let leaked = null;
    for (const t of targets) {
      const r = await req(t);
      if (r.status === 200 && /AGING_API_KEY|BASIC_AUTH|require\(|"dependencies"/.test(r.text)) leaked = t;
    }
    leaked ? bad('サーバー側のファイルが読めてしまう', leaked) : ok('パスの抜け道でサーバー側のファイルは読めない', `${targets.length}種`);
  }

  // ---- 6. 画像の受け口 ----
  if (devMode) {
    const cases = [
      ['乱数をJPEGと偽る', Buffer.from(Array.from({ length: 2000 }, () => Math.floor(Math.random() * 256))), 'image/jpeg', 400],
      ['HTMLをJPEGと偽る', Buffer.from('<html><script>alert(1)</script></html>'), 'image/jpeg', 400],
      ['SVGをJPEGと偽る', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), 'image/jpeg', 400],
      ['空ファイル', Buffer.alloc(0), 'image/jpeg', 400],
      ['PNGヘッダ', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), 'image/jpeg', 400],
      ['12MB', Buffer.alloc(12 * 1024 * 1024, 0x41), 'image/jpeg', 400],
      ['種別がtext/html', REAL_JPEG, 'text/html', 400]
    ];
    for (const [label, bytes, type, expect] of cases) {
      const r = await req('/api/entries', { method: 'POST', body: uploadForm(bytes, { type }) });
      r.status === expect ? ok(`受け口が断る (${label})`, `${r.status}`) : bad(`受け口が断らない (${label})`, `${r.status} 期待${expect}`);
    }

    // ファイル名に細工
    for (const name of ['../../../evil.jpg', 'a\u0000.jpg', '<img src=x onerror=alert(1)>.jpg', 'A'.repeat(300) + '.jpg']) {
      const r = await req('/api/entries', { method: 'POST', body: uploadForm(REAL_JPEG, { name }) });
      [201, 400].includes(r.status)
        ? ok('細工したファイル名を受けても壊れない', `${r.status}`)
        : bad('細工したファイル名で想定外', `${r.status}`);
    }

    // originの偽装(外部APIに任意のURLを取りに行かせられないか)
    for (const origin of [
      'https://evil.example.com', 'http://169.254.169.254', 'file:///etc/passwd',
      'https://evil.example.com#@' + new URL(BASE).host, 'javascript:alert(1)',
      ORIGIN + '/../evil', 'https://' + new URL(BASE).host + '.evil.example.com'
    ]) {
      const r = await req('/api/entries', { method: 'POST', body: uploadForm(REAL_JPEG, { origin }) });
      // PUBLIC_ORIGIN が設定されていれば申告は無視されるので201でよい。
      // 設定されていない場合は400で断ること
      [201, 400].includes(r.status)
        ? ok('originの偽装で壊れない', `${origin.slice(0, 36)} → ${r.status}`)
        : bad('originの偽装で想定外', `${origin} → ${r.status}`);
    }
  } else {
    hmm('画像の受け口の確認を飛ばした', '開発モードに入れてから流し直してください');
  }

  // ---- 7. 本文と型の細工 ----
  {
    const cases = [
      ['壊れたJSON', '{"broken"', 'application/json', [400]],
      ['JSONでない型', '{"enabled":true}', 'text/plain', [400, 403, 415]],
      ['巨大な本文', JSON.stringify({ enabled: true, x: 'a'.repeat(200000) }), 'application/json', [413]],
      ['配列', '[1,2,3]', 'application/json', [400]],
      ['null', 'null', 'application/json', [400]],
      ['深い入れ子', JSON.stringify(JSON.parse('{"a":'.repeat(200) + '1' + '}'.repeat(200))), 'application/json', [400, 200]]
    ];
    for (const [label, body, type, expect] of cases) {
      const r = await req('/api/display/updates', { method: 'POST', headers: { 'Content-Type': type }, body });
      expect.includes(r.status) ? ok(`崩した本文を断る (${label})`, `${r.status}`) : bad(`崩した本文で想定外 (${label})`, `${r.status} 期待${expect}`);
    }

    // プロトタイプ汚染
    await req('/api/display/updates', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: '{"__proto__":{"polluted":"yes"},"enabled":true}'
    });
    const after = await req('/api/display');
    after.status === 200 && after.json?.polluted === undefined
      ? ok('プロトタイプ汚染が効かない')
      : bad('プロトタイプ汚染の疑い', JSON.stringify(after.json).slice(0, 120));
  }

  // ---- 8. 値の検証 ----
  {
    // JSON.stringify を通すと Infinity が null になってしまうため、本文は生で組む
    for (const [label, body, expect] of [
      ['上限0', '{"limit":0}', 400],
      ['上限が負', '{"limit":-5}', 400],
      ['上限が小数', '{"limit":1.5}', 400],
      ['上限が文字列', '{"limit":"100"}', 400],
      ['上限が桁違い', '{"limit":99999999}', 400],
      ['上限がInfinity相当', '{"limit":1e999}', 400],
      ['上限がtrue', '{"limit":true}', 400],
      ['上限が配列', '{"limit":[5]}', 400],
      ['上限が16進の文字列', '{"limit":"0x10"}', 400],
      ['上限が空白入りの文字列', '{"limit":" 100 "}', 400],
      ['上限がオブジェクト', '{"limit":{}}', 400],
      ['closedが文字列', '{"closed":"true"}', 400],
      ['closedが数', '{"closed":1}', 400],
      ['空', '{}', 400]
    ]) {
      const r = await req('/api/service', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body
      });
      r.status === expect ? ok(`受付終了の値を検証する (${label})`, `${r.status}`) : bad(`受付終了の値を検証していない (${label})`, `${r.status} 本文${body}`);
    }

    for (const [label, body, expect] of [
      ['絵柄が未知', { theme: 'evil' }, 400],
      ['絵柄がオブジェクト', { theme: { a: 1 } }, 400],
      ['見本が0人', { enabled: true, placeholders: 0 }, 400],
      ['見本が上限超', { enabled: true, placeholders: 99 }, 400],
      ['見本がtrue', { enabled: true, placeholders: true }, 400],
      ['見本が文字列', { enabled: true, placeholders: '3' }, 400]
    ]) {
      const path = body.theme !== undefined ? '/api/display/theme' : '/api/dev';
      const r = await req(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      r.status === expect ? ok(`値を検証する (${label})`, `${r.status}`) : bad(`値を検証していない (${label})`, `${r.status}`);
    }

    // idの細工
    for (const id of ['__proto__', 'constructor', '../../etc/passwd', '%2e%2e%2f', 'a'.repeat(500)]) {
      const r = await req('/api/entries/' + encodeURIComponent(id));
      [400, 404].includes(r.status) ? ok('受付idの細工を断る', `${r.status}`) : bad('受付idの細工で想定外', `${id} → ${r.status}`);
      const r2 = await req('/api/logs/' + encodeURIComponent(id));
      [400, 404].includes(r2.status) ? ok('履歴idの細工を断る', `${r2.status}`) : bad('履歴idの細工で想定外', `${id} → ${r2.status}`);
    }

    // 画像の添字
    for (const idx of ['-1', '1e9', '__proto__', 'constructor', '1.5']) {
      const r = await req(`/api/entries/00000000-0000-0000-0000-000000000000/images/${encodeURIComponent(idx)}`);
      [400, 404].includes(r.status) ? ok('画像の添字の細工を断る', `${r.status}`) : bad('画像の添字の細工で想定外', `${idx} → ${r.status}`);
    }
  }

  // ---- 9. 元画像の受け口(ここだけ認証の外) ----
  {
    const r = await req('/files/00000000-0000-0000-0000-000000000000', { auth: false });
    r.status === 404 ? ok('存在しないfile_idは404(認証の外)') : hmm('元画像の受け口の応答が想定と違う', `${r.status}`);

    for (const id of ['../server.js', '..%2fserver.js', 'x/../../.env']) {
      const r2 = await req('/files/' + id, { auth: false });
      r2.status === 200 && /require\(|AGING_API_KEY/.test(r2.text)
        ? bad('元画像の受け口からサーバー側のファイルが読める', id)
        : ok('元画像の受け口は表引きだけで抜けられない', `${id} → ${r2.status}`);
    }
  }

  // ---- 10. ヘッダーの細工 ----
  {
    // 接続元の偽装(認証の失敗回数を他人になすりつけられないか)
    const r = await req('/api/display', {
      auth: false,
      headers: { Authorization: 'Basic ' + Buffer.from('x:y').toString('base64'), 'X-Forwarded-For': '1.2.3.4, 5.6.7.8' }
    });
    r.status === 401 ? ok('接続元を偽っても通らない') : bad('接続元の偽装で通る', `${r.status}`);

    // 応答ヘッダーへの注入
    const inj = await req('/api/entries/' + encodeURIComponent('a\r\nX-Injected: yes'));
    inj.headers.get('x-injected') ? bad('応答ヘッダーに注入できる') : ok('応答ヘッダーに注入できない');

    // 別ホストを名乗る
    const host = await req('/api/display', { headers: { Host: 'evil.example.com' } });
    [200, 400, 404].includes(host.status) ? ok('Hostを偽っても壊れない', `${host.status}`) : hmm('Hostの偽装で想定外', `${host.status}`);
  }

  // ---- 11. 送信量 ----
  {
    const logs = await req('/api/logs?limit=200');
    const size = Buffer.byteLength(logs.text);
    const perHour = size * 1200 / 1048576;
    size < 300 * 1024
      ? ok('処理履歴1回の大きさ', `${(size / 1024).toFixed(0)}KB → ${perHour.toFixed(0)}MB/時`)
      : bad('処理履歴1回が大きすぎる', `${(size / 1024).toFixed(0)}KB → ${perHour.toFixed(0)}MB/時`);
    logs.json?.logs?.some((l) => l.detail)
      ? bad('一覧に詳細が載っている', '通信量が跳ね上がる')
      : ok('一覧に詳細を載せていない');

    const cc = (await req('/api/entries')).headers.get('cache-control');
    (cc || '').includes('no-cache') ? ok('変化がなければ304で済む', cc) : hmm('Cache-Controlが付いていない', String(cc));

    // 受付の状態は裏で変わるため、内容が動かない /api/display で確かめる。
    // ここだけ生のhttpを使う。Nodeのfetch(undici)は304を受け取っても
    // 控えた本文を200として見せるため、fetchでは304かどうかを判定できない
    const first = await req('/api/display');
    const etag = first.headers.get('etag');
    if (etag) {
      const second = await rawGet('/api/display', { 'If-None-Match': etag });
      second.status === 304
        ? ok('同じ内容なら304が返る（本文を送らない）', `${first.text.length}bytes → 0bytes`)
        : hmm('304にならない', `${second.status}`);
    } else {
      hmm('ETagが付いていない');
    }
  }

  // ---- 12. 認証の総当たり ----
  if (AUTH) {
    const started = Date.now();
    for (let i = 0; i < 25; i++) {
      await req('/api/display', {
        auth: false, headers: { Authorization: 'Basic ' + Buffer.from(`${USER}:wrong${i}`).toString('base64') }
      });
    }
    const spent = Date.now() - started;
    spent > 4000
      ? ok('失敗が続くと応答が遅くなる', `25回で${(spent / 1000).toFixed(1)}秒`)
      : hmm('失敗が続いても遅くならない', `25回で${(spent / 1000).toFixed(1)}秒`);

    const t0 = Date.now();
    const good = await req('/api/display');
    const goodMs = Date.now() - t0;
    good.status === 200 && goodMs < 1500
      ? ok('遅延中でも正しい資格情報はすぐ通る', `${goodMs}ms`)
      : bad('正しい資格情報が通らない/遅い', `${good.status} ${goodMs}ms`);
  }

  // ---- 13. 同時接続 ----
  {
    const t0 = Date.now();
    const rs = await Promise.all(Array.from({ length: 60 }, () => req('/api/display')));
    const bad200 = rs.filter((r) => r.status !== 200).length;
    bad200 === 0
      ? ok('同時60本をさばける', `${Date.now() - t0}ms`)
      : bad('同時接続で失敗が出る', `${bad200}/60`);

    const still = await req('/api/display');
    still.status === 200 ? ok('負荷のあとも応答する') : bad('負荷のあと応答しない', `${still.status}`);
  }

  // ---- 14. 情報の出しすぎ ----
  {
    const r = await req('/api/entries/00000000-0000-0000-0000-000000000000');
    /at \/|node_modules|\.js:\d+/.test(r.text)
      ? bad('エラー応答にサーバー内部の情報が出ている', r.text.slice(0, 160))
      : ok('エラー応答に内部の情報を出していない');

    const st = await req('/api/status');
    const body = st.text;
    /AGING_API_KEY|BASIC_AUTH|Bearer [A-Za-z0-9]/.test(body)
      ? bad('状態の応答に秘密が混ざっている')
      : ok('状態の応答に秘密が無い');

    const logs = await req('/api/logs?limit=200');
    /Bearer (?!\*\*\*)[A-Za-z0-9_\-]{8}/.test(logs.text)
      ? bad('処理履歴にAPIキーが出ている')
      : ok('処理履歴でAPIキーが伏せられている');
  }

  // ---- 15. 画面の中身 ----
  {
    const page = await req('/capture.html');
    /AGING_API_KEY|Bearer [A-Za-z0-9_\-]{10}/.test(page.text)
      ? bad('画面のHTMLに秘密が埋まっている')
      : ok('画面のHTMLに秘密が無い');
    /innerHTML|document\.write|eval\(/.test(page.text)
      ? hmm('画面に危険な組み立てが残っている')
      : ok('画面に危険な組み立てが無い');
    // 説明文の中のURLではなく、実際に読み込む指定(src= / href=)だけを見る
    const externals = [...page.text.matchAll(/(?:src|href)\s*=\s*["'](https?:\/\/[^"']+)["']/gi)]
      .map((m) => new URL(m[1]).host)
      .filter((host) => host !== new URL(BASE).host && host !== 'www.w3.org');
    externals.length
      ? hmm('画面が外部から読み込んでいる', `${[...new Set(externals)].join(', ')} — 会場のネットワークに依存する`)
      : ok('画面は外部から何も読み込まない');
  }

  // ============================================================
  console.log(`\n${'='.repeat(60)}`);
  console.log(`確認できたこと: ${pass.length}件`);
  for (const p of pass) console.log(`  OK   ${p.name}${p.note ? `  (${p.note})` : ''}`);

  if (warn.length) {
    console.log(`\n要確認: ${warn.length}件`);
    for (const w of warn) console.log(`  ?    ${w.name}${w.note ? `  (${w.note})` : ''}`);
  }

  if (fail.length) {
    console.log(`\n危険: ${fail.length}件`);
    for (const f of fail) console.log(`  NG   ${f.name}${f.note ? `  (${f.note})` : ''}`);
  } else {
    console.log('\n危険: なし');
  }
  console.log('='.repeat(60));

  if (devMode) {
    console.log('\n開発モード中のため、aging APIのユニットは使っていません。');
    console.log('確認が済んだら係員画面で開発モードを切ってください（ここで作られた受付も消えます）。');
  }
  process.exit(fail.length ? 1 : 0);
}

run().catch((err) => {
  console.error('確認そのものが失敗しました:', err);
  process.exit(2);
});
