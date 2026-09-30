/**
 * 撮影ブース・閲覧ブースの共通処理。
 */

/**
 * バックエンドのAPIベースURLを実行時に解決する。
 *
 * 1) Codespaceでの開発時: フロントは3000、バックエンドは5000と別オリジン。
 *    Codespaceごとにサブドメイン名が変わるためURLはハードコードできず、
 *    現在のホスト名のポート部分だけを5000に差し替えて組み立てる。
 * 2) Render公開時: フロントとAPIを同一オリジンで配信し、さらに全体を
 *    推測困難なパス(APP_BASE_PATH)配下に置くため、このページ自身の
 *    ディレクトリをそのままAPIのベースURLとして使う。
 */
function resolveBackendBase() {
  const { protocol, hostname, port, origin, pathname } = window.location;

  const codespacesMatch = hostname.match(/^(.*)-\d+(\.app\.github\.dev|\.githubpreview\.dev|\.preview\.app\.github\.dev)$/);
  if (codespacesMatch) {
    return `${protocol}//${codespacesMatch[1]}-5000${codespacesMatch[2]}`;
  }

  if (port && port !== '5000') {
    return `${protocol}//${hostname}:5000`;
  }

  return origin + pathname.replace(/\/[^/]*$/, '');
}

const BACKEND_BASE = resolveBackendBase();
// サーバーへ申告するのはオリジンのみ(公開パスはサーバー側が自分で付ける)
const BACKEND_ORIGIN = new URL(BACKEND_BASE, window.location.href).origin;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 履歴送信そのものが失敗したときに再帰しないためのフラグ
let sendingLog = false;

// このページで発生した通信エラーの累計(係員画面の通信状況で表示する)
let clientErrorCount = 0;

/**
 * 例外のstackから「どこで起きたか」を取り出す。
 * ブラウザによって書式が違うので、末尾の :行:桁 だけを拾う。
 * @param {string} stack
 * @returns {{file: string, line: number|null, column: number|null}|null}
 */
function whereFrom(stack) {
  for (const line of String(stack || '').split('\n')) {
    const match = line.match(/((?:https?:\/\/|\/)[^\s()]+?):(\d+):(\d+)\)?\s*$/);
    if (!match) continue;
    // URLではなくファイル名だけを見せる(公開パスを履歴に残さないため)
    const file = match[1].split('?')[0].split('/').pop() || match[1];
    return { file, line: Number(match[2]), column: Number(match[3]) };
  }
  return null;
}

/**
 * このブラウザで今いる場所(呼び出し元のファイルと行)を取る。
 * 処理履歴の詳細に添えて、係員が原因を追えるようにするため。
 */
function currentWhere() {
  try {
    // whereFrom / currentWhere 自身の枠は common.js なので、
    // 呼び出し元まで含めて最初に当たったものを使う
    const stack = new Error().stack.split('\n').filter((line) => !/currentWhere|whereFrom/.test(line));
    return whereFrom(stack.join('\n'));
  } catch (err) {
    return null;
  }
}

/**
 * 係員画面の処理履歴に、このブラウザでの出来事を残す。
 * 送信自体の失敗は握りつぶす(展示の進行を止めないため)。
 *
 * message は一覧に出る一行なので短く保ち、通信の全文や例外の内容は
 * detail (where / error / request / response) に入れる。係員画面では
 * 「内容」を押すと detail が開く。
 */
function logEvent({ level = 'info', event, message = '', status = null, sequence = null, detail = null }) {
  if (sendingLog) return;
  sendingLog = true;

  const body = { level, event, message: String(message), status, sequence };
  const where = detail?.where || currentWhere();
  if (detail || where) {
    body.detail = { ...(detail || {}), ...(where ? { where } : {}) };
  }

  fetch(BACKEND_BASE + '/api/logs', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
    .catch(() => {})
    .finally(() => { sendingLog = false; });
}

/**
 * 処理履歴の詳細に載せるJSON。読める形に整えて返す。
 */
function detailJson(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch (err) {
    return String(value);
  }
}

/*
 * 中身が変わっていなければ本文を受け取らないための控え。
 *
 * 各画面は3〜5秒ごとに同じ場所を見に来る。表示が変わらない間もまるごと
 * 受け取っていると、一覧が育つほど通信量が増える(受付130件と履歴500件で
 * 実測110MB/時)。Renderの送信量はワークスペースごとの月単位で、使い切ると
 * サービスが止まるため、出ていく量そのものを減らしておく。
 *
 * サーバーはETagを付けてくる。前回の値を If-None-Match で送り返すと、
 * 変わっていなければ304が返り、本文は流れない。そのときは前回の内容を
 * そのまま使う(304は「同じ」という意味なので、使い回して問題ない)。
 *
 * ブラウザ任せ(Cache-Controlだけ)では実際には再確認が起きなかったため、
 * 自分で送り、自分で持つ。
 */
const revalidateCache = new Map();

/**
 * APIを呼び出してJSONを返す。Basic認証の資格情報を送るため
 * credentialsは既定の'same-origin'のままにする。
 * 失敗した場合はステータスコード付きで処理履歴に残す。
 *
 * @param {object} [options.revalidate]
 *   trueにすると、前回と中身が同じ場合に本文を受け取らずに済ませる。
 *   定期的に同じ場所を見に行くものにだけ付ける。
 */
async function callApi(apiPath, options = {}) {
  const { revalidate = false, ...fetchOptions } = options;
  const method = (fetchOptions.method || 'GET').toUpperCase();
  // FormDataは中身を展開できないので、種類だけを残す
  const requestBody = typeof fetchOptions.body === 'string' ? fetchOptions.body
    : (fetchOptions.body ? `(${fetchOptions.body.constructor?.name || typeof fetchOptions.body})` : null);
  const request = detailJson({ method, url: apiPath, headers: fetchOptions.headers || null, body: requestBody });

  const cached = revalidate ? revalidateCache.get(apiPath) : null;
  if (cached) {
    fetchOptions.headers = { ...fetchOptions.headers, 'If-None-Match': cached.etag };
    // 自分で確かめるので、ブラウザ側の控えは挟ませない
    fetchOptions.cache = 'no-store';
  }

  let res;
  try {
    res = await fetch(BACKEND_BASE + apiPath, { credentials: 'same-origin', ...fetchOptions });
  } catch (networkErr) {
    clientErrorCount += 1;
    logEvent({
      level: 'error',
      event: 'fetch:failed',
      message: `${apiPath} に届きません`,
      detail: {
        where: whereFrom(networkErr.stack),
        error: networkErr.stack || String(networkErr),
        request,
        response: detailJson({ status: null, body: '(応答なし)' })
      }
    });
    throw new Error(`サーバーに接続できません。詳細: ${networkErr.message}`);
  }

  if (res.status === 204) {
    return null;
  }

  // 前回と同じ。本文は流れていないので、控えておいた内容をそのまま使う
  if (res.status === 304 && cached) {
    return cached.payload;
  }

  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    clientErrorCount += 1;
    logEvent({
      level: 'error',
      event: 'fetch:error',
      status: res.status,
      // 一覧はどこが失敗したかだけ。やり取りの全文は詳細で見る
      message: `${apiPath} ${payload.error || ''}`.trim(),
      detail: {
        request,
        response: detailJson({
          status: res.status,
          status_text: res.statusText,
          headers: Object.fromEntries(res.headers),
          body: payload
        })
      }
    });
    const error = new Error(payload.error || `リクエストが失敗しました (${res.status})`);
    error.status = res.status;
    error.payload = payload;
    throw error;
  }

  // 次回、変わっていなければ本文を受け取らずに済ませるための控え
  if (revalidate) {
    const etag = res.headers.get('etag');
    if (etag) revalidateCache.set(apiPath, { etag, payload });
    else revalidateCache.delete(apiPath);
  }
  return payload;
}

