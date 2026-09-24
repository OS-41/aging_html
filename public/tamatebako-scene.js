/*
 * 玉手箱の演出。閲覧ブース(view.html)の絵柄 `tamatebako` で使う。
 *
 * 背景の絵(backgrounds/aging_viewBackground.jpg)は浜辺に開いた玉手箱と、
 * そこから右上へ立ちのぼる煙で構成されている。この煙の部分に加工後の写真を
 * 並べ、係員が表示を入れ替えるたびに「玉手箱を開けて煙が晴れる」流れを
 * canvasの煙で再現する。
 *
 *   const scene = createTamatebakoScene(canvas, { onPhase });
 *   scene.resize(width, height);
 *   scene.start();          // 待機中はゆるやかに煙が漂う
 *   scene.play();           // 入れ替えの演出を最初から流す
 *
 * 待機中は玉手箱が閉じていて、煙は出ていない。係員が結果画面へ移すと
 * ふたがゆっくり消え、消えきってから煙が立ちのぼる。いちど出した煙は
 * 待機画面に戻すまで消さない。
 *
 * 流れ(括弧内は既定の長さ):
 *   lifting  (1.6s) 閉じたふたがゆっくり消えていく。煙はまだ出さない
 *   rising   (1.0s) 口から最初のひと筋が立ちのぼる
 *   filling  (1.4s) 煙が画面いっぱいに広がる
 *   veiled   (0.6s) 完全に覆われている間に写真を入れ替える
 *   settling (1.6s) 写真が見える濃さまで薄れる。ここで止まり、引いていかない
 *   done           演出の終わり。煙はそのまま漂い続ける
 *
 * onPhase(phase, progress) で各段階を呼び出し側へ伝える。写真の差し替えは
 * veiled を受け取って view.html 側で行う。
 * 待機画面へ戻すときは close() を呼ぶと、煙が消えてふたが戻る。
 */
