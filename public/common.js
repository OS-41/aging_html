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

/**
 * APIを呼び出してJSONを返す。Basic認証の資格情報を送るため
 * credentialsは既定の'same-origin'のままにする。
 * 失敗した場合はステータスコード付きで処理履歴に残す。
 */
async function callApi(apiPath, options = {}) {
  const method = (options.method || 'GET').toUpperCase();
  // FormDataは中身を展開できないので、種類だけを残す
  const requestBody = typeof options.body === 'string' ? options.body
    : (options.body ? `(${options.body.constructor?.name || typeof options.body})` : null);
  const request = detailJson({ method, url: apiPath, headers: options.headers || null, body: requestBody });

  let res;
  try {
    res = await fetch(BACKEND_BASE + apiPath, { credentials: 'same-origin', ...options });
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
  return payload;
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