/**
 * 展示機の画面を固定する(キオスク化)。撮影ブースと閲覧ブースで呼ぶ。
 *
 * 来場者が画面に触れても、拡大・移動・選択メニューが起きないようにする。
 * CSS側(booth.css の body.is-kiosk)と対になっていて、こちらは
 * CSSでは止められないものを受け持つ。
 *
 * - ピンチでの拡大: iOSのSafariは viewport の user-scalable=no を無視する
 * - 長押しのメニュー
 * - 2本指でのスクロール
 * - 同じ場所をすばやく2回叩いたときの拡大(touch-action の保険)
 *
 * 係員画面では呼ばない(文字を選べ、拡大できる必要があるため)。
 */
function lockKiosk() {
  document.body.classList.add('is-kiosk');

  for (const type of ['gesturestart', 'gesturechange', 'gestureend']) {
    document.addEventListener(type, (event) => event.preventDefault(), { passive: false });
  }

  document.addEventListener('contextmenu', (event) => event.preventDefault());

  document.addEventListener('touchmove', (event) => {
    if (event.touches.length > 1) event.preventDefault();
  }, { passive: false });

  // 同じ場所を続けて叩いたときだけ抑える。場所が違えば普通の操作として通す
  const DOUBLE_TAP_MS = 350;
  const DOUBLE_TAP_PX = 30;
  let lastTap = { at: 0, x: 0, y: 0 };
  document.addEventListener('touchend', (event) => {
    const touch = event.changedTouches[0];
    if (!touch) return;
    const now = Date.now();
    const near = Math.hypot(touch.clientX - lastTap.x, touch.clientY - lastTap.y) < DOUBLE_TAP_PX;
    if (now - lastTap.at < DOUBLE_TAP_MS && near) {
      event.preventDefault();
    }
    lastTap = { at: now, x: touch.clientX, y: touch.clientY };
  }, { passive: false });
}

/**
 * 係員画面で通信状況を見られるよう、このページの生存を定期的に伝える。
 * 送信にかかった往復時間と、これまでの通信エラー件数も一緒に送る。
 * @param {string} role - 'capture' | 'view' | 'staff'
 */
function startHeartbeat(role, intervalMs = 5000) {
  let clientId;
  try {
    clientId = sessionStorage.getItem('boothClientId');
    if (!clientId) {
      clientId = `${role}-${Math.random().toString(36).slice(2, 10)}`;
      sessionStorage.setItem('boothClientId', clientId);
    }
  } catch (err) {
    // sessionStorageが使えない環境では毎回新しいIDになる
    clientId = `${role}-${Math.random().toString(36).slice(2, 10)}`;
  }

  let latencyMs = null;

  async function beat() {
    const startedAt = performance.now();
    try {
      await fetch(BACKEND_BASE + '/api/heartbeat', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: clientId,
          role,
          page: window.location.pathname,
          latency_ms: latencyMs,
          error_count: clientErrorCount
        })
      });
      latencyMs = performance.now() - startedAt;
    } catch (err) {
      latencyMs = null;
    }
  }

  beat();
  setInterval(beat, intervalMs);
}

/**
 * 結果画像のURLは公開パスを含む絶対パスで返ってくるため、
 * Codespaceの別オリジン構成でも参照できるようオリジンを補う。
 */
function resolveImageUrl(url) {
  return new URL(url, BACKEND_BASE + '/').href;
}

/**
 * 画像URLを読み込む。
 * @returns {Promise<HTMLImageElement>}
 */
function loadImage(imageUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`画像の読み込みに失敗しました: ${imageUrl}`));
    img.src = imageUrl;
  });
}
