/*
 * `node start` で起動されたときのための受け口。
 *
 * 本来の起動は `npm start`(= `node server.js`)。ただしRenderの
 * Start Command 欄には `node index.js` のような既定値が最初から入っており、
 * 後半だけを書き換えると `node start` という命令になってしまう。
 * そのままでは
 *   Error: Cannot find module '/opt/render/project/src/start'
 * で起動に失敗するため、そのファイル名で server.js へ橋渡ししておく。
 *
 * Start Command が正しく `node server.js` になっていれば、このファイルは
 * 読み込まれない。設定を直したあとも、取り違えの保険として残しておいてよい。
 */
require('./server.js');
