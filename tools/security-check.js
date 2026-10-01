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
 * ---- 出ていくもの ----
 *
 * 進みながら1件ずつ結果を出す。画面に直接出しているときは下端に
 * 進み具合の棒が付く(ファイルへ流したときは棒を出さず行だけ残す)。
 * 最後に「確認できた / 要確認 / 危険」のまとめを出す。
 *
 *   終了コード 0 … 危険なし
 *              1 … 危険あり(直してから本番に出すこと)
 *              2 … 確認を始められなかった(届かない・認証に通らない)
 *
 * 色を消したいときは NO_COLOR=1 を付ける。
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

/*
 * ---- 進み具合の見せ方 ----
 *
 * 全部で数分かかり、途中には**わざと12秒待つ確認(総当たり)**や、
 * 黙った接続を80本開く確認があるため、何も出さないと固まったように見える。
 * いま何を試しているかを出しながら進める。
 *
 * 画面に直接出しているとき(TTY)だけ、下端に棒を1本出して上書きしていく。
 * ファイルへ流したときは上書きが化けるので、棒は出さず行だけを残す。
 */
const TTY = process.stdout.isTTY === true;
const COLOR = TTY && !process.env.NO_COLOR;
const c = (code, text) => (COLOR ? `\x1b[${code}m${text}\x1b[0m` : text);
const green = (t) => c('32', t);
const red = (t) => c('31;1', t);
const yellow = (t) => c('33', t);
const dim = (t) => c('2', t);
const bold = (t) => c('1', t);

const SECTIONS = [
  '届いているか',
  '入口(Basic認証)',
  '公開パスの外',
  '安全側のヘッダー',
  '他所のページからの操作(CSRF)',
  'パスの抜け道',
  '画像の受け口',
  '本文と型の細工',
  '値の検証',
  '元画像の受け口',
  'ヘッダーの細工',
  '送信量',
  '認証の総当たり',
  '同時接続',
  '情報の出しすぎ',
  '画面の中身',
  '中身を知らない相手の手口',
  '後片付け'
];

const startedAtMs = Date.now();
let sectionIndex = 0;
let sectionTitle = '';
let barShown = false;
// 最初の区分に入るまでは棒を出さない(冒頭の案内の下でちらつかせないため)
let barActive = false;

