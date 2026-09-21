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

/**
 * APIを呼び出してJSONを返す。Basic認証の資格情報を送るため
 * credentialsは既定の'same-origin'のままにする。
 */
async function callApi(apiPath, options = {}) {
  let res;
  try {
    res = await fetch(BACKEND_BASE + apiPath, { credentials: 'same-origin', ...options });
  } catch (networkErr) {
    throw new Error(`サーバーに接続できません。詳細: ${networkErr.message}`);
  }

  if (res.status === 204) {
    return null;
  }

  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = new Error(payload.error || `リクエストが失敗しました (${res.status})`);
    error.status = res.status;
    error.payload = payload;
    throw error;
  }
  return payload;
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
