/*
 * 玉手箱の演出。閲覧ブース(view.html)の絵柄 `tamatebako` で使う。
 *
 * 背景の絵(backgrounds/aging_viewBackground.webp)は浜辺に開いた玉手箱と、
 * そこから右上へ立ちのぼる煙で構成されている。この煙の部分に加工後の写真を
 * 並べ、係員が表示を入れ替えるたびに「玉手箱を開けて煙が晴れる」流れを
 * canvasの煙で再現する。
 *
 *   const scene = createTamatebakoScene(canvas, { onPhase });
 *   scene.resize(width, height);
 *   scene.start();          // 待機中はゆるやかに煙が漂う
 *   scene.play();           // 入れ替えの演出を最初から流す
 *
 * 流れ(括弧内は既定の長さ):
 *   opening  (0.9s) 玉手箱のふたが開き、最初のひと筋が立ちのぼる
 *   filling  (1.2s) 煙が画面いっぱいに広がる
 *   veiled   (0.5s) 完全に覆われている間に写真を入れ替える
 *   clearing (1.8s) 煙が右上へ引いて、背景と写真が現れる
 *   settled  (2.5s) そのまま見せる
 *   zooming  (1.8s) 写真へゆっくり寄る
 *   done           演出の終わり(待機中の漂いに戻る)
 *
 * onPhase(phase, progress) で各段階を呼び出し側へ伝える。写真の差し替えは
 * veiled、拡大は zooming を受け取って view.html 側で行う。
 */
(function (global) {
  'use strict';

  // 各段階の長さ(ミリ秒)
  const PHASES = [
    ['opening', 900],
    ['filling', 1200],
    ['veiled', 500],
    ['clearing', 1800],
    ['settled', 2500],
    ['zooming', 1800]
  ];

  // 背景の絵に合わせた煙の色。白ではなく、うすい藤色と桜色を重ねる
  const PUFF_COLORS = [
    'rgba(255, 255, 255, 0.95)',
    'rgba(246, 238, 250, 0.92)',
    'rgba(233, 223, 246, 0.90)',
    'rgba(250, 228, 236, 0.88)',
    'rgba(222, 216, 243, 0.86)'
  ];

  // 玉手箱の位置(画面に対する割合)。背景の絵の玉手箱とほぼ重なる。
  // 背景の敷き方(view.html の #backdrop の background-position)を変えたら
  // ここも合わせること。
  const BOX = { x: 0.10, y: 0.86 };

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

    let puffs = [];
    let running = false;
    let playStartMs = 0;      // 0なら演出中ではない(待機中の漂いだけ)
    let lastPhase = null;

    /**
     * 煙のかたまりを組み立てる。1つのかたまりは重なった丸の集まりで、
     * 玉手箱から出たあと右上へ流れていく。
     */
    function resize(width, height) {
      canvas.width = Math.max(1, Math.round(width));
      canvas.height = Math.max(1, Math.round(height));

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
     * 玉手箱が開いた合図。箱そのものは背景の絵に描かれているので、
     * ここでは口から漏れる光だけを重ねる。絵柄を壊さないよう、
     * 輪郭のない淡い光にとどめる。
     */
    function drawGlow(strength, time) {
      if (strength <= 0.01) return;
      const { width: w, height: h } = canvas;
      const x = w * BOX.x;
      const y = h * BOX.y;
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
     * 段階ごとの「煙の広がり具合」(0=玉手箱のそば, 1=画面いっぱい)と濃さ。
     */
    function smokeShape(phase, progress) {
      switch (phase) {
        // ふたが開いて、ひと筋が立ちのぼる
        case 'opening': return { spread: 0.12 * easeOut(progress), alpha: 0.75 * progress, glow: easeOut(progress) };
        // 画面いっぱいに広がる
        case 'filling': return { spread: 0.12 + 0.88 * easeInOut(progress), alpha: 0.75 + 0.25 * progress, glow: 1 - progress };
        // 完全に覆う(この間に写真を入れ替える)
        case 'veiled': return { spread: 1, alpha: 1, glow: 0 };
        // 右上へ引いていく
        case 'clearing': return { spread: 1 - easeInOut(progress), alpha: 1 - 0.55 * easeInOut(progress), glow: 0 };
        default: return { spread: 0, alpha: 0.45, glow: 0 };
      }
    }

    function drawFrame(nowMs = performance.now()) {
      const { width: w, height: h } = canvas;
      if (!w || !h) return;
      const time = nowMs / 1000;
      ctx.clearRect(0, 0, w, h);

      // 演出中でなければ、背景の絵の煙に沿ってゆるやかに漂わせるだけ
      if (!playStartMs) {
        for (const puff of puffs) {
          const float = Math.sin(time * puff.drift + puff.phase) * h * 0.012;
          drawPuff(puff, puff.restX, puff.restY + float, puff.restR, 0.16, time);
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
        return;
      }

      const { spread, alpha, glow } = smokeShape(name, progress);
      const boxX = w * BOX.x;
      const boxY = h * BOX.y;

      // 光は煙の下に置く(煙が広がるほど隠れていく)
      drawGlow(glow, time);

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
      if (reduceMotion) {
        onPhase('veiled', 0);
        onPhase('settled', 0);
        onPhase('done', 1);
        return;
      }
      playStartMs = performance.now();
      lastPhase = null;
    }

    function isPlaying() {
      return playStartMs !== 0;
    }

    return { canvas, reduceMotion, resize, start, stop, drawFrame, play, isPlaying };
  }

  global.createTamatebakoScene = createTamatebakoScene;
})(window);
