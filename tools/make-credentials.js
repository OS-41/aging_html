#!/usr/bin/env node
/*
 * 公開パスとBasic認証の資格情報を作る。
 *
 *   node tools/make-credentials.js
 *   node tools/make-credentials.js --length 32    # パスワードを長くする
 *
 * ---- なぜ道具にしてあるか ----
 *
 * 当日の前日にもう一度作り直す予定があるため、そのときに人に頼らず
 * 同じ品質のものを作れるようにしてある。手で考えた文字列や、
 * Math.random() で作ったものは使わないこと。
 *
 * ---- 文字の選び方 ----
 *
 * 1. **暗号用の乱数を使う**(crypto.randomInt)。Math.random() は
 *    予測できる作りなので、資格情報には使ってはいけない。
 * 2. **見間違える文字を外す**(0 O o 1 l I)。当日、iPadのBasic認証の
 *    入力欄に手で打ち込むので、打ち間違いが起きると設営が止まる。
 * 3. **記号を入れない**。Renderの入力欄・ターミナル・curlのそれぞれで
 *    引用符の扱いが違い、事故のもとになる。長さで強さを稼ぐほうが安全。
 * 4. 公開パスはURLに載るので、英数字と - _ だけにする
 *    (日本語や空白は、ブラウザが書き換えるため届かない)。
 */

const { randomInt } = require('crypto');

// 見間違えやすい 0 O o 1 l I を外した文字。58種
const SAFE = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
// 公開パスはURLに載るので、大文字小文字の取り違えを避けて小文字と数字だけ。31種
const PATH_CHARS = 'abcdefghijkmnpqrstuvwxyz23456789';

/** 暗号用の乱数で1文字ずつ選ぶ */
function pick(chars, length) {
  let out = '';
  for (let i = 0; i < length; i += 1) out += chars[randomInt(chars.length)];
  return out;
}

/** その長さと文字種で、総当たりに何ビット分の手間がかかるか */
function bits(chars, length) {
  return Math.floor(Math.log2(chars.length) * length);
}

const args = process.argv.slice(2);
const lengthArg = Number(args[args.indexOf('--length') + 1]);
const PASS_LEN = Number.isInteger(lengthArg) && lengthArg >= 16 && lengthArg <= 64 ? lengthArg : 24;
const PATH_LEN = 20;
const USER_LEN = 12;

const path = '/' + pick(PATH_CHARS, PATH_LEN);
const user = pick(SAFE, USER_LEN);
const pass = pick(SAFE, PASS_LEN);

const line = '='.repeat(64);
console.log(line);
console.log('  公開パスとBasic認証の資格情報');
console.log(line);
console.log('');
console.log('Renderのダッシュボード(Environment)に、この3つを入れる:');
console.log('');
console.log(`  APP_BASE_PATH         ${path}`);
console.log(`  BASIC_AUTH_USER       ${user}`);
console.log(`  BASIC_AUTH_PASSWORD   ${pass}`);
console.log('');
console.log('手元の .env に貼るならこの形:');
console.log('');
console.log(`APP_BASE_PATH=${path}`);
console.log(`BASIC_AUTH_USER=${user}`);
console.log(`BASIC_AUTH_PASSWORD=${pass}`);
console.log('');
console.log('各端末で開くURL(ホーム画面への追加もこれで、最後の / まで含めて):');
console.log('');
console.log(`  https://<Renderのホスト名>${path}/capture.html   撮影ブース`);
console.log(`  https://<Renderのホスト名>${path}/view.html      閲覧ブース`);
console.log(`  https://<Renderのホスト名>${path}/staff.html     係員用`);
console.log('');
console.log('確認スクリプトを流すとき:');
console.log('');
console.log(`  node tools/security-check.js https://<ホスト名>${path} ${user} '${pass}'`);
console.log('');
console.log(line);
console.log('  強さの目安');
console.log(line);
console.log(`  公開パス    ${PATH_LEN}文字 / ${PATH_CHARS.length}種  … 約${bits(PATH_CHARS, PATH_LEN)}ビット`);
console.log(`  ユーザー名  ${USER_LEN}文字 / ${SAFE.length}種  … 約${bits(SAFE, USER_LEN)}ビット`);
console.log(`  パスワード  ${PASS_LEN}文字 / ${SAFE.length}種  … 約${bits(SAFE, PASS_LEN)}ビット`);
console.log('');
console.log('  認証は、間違いが続くと応答が遅くなる(全体で10分40回)。');
console.log('  総当たりは現実的な時間では終わらない。');
console.log('');
console.log(line);
console.log('  入れ替えるときの手順');
console.log(line);
console.log('');
console.log('  1. **開場前に行う。**保存した時点で再デプロイ=再起動が走り、');
console.log('     保管中の受付と結果が消え、受付番号も1番に戻る');
console.log('  2. 3つまとめて1回で保存する(再起動を1回で済ませるため)');
console.log('  3. 各端末でホーム画面のアイコンを**追加し直す**');
console.log('     (URLが変わるので、前のアイコンからは開けなくなる)');
console.log('  4. 各端末でBasic認証を入れ直す(新しいユーザー名とパスワード)');
console.log('  5. 3画面が開くことと、撮影→閲覧が通ることを確かめる');
console.log('');
console.log('  この出力は秘密そのもの。画面に出したまま離席しない。');
console.log('  紙に控えるなら、当日の運用が終わったら処分する。');
console.log('');