function elapsed() {
  const sec = Math.floor((Date.now() - startedAtMs) / 1000);
  return `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;
}

/** 下端の棒を消す(行を出す前に必ず呼ぶ) */
function clearBar() {
  if (!TTY || !barShown) return;
  process.stdout.write('\r\x1b[2K');
  barShown = false;
}

/** 下端に進み具合の棒を出す */
function drawBar() {
  if (!TTY || !barActive) return;
  const total = SECTIONS.length;
  const done = sectionIndex;
  const width = 24;
  const filled = Math.round((done / total) * width);
  const bar = '█'.repeat(filled) + dim('─'.repeat(width - filled));
  const counts = `${green(`OK ${pass.length}`)} ${fail.length ? red(`NG ${fail.length}`) : dim('NG 0')} ${warn.length ? yellow(`? ${warn.length}`) : dim('? 0')}`;
  const line = `  [${bar}] ${String(done).padStart(2)}/${total}  ${counts}  ${dim(elapsed())}  ${dim(sectionTitle)}`;
  process.stdout.write('\r\x1b[2K' + line.slice(0, (process.stdout.columns || 120) + 40));
  barShown = true;
}

/** 棒を避けながら1行出す */
function line(text = '') {
  clearBar();
  process.stdout.write(text + '\n');
  drawBar();
}

/** 見出し。ここで棒も1つ進む */
function section(n, title) {
  line('');
  line(bold(`[${String(n + 1).padStart(2)}/${SECTIONS.length}] ${title}`));
  // 見出しを出してから棒を進める(いま何を試しているかが棒にも出る)
  barActive = true;
  sectionIndex = n;
  sectionTitle = title;
  drawBar();
}

/** 時間のかかる確認の前に、何を待っているかを出す */
function doing(text) {
  line(dim(`       … ${text}`));
}

const ok = (name, note = '') => {
  pass.push({ name, note });
  line(`  ${green('OK')}   ${name}${note ? dim(`  (${note})`) : ''}`);
};
const bad = (name, note = '') => {
  fail.push({ name, note });
  line(`  ${red('NG')}   ${red(name)}${note ? dim(`  (${note})`) : ''}`);
};
const hmm = (name, note = '') => {
  warn.push({ name, note });
  line(`  ${yellow('?')}    ${name}${note ? dim(`  (${note})`) : ''}`);
};

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
    if (CDN_THROTTLED.includes(res.status)) countThrottle();
    return { status: res.status, headers: res.headers, text, json: safeJson(text) };
  } catch (err) {
    return { status: 0, headers: new Headers(), text: String(err), json: null, error: err };
  }
}

/** 絞られた回数を数え、続けても当てにならない段になったら止める */
function countThrottle() {
  throttledCount += 1;
  if (throttledCount < THROTTLE_ABORT_AT || abortedByThrottle) return;
  abortedByThrottle = true;
  clearBar();
  console.error(`\n${yellow('前段(CDN)に絞られたため、途中で止めました')}`);
  console.error(`  429/503 が ${throttledCount} 件。ここから先は断られたのか通ったのかが分からず、`);
  console.error('  結果が当てになりません（確かめられていないものが「危険」として並んでしまいます）。');
  console.error('');
  console.error('  データセンターのIP(GitHub Codespacesなど)から流すと起きやすくなります。');
  console.error('  10〜15分ほど置いてから流し直すか、手元の回線から流し直してください。');
  console.error(`\n  ここまでの結果: 確認できた ${pass.length}件 / 要確認 ${warn.length}件 / 危険 ${fail.length}件`);
  if (fail.length) {
    console.error(`\n  ${red('止まるまでに出た「危険」')}（絞られた影響かもしれないので、流し直して確かめること）`);
    for (const f of fail) console.error(`    NG   ${f.name}${f.note ? `  (${f.note})` : ''}`);
  }
  process.exit(2);
}

function safeJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

/*
 * ---- 前段(CDN)が返す403の扱い ----
 *
 * RenderのURLはCDN(Cloudflare)の後ろにある。CDNは怪しい形の要求を、
 * こちらに届く前に403で弾くことがある(__proto__ を含むパス、経路を抜ける形の
 * ファイル名など)。どこまで弾くかはCDN側の設定しだいで、日によっても変わる。
 *
 * そのため403は、その確認が「何を見ようとしていたか」で意味が変わる。
 *
 *  - 断ってほしかったもの → 断られているので OK(誰が断ったかだけ書き添える)
 *  - 通ってほしかったもの → こちらの作りを確かめられていないので 要確認
 *
 * 403を一律で失敗にすると、直しようのないものが毎回「危険」に並んで、
 * 本当に見るべきものが埋もれる。
 */
const CDN_BLOCKED = 403;
/*
 * 前段が「絞った」ときの応答。拒否(403)とは意味が違う。
 *
 * 403 は「その要求は通さない」という判断なので、断ってほしかった確認では
 * 目的が達せられている。429/503 は「今は相手をしない」なので、**何も
 * 確かめられていない**。データセンターのIP(Codespacesなど)から流すと、
 * 同時60本や黙った接続80本のあとにこれが返ることがある。
 */
const CDN_THROTTLED = [429, 503];
let throttledCount = 0;

/*
 * 前段に絞られ始めたら、その先の結果は当てにならない。
 *
 * 絞られた応答(429/503)は、断られたのでも通ったのでもなく「相手にされて
 * いない」状態。そのまま続けると、確かめられていないものが「危険」として
 * 大量に並び、本当に見るべきものが埋もれる。数件を超えたらそこで止めて、
 * 時間を置いて流し直してもらう。
 */
const THROTTLE_ABORT_AT = 5;
let abortedByThrottle = false;

function noteThrottled(name, status, note) {
  throttledCount += 1;
  return hmm(`${name}（確かめられず）`, `前段(CDN)に絞られた(${status})。しばらく置いて流し直す${note ? ` / ${note}` : ''}`);
}

/** 断ってほしかった確認。403は前段が断った印として通す。 */
function expectReject(name, status, allowed, note = '') {
  if (CDN_THROTTLED.includes(status)) return noteThrottled(name, status, note);
  if (status === CDN_BLOCKED) return ok(name, `前段(CDN)が拒否${note ? ` / ${note}` : ''}`);
  if (allowed.includes(status)) return ok(name, `${status}${note ? ` / ${note}` : ''}`);
  return bad(name, `${status} 期待${allowed.join('・')}${note ? ` / ${note}` : ''}`);
}

/** 通ってほしかった確認。403だと確かめられていないので要確認にする。 */
function expectPass(name, status, allowed, note = '') {
  if (CDN_THROTTLED.includes(status)) return noteThrottled(name, status, note);
  if (status === CDN_BLOCKED) {
    return hmm(`${name}（確かめられず）`, `前段(CDN)が弾いたため、こちらの作りは未確認${note ? ` / ${note}` : ''}`);
  }
  if (allowed.includes(status)) return ok(name, `${note || status}`);
  return bad(name, `${status} 期待${allowed.join('・')}${note ? ` / ${note}` : ''}`);
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

/*
 * ---- 送った写真の後片付け ----
 *
 * この確認は写真の受け口も叩くので、通ったぶんは**本物の受付として
 * 待ち行列に並ぶ**。開発モード中はaging APIを通さず撮った写真をそのまま
 * 結果にする作りなので、片付けないまま係員が「結果画面に移行」を押すと、
 * **ここで送った1×1の画像が閲覧ブースに「未来のあなた」として出てしまう。**
 *
 * 開発モードを切れば消えるが、切り忘れに頼る作りにはしない。
 * 受け取った受付IDをその場で消す。
 */
const createdEntries = [];
let droppedCount = 0;
let lastSequence = 0;

async function dropEntry(json) {
  const id = json?.entry_id;
  if (!id) return;
  if (json.sequence) lastSequence = Math.max(lastSequence, json.sequence);
  const r = await req(`/api/entries/${id}`, { method: 'DELETE' });
  if (r.status === 204) { droppedCount += 1; return; }
  // 消せなかったものは最後にまとめて知らせる(放置すると閲覧ブースに出る)
  createdEntries.push({ id, sequence: json.sequence, status: r.status });
}

function uploadForm(bytes, { type = 'image/jpeg', name = 'shot.jpg', origin = ORIGIN } = {}) {
  const fd = new FormData();
  fd.append('file', new Blob([bytes], { type }), name);
  fd.append('origin', origin);
  return fd;
}

// ============================================================
async function run() {
  line(bold('展示用サーバーのセキュリティ確認'));
  line(`  対象 : ${BASE}`);
  line(`  認証 : ${AUTH ? `${USER} / ${'*'.repeat(Math.min(PASS.length, 12))}` : dim('(なし)')}`);
  line(dim(`  ${SECTIONS.length}項目の区分を順に試します。総当たりの確認で12秒ほど待つところがあります。`));

  // ---- 0. 届いているか ----
  section(0, '届いているか');
  const hello = await req('/api/display');
  const stop = (message) => {
    clearBar();
    console.error(`\n${red('確認を始められません')}  ${message}`);
    process.exit(2);
  };
  if (hello.status === 0) stop(`到達できません: ${hello.text}`);
  if (hello.status === 401) stop('認証に通りませんでした。ユーザー名とパスワードを確認してください。');
  if (hello.status !== 200) stop(`想定外の応答: ${hello.status} ${hello.text.slice(0, 200)}`);
  ok('サーバーに届いた', `${hello.status}`);
  const devMode = hello.json?.dev_mode === true;
  line(devMode
    ? `  ${green('開発モード: 入っています')}${dim('（aging APIは呼ばれません）')}`
    : `  ${yellow('開発モード: 入っていません')} → 写真を送る確認は飛ばします`);

  // ---- 1. 入口 ----
  section(1, '入口(Basic認証)');
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
  section(2, '公開パスの外');
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
  section(3, '安全側のヘッダー');
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
  section(4, '他所のページからの操作(CSRF)');
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
  section(5, 'パスの抜け道');
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
  section(6, '画像の受け口');
  if (devMode) {
    doing('偽物の画像7種と、細工したファイル名・originを送ります');
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
      expectReject(`受け口が断る (${label})`, r.status, [expect]);
      await dropEntry(r.json);
    }

    /*
     * ファイル名に細工。
     * 403 は、前段のCDNが「経路を抜けようとする形」「スクリプトに見える形」を
     * こちらに届く前に弾いた印。受け取っていない点では同じなので通す。
     */
    const FILENAMES = {
      '../../../evil.jpg': '経路を抜ける形',
      'a\u0000.jpg': 'NULバイト入り',
      '<img src=x onerror=alert(1)>.jpg': 'スクリプトに見える形',
      ['A'.repeat(300) + '.jpg']: '300文字'
    };
    for (const [name, label] of Object.entries(FILENAMES)) {
      const r = await req('/api/entries', { method: 'POST', body: uploadForm(REAL_JPEG, { name }) });
      expectReject(`細工したファイル名を受けても壊れない (${label})`, r.status, [201, 400]);
      await dropEntry(r.json);
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
      expectPass('originの偽装で壊れない', r.status, [201, 400], `${origin.slice(0, 36)} → ${r.status}`);
      await dropEntry(r.json);
    }
  } else {
    hmm('画像の受け口の確認を飛ばした', '開発モードに入れてから流し直してください');
  }

  // ---- 7. 本文と型の細工 ----
  section(7, '本文と型の細工');
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
      expectReject(`崩した本文を断る (${label})`, r.status, expect);
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
  section(8, '値の検証');
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

    /*
     * idの細工。
     *
     * 403 は、前段のCDN(Renderの前にはCloudflareが入る)が __proto__ のような
     * 見た目を先に弾いた印。こちらに届く前に断られているので、断っている点では
     * 400/404 と同じ。手元(前段なし)では404、本番では403になる。
     */
    const REJECTED = [400, 403, 404];
    const byWho = (status) => (status === 403 ? '前段(CDN)が拒否' : String(status));
    for (const id of ['__proto__', 'constructor', '../../etc/passwd', '%2e%2e%2f', 'a'.repeat(500)]) {
      const r = await req('/api/entries/' + encodeURIComponent(id));
      REJECTED.includes(r.status) ? ok('受付idの細工を断る', byWho(r.status)) : bad('受付idの細工で想定外', `${id} → ${r.status}`);
      const r2 = await req('/api/logs/' + encodeURIComponent(id));
      REJECTED.includes(r2.status) ? ok('履歴idの細工を断る', byWho(r2.status)) : bad('履歴idの細工で想定外', `${id} → ${r2.status}`);
    }

    // 画像の添字
    for (const idx of ['-1', '1e9', '__proto__', 'constructor', '1.5']) {
      const r = await req(`/api/entries/00000000-0000-0000-0000-000000000000/images/${encodeURIComponent(idx)}`);
      REJECTED.includes(r.status) ? ok('画像の添字の細工を断る', byWho(r.status)) : bad('画像の添字の細工で想定外', `${idx} → ${r.status}`);
    }
  }

  // ---- 9. 元画像の受け口(ここだけ認証の外) ----
  section(9, '元画像の受け口');
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
  section(10, 'ヘッダーの細工');
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
  section(11, '送信量');
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
  section(12, '認証の総当たり');
  if (AUTH) {
    // このサーバーから見た接続元。前段(CDN)が入ると皆同じ値になったり
    // 要求ごとに散ったりする。散ると接続元ごとの数えかたが効かない
    const before = await req('/api/status');
    const seenIp = before.json?.server?.client_ip;
    const xff = before.json?.server?.forwarded_for;
    if (seenIp !== undefined) {
      line(dim(`       サーバーから見た接続元: ${seenIp || '(不明)'}${xff ? `  X-Forwarded-For: ${xff}` : ''}`));
    }

    /*
     * わざと間違え続けて、遅延が掛かり始めるまで何回かかるかを見る。
     * 掛かった時点で止めるので、効いていれば短く済む
     * (効いていない場合だけ上限まで叩いて、それから報告する)。
     */
    const MAX_TRIES = 50;
    doing(`わざと間違え続けます。遅延が掛かった時点で止めます(最大${MAX_TRIES}回)`);
    let slowAt = 0;
    let tries = 0;
    for (let i = 0; i < MAX_TRIES; i++) {
      const t = Date.now();
      await req('/api/display', {
        auth: false, headers: { Authorization: 'Basic ' + Buffer.from(`${USER}:wrong${i}`).toString('base64') }
      });
      tries = i + 1;
      if (Date.now() - t > 1500) { slowAt = tries; break; }
    }
    slowAt
      ? ok('失敗が続くと応答が遅くなる', `${slowAt}回目から遅延`)
      : bad('失敗が続いても遅くならない', `${tries}回間違えても遅くならない — 総当たりを止められない`);

    const t0 = Date.now();
    const good = await req('/api/display');
    const goodMs = Date.now() - t0;
    good.status === 200 && goodMs < 1500
      ? ok('遅延中でも正しい資格情報はすぐ通る', `${goodMs}ms`)
      : bad('正しい資格情報が通らない/遅い', `${good.status} ${goodMs}ms`);
  }

  // ---- 13. 同時接続 ----
  section(13, '同時接続');
  {
    doing('同時に60本つなぎます');
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
  section(14, '情報の出しすぎ');
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
  section(15, '画面の中身');
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

  // ---- 16. 中身を知らない相手が最初にやること ----
  section(16, '中身を知らない相手の手口');
  //
  // ここまでは「コードを読んで気づいた穴」を確かめてきた。ここからは逆に、
  // 中身を何も知らない相手が、外から順に試していく手をなぞる。
  {
    const host = new URL(BASE).host;
    const scheme = new URL(BASE).protocol;

    // (a) 公開パスを探り当てられるか。
    //     間違ったパスと正しいパスで応答が違うと、それが手がかりになる
    const wrongPath = await req(`${scheme}//${host}/zzqq-not-a-real-path/api/display`, { raw: true, auth: false });
    const rightPath = await req('/api/display', { auth: false });
    if (AUTH) {
      wrongPath.status === rightPath.status
        ? ok('正しい公開パスと外れの応答が同じ', `どちらも${wrongPath.status}`)
        : hmm('公開パスの当たり外れが応答で分かる',
          `外れ${wrongPath.status} / 当たり${rightPath.status} — 総当たりの手がかりになる`);
    }

    // (b) 入口を教えてしまうファイルが置かれていないか
    doing('外から順に叩いて、入口や置き忘れを探します');
    for (const path of ['/robots.txt', '/sitemap.xml', '/.well-known/security.txt', '/favicon.ico']) {
      const r = await req(`${scheme}//${host}${path}`, { raw: true, auth: false });
      r.status === 200 && new RegExp(BASE.split('/').pop()).test(r.text)
        ? bad('公開パスが外から読めるファイルに書かれている', path)
        : ok('入口を教えるファイルが無い', `${path} → ${r.status}`);
    }

    // (c) よくある置き忘れ
    for (const path of ['/.env', '/.git/HEAD', '/config.json', '/backup.zip', '/admin', '/phpinfo.php', '/.DS_Store']) {
      const r = await req(`${scheme}//${host}${path}`, { raw: true, auth: false });
      r.status === 200
        ? bad('置き忘れたファイルが読める', path)
        : ok('置き忘れが無い', `${path} → ${r.status}`);
    }

    // (d) メソッドを変えて認証やCSRFの検査をすり抜けられないか。
    //     0 は Node の fetch がそのメソッドを送れないもの(TRACEなど)、
    //     400 は Node のHTTP解析が知らないメソッドとして弾いたもの。
    //     どちらも「受け付けていない」なので、通った扱いにはしない
    for (const method of ['PUT', 'PATCH', 'TRACE', 'PROPFIND', 'FOO']) {
      const r = await req('/api/display/clear', { method });
      [0, 400, 403, 404, 405, 501].includes(r.status)
        ? ok(`知らないメソッドを受けない (${method})`, `${r.status || '送信できず'}`)
        : bad(`知らないメソッドが通る (${method})`, `${r.status}`);
    }

    // TRACE で送った内容がそのまま返ってこないか(返ると資格情報を盗む足掛かりになる)
    {
      const net = require('net');
      const u = new URL(BASE);
      if (u.protocol === 'http:') {
        const reflected = await new Promise((resolve) => {
          const sock = net.connect(Number(u.port || 80), u.hostname, () => {
            sock.write(`TRACE ${u.pathname}/api/display HTTP/1.1\r\nHost: ${u.host}\r\nX-Probe: reflect-me\r\n\r\n`);
          });
          let d = '';
          sock.on('data', (c) => { d += c; });
          sock.on('error', () => resolve(false));
          setTimeout(() => { sock.destroy(); resolve(/reflect-me/.test(d)); }, 2000);
        });
        reflected ? bad('TRACEで送った内容が返ってくる') : ok('TRACEで送った内容は返らない');
      }
    }

    // (e) メソッドを詐称するヘッダー。これが効くとCSRFの検査を飛び越えられる
    //     (検査はGET/HEAD/OPTIONS以外にしか掛からないため)
    for (const header of ['X-HTTP-Method-Override', 'X-Method-Override', 'X-HTTP-Method']) {
      const before = (await req('/api/display')).json?.mode;
      const r = await req('/api/display/clear', { method: 'GET', headers: { [header]: 'POST' } });
      const after = (await req('/api/display')).json?.mode;
      r.status === 404 && before === after
        ? ok(`メソッドの詐称が効かない (${header})`)
        : bad(`メソッドの詐称が効く (${header})`, `${r.status} mode ${before}→${after}`);
    }

    // (f) 経路の書き方を変えて認証を抜けられないか
    for (const path of [
      '//api/display', '/api//display', '/./api/display', '/api/./display',
      '/API/DISPLAY', '/api/display/', '/api/display/.', '/api/display%20',
      '/api/display;x=1', '/%61pi/display'
    ]) {
      const r = await req(path, { auth: false });
      if (!AUTH) { ok('認証なし運用のため判定を飛ばす'); break; }
      [401, 404].includes(r.status)
        ? ok('経路の書き換えで認証を抜けられない', `${path} → ${r.status}`)
        : bad('経路の書き換えで認証を抜けられる', `${path} → ${r.status}`);
    }

    // (g) 前段のプロキシを装うヘッダーで行き先を書き換えられないか
    for (const [h, v] of [
      ['X-Original-URL', '/api/display'], ['X-Rewrite-URL', '/api/display'],
      ['X-Forwarded-Host', 'evil.example.com'], ['X-Forwarded-Proto', 'http'],
      ['X-Forwarded-Prefix', '/evil'], ['X-Forwarded-Port', '1']
    ]) {
      const r = await req(`${scheme}//${host}/zzqq-not-a-real-path/`, { raw: true, auth: false, headers: { [h]: v } });
      r.status === 200
        ? bad('プロキシ用ヘッダーで認証を抜けられる', `${h}: ${v}`)
        : ok('プロキシ用ヘッダーで行き先は変わらない', `${h} → ${r.status}`);
    }

    // (h) 圧縮爆弾。展開後の大きさで断らないとメモリを食い尽くされる
    {
      doing('圧縮爆弾を作っています(展開後60MB)');
      const zlib = require('zlib');
      const huge = Buffer.from('{"enabled":true,"x":"' + 'a'.repeat(60 * 1024 * 1024) + '"}');
      const gz = zlib.gzipSync(huge);
      const r = await req('/api/display/updates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' },
        body: gz
      });
      expectReject('圧縮爆弾を断る', r.status, [400, 413, 415], `${(gz.length / 1024).toFixed(0)}KB が展開後60MB`);
      const alive = await req('/api/display');
      alive.status === 200 ? ok('圧縮爆弾のあとも応答する') : bad('圧縮爆弾でサーバーが応答しない', `${alive.status}`);
    }

    // (i) 長さの食い違い(要求の密輸)
    for (const headers of [
      { 'Content-Length': '5', 'Transfer-Encoding': 'chunked' },
      { 'Content-Length': '5', 'Content-Length ': '6' }
    ]) {
      const r = await req('/api/display/updates', {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: '{"enabled":true}'
      });
      [400, 403, 411, 413, 0].includes(r.status) || r.status === 200
        ? ok('長さの食い違いで壊れない', `${r.status}`)
        : hmm('長さの食い違いで想定外', `${r.status}`);
    }

    // (j) Rangeの細工。大きなファイルで増幅させられないか
    {
      const many = Array.from({ length: 300 }, (_, i) => `${i}-${i + 1}`).join(',');
      const r = await req('/vendor/selfie_segmentation/selfie_segmentation_solution_simd_wasm_bin.wasm', {
        headers: { Range: `bytes=${many}` }
      });
      [200, 206, 416].includes(r.status)
        ? ok('Rangeの細工で壊れない', `${r.status} ${(r.text.length / 1024).toFixed(0)}KB`)
        : hmm('Rangeの細工で想定外', `${r.status}`);
    }

    // (k) 開いたまま黙る接続(遅延攻撃)。展示中に一番効く止め方
    {
      const net = require('net');
      const isTls = scheme === 'https:';
      const port = new URL(BASE).port || (isTls ? 443 : 80);
      doing('ヘッダーを送り切らない接続を80本開きます(5秒ほど)');
      const sockets = [];
      const N = 80;
      await new Promise((resolve) => {
        let opened = 0;
        for (let i = 0; i < N; i++) {
          const lib = isTls ? require('tls') : net;
          const sock = lib.connect(
            isTls ? { host: new URL(BASE).hostname, port, servername: new URL(BASE).hostname } : { host: new URL(BASE).hostname, port },
            () => {
              // ヘッダーを送り切らずに黙る
              sock.write(`GET ${new URL(BASE).pathname}/api/display HTTP/1.1\r\nHost: ${host}\r\n`);
              if (++opened === N) resolve();
            }
          );
          sock.on('error', () => { if (++opened === N) resolve(); });
          sockets.push(sock);
        }
        setTimeout(resolve, 5000);
      });
      const during = await req('/api/display');
      for (const sock of sockets) sock.destroy();
      during.status === 200
        ? ok('黙った接続を抱えたままでも応答する', `${N}本を保持中に200`)
        : bad('黙った接続で応答できなくなる', `${N}本で ${during.status}`);
    }

    // (l) 飛ばし先を書き換えられないか
    for (const path of ['/?next=//evil.example.com', '/api/display?redirect=//evil.example.com']) {
      const r = await req(path, { redirect: 'manual' });
      const loc = r.headers.get('location');
      loc && /evil\.example\.com/.test(loc)
        ? bad('外部へ飛ばせる', `${path} → ${loc}`)
        : ok('外部へ飛ばせない', `${path} → ${r.status}`);
    }

    // (m) 入口の応答から中身が分かってしまわないか
    {
      const r = await req(`${scheme}//${host}/`, { raw: true, auth: false });
      /Express|Node\.js|nginx|cannot GET/i.test(r.text)
        ? hmm('入口の応答で使っている道具が分かる', r.text.slice(0, 80))
        : ok('入口の応答から道具が分からない');
      const server = r.headers.get('server');
      if (!server) {
        ok('Serverヘッダーを出していない');
      } else if (/cloudflare|cloudfront|akamai|fastly|render/i.test(server)) {
        // 前段のCDNが名乗っているもの。こちらのアプリの素性は出ていないので、
        // 消せないし、消す必要もない
        ok('Serverヘッダーは前段のもの', `${server}（アプリの素性は出ていない）`);
      } else {
        hmm('Serverヘッダーでアプリの素性が分かる', server);
      }
    }

    // (n) 画面の守りの上乗せ(万一の持ち出しを止める)
    {
      const r = await req('/capture.html');
      const csp = r.headers.get('content-security-policy');
      csp
        ? ok('Content-Security-Policy がある', csp.slice(0, 70))
        : hmm('Content-Security-Policy が無い', '万一の持ち出しを止める上乗せが無い');
    }
  }

  // ---- 17. 送った写真を残していないか ----
  section(17, '後片付け');
  {
    if (createdEntries.length) {
      bad('送った写真を消しきれていない',
        `${createdEntries.length}件が残っている(番号 ${createdEntries.map((e) => e.sequence).join(', ')})。`
        + '係員画面で削除するか、開発モードを切ること');
    } else if (droppedCount) {
      ok('送った写真をすべて片付けた', `${droppedCount}件を送って${droppedCount}件とも削除`);
    } else {
      ok('写真を送っていないので片付けるものは無い');
    }

    // 待ち行列に未表示が残っていないか(残っていると閲覧ブースに出てしまう)
    const after = await req('/api/entries');
    const waiting = after.json?.waiting;
    if (typeof waiting === 'number') {
      waiting === 0
        ? ok('未表示の受付が残っていない', '閲覧ブースに出るものは無い')
        : hmm('未表示の受付が残っている', `${waiting}件 — この確認の前からあったものか、係員画面で確かめること`);
    }

    /*
     * 受付番号は削除しても戻らない(次の受付は続きの番号になる)。
     * 本番前に再起動すれば1番から始まるので、その旨だけ伝えておく。
     */
    if (lastSequence) {
      line(dim(`       受付番号を ${lastSequence} まで使いました。削除しても番号は戻りません。`));
      line(dim('       本番前にサーバーを再起動すれば1番から始まります(デプロイでも再起動します)。'));
    }
  }

  // ============================================================
  // 途中で1件ずつ出しているので、最後はまとめだけを残す
  // 最後に棒を満たしてから消す(途中で止まったのではないと分かるように)
  sectionIndex = SECTIONS.length;
  sectionTitle = '完了';
  drawBar();
  clearBar();

  console.log(`\n${'='.repeat(62)}`);
  console.log(bold(`  まとめ  ${SECTIONS.length}区分 / ${pass.length + warn.length + fail.length}項目 / ${elapsed()}`));
  console.log('='.repeat(62));
  console.log(`  ${green(`確認できた   ${String(pass.length).padStart(3)}件`)}`);
  console.log(`  ${warn.length ? yellow(`要確認       ${String(warn.length).padStart(3)}件`) : dim('要確認         0件')}`);
  console.log(`  ${fail.length ? red(`危険         ${String(fail.length).padStart(3)}件`) : dim('危険           0件')}`);

  if (warn.length) {
    console.log(`\n${yellow('要確認')}（すぐ危ないものではないが、見ておくもの）`);
    for (const w of warn) console.log(`  ?    ${w.name}${w.note ? `  (${w.note})` : ''}`);
  }
  if (fail.length) {
    console.log(`\n${red('危険')}（直してから本番に出すもの）`);
    for (const f of fail) console.log(`  NG   ${f.name}${f.note ? `  (${f.note})` : ''}`);
  }
  console.log('='.repeat(62));

  if (fail.length === 0 && warn.length === 0) {
    console.log(green('  指摘はありません。'));
  }
  if (throttledCount >= 3) {
    console.log(yellow(`\n  前段(CDN)に${throttledCount}件絞られています。`));
    console.log('  データセンターのIP(Codespacesなど)から流すと起きやすくなります。');
    console.log('  10〜15分ほど置いてから流し直すか、手元の回線から流し直してください。');
  }
  if (devMode) {
    console.log(dim('\n  開発モード中のため、aging APIのユニットは使っていません。'));
    console.log(dim('  確認が済んだら係員画面で開発モードを切ってください（ここで作られた受付も消えます）。'));
  }
  process.exit(fail.length ? 1 : 0);
}

run().catch((err) => {
  clearBar();
  console.error(`\n${red('確認そのものが失敗しました')}`);
  console.error(err);
  process.exit(2);
});
