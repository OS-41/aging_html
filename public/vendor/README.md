# public/vendor

外部から取ってきて、そのまま同梱しているもの。**手で書き換えない。**

会場のネットワークがCDNに届くかどうかを当日の心配事にしないため、
また、カメラ映像を扱っているページで他所のコードを動かさないために、
自前で配信している。

## selfie_segmentation

撮影ブースの背景合成（人物の切り抜き）に使う MediaPipe Selfie Segmentation。

| | |
| --- | --- |
| パッケージ | `@mediapipe/selfie_segmentation` |
| 版 | `0.1.1675465747`（2023-02-03 公開、これが最新） |
| ライセンス | Apache-2.0 |
| 取得元 | `https://registry.npmjs.org/@mediapipe/selfie_segmentation/-/selfie_segmentation-0.1.1675465747.tgz` |
| tarballのsha512 | `IxYxNhwE5VwOm52L1yoFWYLP7q9Pd+NJjzOC5tlepfvEGaY3o9hslhUrx9BgseqdfZtKSDtd/4NfCSMjNzQalA==` |

npmが公開している `dist.integrity` と、手元で取ったtarballのsha512が
一致することを確認して展開した。型定義（`index.d.ts`）だけは使わないので外し、
それ以外はパッケージの中身をそのまま置いている。

### 更新するとき

```sh
curl -sS https://registry.npmjs.org/@mediapipe/selfie_segmentation \
  | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const p=JSON.parse(d);const v=p["dist-tags"].latest;console.log(v, p.versions[v].dist.tarball, p.versions[v].dist.integrity)})'
# tarballを取り、sha512が integrity と一致することを確かめてから展開する
```

`.wasm` はブラウザが型を見て拒むことがあるため、`server.js` の静的配信で
`application/wasm` を明示している（`.tflite` などは型を持たないので
`application/octet-stream` のまま）。