(function (global) {
  'use strict';

  // 各段階の長さ(ミリ秒)
  const PHASES = [
    ['lifting', 1600],
    ['rising', 1000],
    ['filling', 1400],
    ['veiled', 600],
    ['settling', 1600]
  ];

  // 写真を出しているあいだ、煙を漂わせておく濃さ。
  // かたまりが重なるため、1つあたりはかなり薄くしないと画面が白く飛ぶ。
  const SETTLED_ALPHA = 0.2;
  // 待機画面へ戻すときに煙が消えるまでの時間
  const CLOSE_MS = 1200;

  // 背景の絵に合わせた煙の色。白ではなく、うすい藤色と桜色を重ねる
  const PUFF_COLORS = [
    'rgba(255, 255, 255, 0.95)',
    'rgba(246, 238, 250, 0.92)',
    'rgba(233, 223, 246, 0.90)',
    'rgba(250, 228, 236, 0.88)',
    'rgba(222, 216, 243, 0.86)'
  ];

  /*
   * 玉手箱の位置は、背景の絵の中での位置から毎回計算する。
   * 背景は cover で敷くため、画面の縦横比によって絵のどこが切り取られるかが
   * 変わる。画面に対する割合で固定すると、別の縦横比のディスプレイでは
   * 煙の出どころが絵の玉手箱からずれてしまう。
   *
   * BACKDROP は背景画像(aging_viewBackground.jpg)の元の寸法、
   * BOX_IN_IMAGE はその絵の中での玉手箱の位置と横幅(いずれも割合)。
   * 背景画像を差し替えたらこの2つを合わせること。
   * view.html 側が background-position: center であることが前提。
   */
  const BACKDROP = { width: 1195, height: 896 };
  const BOX_IN_IMAGE = { x: 0.165, y: 0.80, halfWidth: 0.115 };

  /**
   * coverで敷いた背景の上で、玉手箱が画面のどこに来るかを求める。
   * @param {number} width - canvasの幅
   * @param {number} height - canvasの高さ
   */
  function resolveBoxPosition(width, height) {
    const scale = Math.max(width / BACKDROP.width, height / BACKDROP.height);
    const drawnWidth = BACKDROP.width * scale;
    const drawnHeight = BACKDROP.height * scale;
    const left = (width - drawnWidth) / 2;
    const top = (height - drawnHeight) / 2;
    return {
      x: left + drawnWidth * BOX_IN_IMAGE.x,
      y: top + drawnHeight * BOX_IN_IMAGE.y,
      size: drawnWidth * BOX_IN_IMAGE.halfWidth
    };
  }

  const clamp01 = (v) => Math.min(1, Math.max(0, v));
  // 立ち上がりと終わりをなめらかにする
  const easeInOut = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
  const easeOut = (t) => 1 - Math.pow(1 - t, 3);

  /**
   * @param {HTMLCanvasElement} canvas
   * @param {{onPhase?: (phase: string, progress: number) => void}} [options]
   */
  function createTamatebakoScene(canvas, options = {}) {
    const ctx = canvas.getContext('2d');
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const onPhase = options.onPhase || (() => {});

    // 画面上での玉手箱の位置と大きさ。resizeのたびに計算し直す
    let box = { x: 0, y: 0, size: 0 };
    let puffs = [];
    let running = false;
    let playStartMs = 0;      // 0なら演出中ではない
    let closeStartMs = 0;     // 待機画面へ戻す演出の開始時刻
    let lastPhase = null;
    // 演出を流し終えたか。写真を出しているあいだは煙を残す
    let revealed = false;

    /**
     * 煙のかたまりを組み立てる。1つのかたまりは重なった丸の集まりで、
     * 玉手箱から出たあと右上へ流れていく。
     */
    function resize(width, height) {
      canvas.width = Math.max(1, Math.round(width));
      canvas.height = Math.max(1, Math.round(height));
      box = resolveBoxPosition(canvas.width, canvas.height);

      const { width: w, height: h } = canvas;
      const unit = Math.max(w, h);

      puffs = Array.from({ length: 34 }, (_, i) => {
        // 玉手箱からの噴き出し順。遅いものほど外側へ広がる
        const order = i / 34;
        return {
          order,
          // 煙が晴れたあとの落ち着き先(背景の絵の煙とおおよそ重なる帯)
          restX: w * (0.22 + Math.random() * 0.76),
          restY: h * (0.04 + Math.random() * 0.72),
          restR: unit * (0.06 + Math.random() * 0.1),
          // 画面を覆うときの居場所
          fullX: w * (-0.05 + Math.random() * 1.1),
          fullY: h * (-0.05 + Math.random() * 1.1),
          fullR: unit * (0.16 + Math.random() * 0.14),
          color: PUFF_COLORS[i % PUFF_COLORS.length],
          // ふわふわした輪郭をつくる子の丸
          lobes: Array.from({ length: 7 }, () => ({
            dx: (Math.random() - 0.5) * 1.5,
            dy: (Math.random() - 0.5) * 1.1,
            r: 0.42 + Math.random() * 0.4
          })),
          drift: 0.1 + Math.random() * 0.22,
          phase: Math.random() * Math.PI * 2
        };
      });
    }

    /**
     * ひとかたまりの煙を描く。
     * @param {object} puff
     * @param {number} x,y,r - 中心と大きさ
     * @param {number} alpha - 濃さ
     * @param {number} time - 秒
     */
    function drawPuff(puff, x, y, r, alpha, time) {
      if (alpha <= 0.01 || r <= 0) return;
      const sway = Math.sin(time * puff.drift * 2 + puff.phase) * r * 0.08;

      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.fillStyle = puff.color;
      // ぼかしで水彩のようなにじみを出す
      ctx.filter = `blur(${Math.max(4, r * 0.16)}px)`;
      ctx.beginPath();
      for (const lobe of puff.lobes) {
        ctx.moveTo(x + lobe.dx * r + sway + lobe.r * r, y + lobe.dy * r);
        ctx.arc(x + lobe.dx * r + sway, y + lobe.dy * r, lobe.r * r, 0, Math.PI * 2);
      }
      ctx.fill();
      ctx.restore();
    }

    /**
     * 閉じたふた。背景の絵の玉手箱は開いた状態で描かれているため、
     * その口を覆う板を重ねて「まだ閉じている」ように見せる。
     * 水彩の絵に馴染むよう、輪郭線を持たせずぼかした色面で描く。
     * @param {number} opacity - 1で閉じきり、0で消えた状態
     */
    function drawLid(opacity) {
      if (opacity <= 0.01) return;
      const s = box.size;
      const x = box.x;
      const y = box.y;

      ctx.save();
      ctx.globalAlpha = opacity;
      ctx.translate(x, y);
      // 絵の中の箱がわずかに傾いているのに合わせる
      ctx.rotate(-0.06);

      // 箱に載っているように見せるための落ち影
      ctx.filter = 'blur(8px)';
      ctx.fillStyle = 'rgba(26, 18, 10, 0.5)';
      ctx.beginPath();
      ctx.ellipse(0, s * 0.22, s * 0.95, s * 0.16, 0, 0, Math.PI * 2);
      ctx.fill();

      // ふたの板。絵の玉手箱と同じ黒漆の色で、輪郭はぼかして馴染ませる
      ctx.filter = 'blur(2px)';
      ctx.fillStyle = '#1d1712';
      ctx.beginPath();
      ctx.roundRect(-s, -s * 0.24, s * 2, s * 0.42, s * 0.06);
      ctx.fill();

      // 上面のわずかな照り
      ctx.fillStyle = '#332a20';
      ctx.beginPath();
      ctx.roundRect(-s * 0.95, -s * 0.2, s * 1.9, s * 0.16, s * 0.05);
      ctx.fill();

      // 金の蒔絵に見立てた帯と留め具
      ctx.fillStyle = '#b9922f';
      ctx.beginPath();
      ctx.roundRect(-s, s * 0.02, s * 2, s * 0.07, s * 0.03);
      ctx.fill();
      ctx.beginPath();
      ctx.roundRect(-s * 0.16, -s * 0.2, s * 0.32, s * 0.3, s * 0.04);
      ctx.fill();

      ctx.restore();
    }

    /**
     * 玉手箱が開いた合図。箱そのものは背景の絵に描かれているので、
     * ここでは口から漏れる光だけを重ねる。絵柄を壊さないよう、
     * 輪郭のない淡い光にとどめる。
     */
    function drawGlow(strength, time) {
      if (strength <= 0.01) return;
      const { width: w, height: h } = canvas;
      const x = box.x;
      const y = box.y;
      const r = Math.max(w, h) * (0.06 + 0.1 * strength);
      const flicker = 0.9 + Math.sin(time * 5) * 0.1;

      const light = ctx.createRadialGradient(x, y, 0, x, y, r);
      light.addColorStop(0, `rgba(255, 249, 226, ${0.85 * strength * flicker})`);
      light.addColorStop(0.45, `rgba(255, 233, 246, ${0.45 * strength})`);
      light.addColorStop(1, 'rgba(255, 233, 246, 0)');

      ctx.save();
      ctx.fillStyle = light;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    /**
     * 現在の段階と、その中での進み具合を求める。
     */
    function phaseAt(elapsedMs) {
      let acc = 0;
      for (const [name, length] of PHASES) {
        if (elapsedMs < acc + length) {
          return { name, progress: (elapsedMs - acc) / length };
        }
        acc += length;
      }
      return { name: 'done', progress: 1 };
    }

    /**
     * 段階ごとの「煙の広がり具合」(0=玉手箱のそば, 1=画面いっぱい)と濃さ、
     * ふたの残り具合、口から漏れる光の強さ。
     */
    function smokeShape(phase, progress) {
      switch (phase) {
        // ふたがゆっくり消える。煙はまだ出さない
        case 'lifting':
          return { spread: 0, alpha: 0, lid: 1 - easeInOut(progress), glow: easeInOut(progress) * 0.7 };
        // ふたが消えきってから、ひと筋が立ちのぼる
        case 'rising':
          return { spread: 0.14 * easeOut(progress), alpha: 0.8 * progress, lid: 0, glow: 0.7 + 0.3 * progress };
        // 画面いっぱいに広がる
        case 'filling':
          return { spread: 0.14 + 0.86 * easeInOut(progress), alpha: 0.8 + 0.2 * progress, lid: 0, glow: 1 - progress };
        // 完全に覆う(この間に写真を入れ替える)
        case 'veiled':
          return { spread: 1, alpha: 1, lid: 0, glow: 0 };
        // 写真が見える濃さまで薄れる。広がりは保ったままにして、煙を引かせない
        case 'settling':
          return { spread: 1, alpha: 1 - (1 - SETTLED_ALPHA) * easeInOut(progress), lid: 0, glow: 0 };
        default:
          return { spread: 1, alpha: SETTLED_ALPHA, lid: 0, glow: 0 };
      }
    }

    /**
     * 画面いっぱいに広がりきった煙を、指定の濃さで漂わせる。
     * 写真を出しているあいだ、これを描き続ける。
     */
    function drawSettledSmoke(alpha, time) {
      const h = canvas.height;
      for (const puff of puffs) {
        const float = Math.sin(time * puff.drift + puff.phase) * h * 0.02;
        drawPuff(puff, puff.fullX, puff.fullY + float, puff.fullR, alpha, time);
      }
    }

    function drawFrame(nowMs = performance.now()) {
      const { width: w, height: h } = canvas;
      if (!w || !h) return;
      const time = nowMs / 1000;
      ctx.clearRect(0, 0, w, h);

      // 待機画面へ戻す途中。煙が薄れ、入れ替わりにふたが戻る
      if (closeStartMs) {
        const t = clamp01((nowMs - closeStartMs) / CLOSE_MS);
        if (t >= 1) {
          closeStartMs = 0;
          revealed = false;
          drawLid(1);
          return;
        }
        drawSettledSmoke(SETTLED_ALPHA * (1 - t), time);
        drawLid(easeInOut(t));
        return;
      }

      // 演出が済んだあと。待機画面に戻すまで煙は消さない
      if (!playStartMs) {
        if (revealed) {
          drawSettledSmoke(SETTLED_ALPHA, time);
        } else {
          // 待機中は玉手箱が閉じていて、煙も出ていない
          drawLid(1);
        }
        return;
      }

      const elapsed = nowMs - playStartMs;
      const { name, progress } = phaseAt(elapsed);
      if (name !== lastPhase) {
        lastPhase = name;
        onPhase(name, progress);
      }
      if (name === 'done') {
        playStartMs = 0;
        lastPhase = null;
        revealed = true;
        drawSettledSmoke(SETTLED_ALPHA, time);
        return;
      }

      const { spread, alpha, lid, glow } = smokeShape(name, progress);
      const boxX = box.x;
      const boxY = box.y;

      // 光とふたは煙の下に置く(煙が広がるほど隠れていく)
      drawGlow(glow, time);
      drawLid(lid);

      for (const puff of puffs) {
        // 遅い順番のかたまりほど後から出てくる
        const entry = clamp01((spread - puff.order * 0.35) / 0.65);
        const t = easeOut(entry);
        const float = Math.sin(time * puff.drift + puff.phase) * h * 0.012;

        // 玉手箱 → 画面いっぱい → 背景の煙の位置、と居場所を混ぜていく
        const wide = clamp01((spread - 0.35) / 0.65);
        const targetX = puff.fullX * wide + puff.restX * (1 - wide);
        const targetY = puff.fullY * wide + puff.restY * (1 - wide);
        const targetR = puff.fullR * wide + puff.restR * (1 - wide);

        drawPuff(
          puff,
          boxX + (targetX - boxX) * t,
          boxY + (targetY + float - boxY) * t,
          Math.max(1, targetR * (0.3 + 0.7 * t)),
          alpha * (0.35 + 0.65 * t),
          time
        );
      }

    }

    function loop(nowMs) {
      if (!running) return;
      drawFrame(nowMs);
      requestAnimationFrame(loop);
    }

    function start() {
      if (running) return;
      if (reduceMotion) {
        drawFrame(performance.now());
        return;
      }
      running = true;
      requestAnimationFrame(loop);
    }

    function stop() {
      running = false;
    }

    /**
     * 入れ替えの演出を最初から流す。動きを抑える設定のときは
     * 煙を出さずに、写真の差し替えだけを呼び出し側へ伝える。
     */
    function play() {
      closeStartMs = 0;
      if (reduceMotion) {
        // 動きを抑える設定では煙を出さず、写真の差し替えだけを伝える
        onPhase('veiled', 0);
        onPhase('done', 1);
        revealed = true;
        drawFrame(performance.now());
        return;
      }
      playStartMs = performance.now();
      lastPhase = null;
    }

    /**
     * 待機画面へ戻す。煙が消え、入れ替わりにふたが閉じる。
     */
    function close() {
      playStartMs = 0;
      lastPhase = null;
      if (!revealed) return;
      if (reduceMotion) {
        revealed = false;
        drawFrame(performance.now());
        return;
      }
      closeStartMs = performance.now();
    }

    function isPlaying() {
      return playStartMs !== 0;
    }

    return { canvas, reduceMotion, resize, start, stop, drawFrame, play, close, isPlaying };
  }

  global.createTamatebakoScene = createTamatebakoScene;
})(window);
