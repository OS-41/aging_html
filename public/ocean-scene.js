/*
 * 海中の演出をcanvasへ描く共有モジュール。
 *
 * 閲覧ブース(view.html)の待機演出と、撮影ブース(capture.html)の背景合成で
 * 同じ絵を使うために切り出してある。撮影した写真の中の世界と、
 * 会場の先で見る画面の世界を揃えるのが狙い。
 *
 *   const scene = createOceanScene(canvas, { theme: 'realistic' });
 *   scene.resize(1920, 1080);   // 描く大きさ(画面いっぱい / カメラのフレーム)
 *   scene.start();              // 自分でアニメーションを回す(閲覧ブース)
 *   scene.drawFrame(nowMs);     // 呼び出し側のループから1コマだけ描く(撮影ブース)
 *   scene.setTheme('storybook');
 *
 * prefers-reduced-motion が有効な環境では start() は静止した1枚だけを描く。
 */
(function (global) {
  'use strict';

  const OCEAN_THEMES = ['realistic', 'storybook', 'picturebook'];

  /**
   * @param {HTMLCanvasElement} canvas - 描画先
   * @param {{theme?: string}} [options]
   */
  function createOceanScene(canvas, options = {}) {
    const ctx = canvas.getContext('2d');
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    let theme = OCEAN_THEMES.includes(options.theme) ? options.theme : 'realistic';
    let bubbles = [];
    let shafts = [];
    let swimmers = [];
    let weeds = [];
    let nextSwimmerAt = 0;
    let lastFrameMs = performance.now();
    let running = false;

    /**
     * 描画する大きさを決め直す。閲覧ブースは画面いっぱい、撮影ブースは
     * カメラのフレームに合わせた大きさで呼ぶ。
     */
    function resize(width, height) {
      canvas.width = Math.max(1, Math.round(width));
      canvas.height = Math.max(1, Math.round(height));
      swimmers = [];

      bubbles = Array.from({ length: 48 }, () => ({
        x: Math.random() * canvas.width,
        y: Math.random() * canvas.height,
        r: 2 + Math.random() * 7,
        speed: 12 + Math.random() * 34,
        drift: 0.4 + Math.random() * 1.2,
        phase: Math.random() * Math.PI * 2
      }));

      shafts = Array.from({ length: 5 }, (_, i) => ({
        x: (canvas.width / 5) * i + Math.random() * 120,
        width: 90 + Math.random() * 150,
        sway: 40 + Math.random() * 70,
        speed: 0.12 + Math.random() * 0.16,
        phase: Math.random() * Math.PI * 2
      }));

      buildPicturebookElements();

      // 絵本風の海藻。根元を固定して左右に揺らす
      weeds = Array.from({ length: 14 }, () => ({
        x: Math.random() * canvas.width,
        height: canvas.height * (0.1 + Math.random() * 0.16),
        width: 14 + Math.random() * 18,
        sway: 0.25 + Math.random() * 0.4,
        phase: Math.random() * Math.PI * 2,
        color: Math.random() < 0.5 ? '#3fa87a' : '#2f8f6a'
      }));
    }

    /**
     * 画面を横切る水棲生物を1匹加える。
     */
    function spawnSwimmer() {
      const toRight = Math.random() < 0.5;
      const size = 26 + Math.random() * 46;
      const palette = ['#ff9a4d', '#ffd166', '#ef7d92', '#7fd1f0', '#b28bdc'];
      swimmers.push({
        x: toRight ? -size * 3 : canvas.width + size * 3,
        y: canvas.height * (0.15 + Math.random() * 0.6),
        size,
        dir: toRight ? 1 : -1,
        speed: (26 + Math.random() * 44) * (toRight ? 1 : -1),
        bob: 6 + Math.random() * 14,
        phase: Math.random() * Math.PI * 2,
        alpha: 0.28 + Math.random() * 0.3,
        color: palette[Math.floor(Math.random() * palette.length)]
      });
    }

    // ---- 絵柄1: 実際の海中に近いもの ----

    function drawSwimmerRealistic(swimmer, time) {
      const y = swimmer.y + Math.sin(time * 0.8 + swimmer.phase) * swimmer.bob;
      const s = swimmer.size;

      ctx.save();
      ctx.translate(swimmer.x, y);
      ctx.scale(swimmer.dir, 1);
      ctx.fillStyle = `rgba(6, 42, 64, ${swimmer.alpha})`;

      ctx.beginPath();
      ctx.ellipse(0, 0, s, s * 0.42, 0, 0, Math.PI * 2);
      ctx.fill();

      const tail = Math.sin(time * 5 + swimmer.phase) * s * 0.18;
      ctx.beginPath();
      ctx.moveTo(-s * 0.92, 0);
      ctx.lineTo(-s * 1.5, -s * 0.34 + tail);
      ctx.lineTo(-s * 1.5, s * 0.34 + tail);
      ctx.closePath();
      ctx.fill();

      ctx.restore();
    }

    function drawRealistic(time, dt) {
      const { width, height } = canvas;

      const water = ctx.createLinearGradient(0, 0, 0, height);
      water.addColorStop(0, '#0d4a6e');
      water.addColorStop(0.45, '#083b58');
      water.addColorStop(1, '#03141f');
      ctx.fillStyle = water;
      ctx.fillRect(0, 0, width, height);

      // 水面から差し込む光。左右に揺れて視界の揺らぎを作る
      for (const shaft of shafts) {
        const sway = Math.sin(time * shaft.speed + shaft.phase) * shaft.sway;
        const gradient = ctx.createLinearGradient(0, 0, 0, height);
        gradient.addColorStop(0, 'rgba(173, 226, 255, 0.20)');
        gradient.addColorStop(1, 'rgba(173, 226, 255, 0)');
        ctx.fillStyle = gradient;
        ctx.beginPath();
        ctx.moveTo(shaft.x + sway, 0);
        ctx.lineTo(shaft.x + sway + shaft.width, 0);
        ctx.lineTo(shaft.x + sway * 2.4 + shaft.width * 1.7, height);
        ctx.lineTo(shaft.x + sway * 2.4 - shaft.width * 0.3, height);
        ctx.closePath();
        ctx.fill();
      }

      for (const bubble of bubbles) {
        const x = bubble.x + Math.sin(time * bubble.drift + bubble.phase) * 14;
        ctx.beginPath();
        ctx.arc(x, bubble.y, bubble.r, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(200, 236, 255, 0.13)';
        ctx.fill();
        ctx.beginPath();
        ctx.arc(x - bubble.r * 0.3, bubble.y - bubble.r * 0.3, bubble.r * 0.32, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255, 255, 255, 0.28)';
        ctx.fill();
      }

      for (const swimmer of swimmers) {
        drawSwimmerRealistic(swimmer, time);
      }
    }

    // ---- 絵柄2: 童話の絵本のようにデフォルメしたもの ----
    // 陰影や遠近をつけず、太い輪郭線とはっきりした色面だけで描く。

    const STORY_OUTLINE = '#123b52';

    function outlined(drawPath, fill, lineWidth = 5) {
      ctx.beginPath();
      drawPath();
      ctx.fillStyle = fill;
      ctx.fill();
      ctx.lineWidth = lineWidth;
      ctx.strokeStyle = STORY_OUTLINE;
      ctx.stroke();
    }

    /**
     * 目が大きく、輪郭線の太い魚。絵本の挿絵のような見た目にする。
     */
    function drawSwimmerStorybook(swimmer, time) {
      const y = swimmer.y + Math.sin(time * 1.4 + swimmer.phase) * swimmer.bob;
      const s = swimmer.size;

      ctx.save();
      ctx.translate(swimmer.x, y);
      ctx.scale(swimmer.dir, 1);
      ctx.lineJoin = 'round';

      // 尾びれ(大きく振る)
      const tail = Math.sin(time * 4 + swimmer.phase) * s * 0.3;
      outlined(() => {
        ctx.moveTo(-s * 0.7, 0);
        ctx.lineTo(-s * 1.6, -s * 0.6 + tail);
        ctx.lineTo(-s * 1.3, 0);
        ctx.lineTo(-s * 1.6, s * 0.6 + tail);
        ctx.closePath();
      }, swimmer.color);

      // 背びれ
      outlined(() => {
        ctx.moveTo(-s * 0.2, -s * 0.5);
        ctx.quadraticCurveTo(0, -s * 1.05, s * 0.35, -s * 0.42);
        ctx.closePath();
      }, swimmer.color);

      // 胴体(丸みの強い楕円)
      outlined(() => {
        ctx.ellipse(0, 0, s, s * 0.62, 0, 0, Math.PI * 2);
      }, swimmer.color, 6);

      // ほお
      ctx.beginPath();
      ctx.arc(s * 0.3, s * 0.2, s * 0.15, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255, 255, 255, 0.45)';
      ctx.fill();

      // 大きな目
      outlined(() => {
        ctx.arc(s * 0.45, -s * 0.14, s * 0.26, 0, Math.PI * 2);
      }, '#ffffff', 4);
      ctx.beginPath();
      ctx.arc(s * 0.52, -s * 0.14, s * 0.12, 0, Math.PI * 2);
      ctx.fillStyle = STORY_OUTLINE;
      ctx.fill();

      // 口
      ctx.beginPath();
      ctx.arc(s * 0.82, s * 0.12, s * 0.16, Math.PI * 0.85, Math.PI * 1.75);
      ctx.lineWidth = 4;
      ctx.strokeStyle = STORY_OUTLINE;
      ctx.stroke();

      ctx.restore();
    }

    function drawStorybook(time, dt) {
      const { width, height } = canvas;

      // 空気の層と海。段階を分けて塗り、グラデーションに頼らない
      ctx.fillStyle = '#8fd6ef';
      ctx.fillRect(0, 0, width, height * 0.16);
      ctx.fillStyle = '#49b3dd';
      ctx.fillRect(0, height * 0.16, width, height * 0.3);
      ctx.fillStyle = '#2f92c4';
      ctx.fillRect(0, height * 0.46, width, height * 0.54);

      // うねる水面
      const waveY = height * 0.16;
      ctx.beginPath();
      ctx.moveTo(0, waveY);
      for (let x = 0; x <= width; x += 20) {
        ctx.lineTo(x, waveY + Math.sin(x / 90 + time * 1.1) * 12);
      }
      ctx.lineTo(width, 0);
      ctx.lineTo(0, 0);
      ctx.closePath();
      ctx.fillStyle = '#8fd6ef';
      ctx.fill();
      ctx.lineWidth = 6;
      ctx.strokeStyle = '#ffffff';
      ctx.stroke();

      // 海底の砂
      const sandY = height * 0.82;
      ctx.beginPath();
      ctx.moveTo(0, height);
      ctx.lineTo(0, sandY);
      for (let x = 0; x <= width; x += 60) {
        ctx.quadraticCurveTo(x + 30, sandY - 26, x + 60, sandY);
      }
      ctx.lineTo(width, height);
      ctx.closePath();
      ctx.fillStyle = '#f5dda3';
      ctx.fill();
      ctx.lineWidth = 6;
      ctx.strokeStyle = STORY_OUTLINE;
      ctx.stroke();

      // ゆらゆら揺れる海藻
      ctx.lineCap = 'round';
      for (const weed of weeds) {
        const lean = Math.sin(time * weed.sway + weed.phase) * 26;
        ctx.beginPath();
        ctx.moveTo(weed.x, sandY + 10);
        ctx.quadraticCurveTo(
          weed.x + lean, sandY - weed.height * 0.6,
          weed.x + lean * 1.6, sandY - weed.height
        );
        // 輪郭を先に太く描き、その上に色を重ねる
        ctx.lineWidth = weed.width + 8;
        ctx.strokeStyle = STORY_OUTLINE;
        ctx.stroke();
        ctx.lineWidth = weed.width;
        ctx.strokeStyle = weed.color;
        ctx.stroke();
      }

      // ころんとした気泡
      for (const bubble of bubbles) {
        const r = bubble.r * 1.9;
        const x = bubble.x + Math.sin(time * bubble.drift + bubble.phase) * 18;
        ctx.beginPath();
        ctx.arc(x, bubble.y, r, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255, 255, 255, 0.35)';
        ctx.fill();
        ctx.lineWidth = 3;
        ctx.strokeStyle = '#ffffff';
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(x - r * 0.32, bubble.y - r * 0.32, r * 0.2, 0, Math.PI * 2);
        ctx.fillStyle = '#ffffff';
        ctx.fill();
      }

      for (const swimmer of swimmers) {
        drawSwimmerStorybook(swimmer, time);
      }
    }

    // ---- 絵柄3: 水彩の絵本のような額縁 ----
    // 中央を白く空け、縁に生き物と珊瑚を配した構図。輪郭線は使わず、
    // にじみを重ねた淡い色面でやわらかく描く。
    // 動かない飾り(砂・珊瑚・貝)は一度だけ別canvasに描いて使い回す。

    const PB = {
      paper: '#f4fbff',
      wash: '#dcf0fb',
      washDeep: '#bfe4f7',
      whale: '#5b9fd8',
      whaleBelly: '#e8f4fc',
      turtle: '#6cbf72',
      turtleShell: '#3f9159',
      clown: '#f68a3c',
      tang: '#f6cf4e',
      seahorse: '#f18fb6',
      crab: '#e8553f',
      star: '#ef6a6a',
      starGold: '#f6c84a',
      coral: '#f78e5c',
      tube: '#c07ad8',
      kelpA: '#4fae88',
      kelpB: '#2f8f7a',
      kelpC: '#49b6c8',
      kelpD: '#9182d8',
      sand: '#f7e6bd',
      cheek: '#f6a8b8',
      ink: '#3d5a6c'
    };

    let pbLayer = null;
    let pbSwimmers = [];
    let pbKelps = [];

    /**
     * にじみを表現する。ぼかした下地の上に本体を重ねる。
     */
    function pbSoft(ctx, drawPath, color, alpha = 0.9, blur = 10) {
      ctx.save();
      ctx.filter = `blur(${blur}px)`;
      ctx.globalAlpha = alpha * 0.55;
      ctx.fillStyle = color;
      ctx.beginPath();
      drawPath(ctx);
      ctx.fill();
      ctx.restore();

      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.fillStyle = color;
      ctx.beginPath();
      drawPath(ctx);
      ctx.fill();
      ctx.restore();
    }

    /**
     * 目・ほお・口。どの生き物にも同じ描き方で付ける。
     */
    function pbFace(ctx, x, y, scale, { blush = true, smile = true } = {}) {
      ctx.fillStyle = PB.ink;
      ctx.beginPath();
      ctx.arc(x, y, 2.6 * scale, 0, Math.PI * 2);
      ctx.fill();

      if (blush) {
        ctx.globalAlpha = 0.4;
        ctx.fillStyle = PB.cheek;
        ctx.beginPath();
        ctx.arc(x + 1.2 * scale, y + 4.5 * scale, 2.4 * scale, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
      }

      if (smile) {
        ctx.strokeStyle = PB.ink;
        ctx.lineWidth = 1.6 * scale;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.arc(x + 3 * scale, y + 2.6 * scale, 3 * scale, 0.15 * Math.PI, 0.75 * Math.PI);
        ctx.stroke();
      }
    }

    function pbKelp(ctx, kelp, time) {
      const lean = Math.sin(time * kelp.sway + kelp.phase) * kelp.amp;
      ctx.save();
      ctx.lineCap = 'round';
      for (let i = 0; i < 3; i++) {
        const spread = (i - 1) * kelp.width * 0.9;
        ctx.globalAlpha = 0.75;
        ctx.strokeStyle = kelp.color;
        ctx.lineWidth = kelp.width * (1 - i * 0.18);
        ctx.beginPath();
        ctx.moveTo(kelp.x + spread, kelp.baseY);
        ctx.quadraticCurveTo(
          kelp.x + spread + lean * 0.6, kelp.baseY - kelp.height * 0.55,
          kelp.x + spread + lean * 1.5, kelp.baseY - kelp.height * (0.85 + i * 0.08)
        );
        ctx.stroke();
      }
      ctx.restore();
    }

    function pbWhale(ctx, x, y, s, time) {
      const bob = Math.sin(time * 0.7) * s * 0.08;
      ctx.save();
      ctx.translate(x, y + bob);
      ctx.rotate(Math.sin(time * 0.5) * 0.05);

      // 尾びれ
      pbSoft(ctx, (c) => {
        c.moveTo(-s * 0.85, 0);
        c.quadraticCurveTo(-s * 1.5, -s * 0.5, -s * 1.15, -s * 0.62);
        c.quadraticCurveTo(-s * 0.95, -s * 0.3, -s * 0.9, 0);
        c.quadraticCurveTo(-s * 1.0, s * 0.3, -s * 1.2, s * 0.5);
        c.quadraticCurveTo(-s * 1.4, s * 0.3, -s * 0.85, 0);
        c.closePath();
      }, PB.whale, 0.9, 8);

      // 胴体
      pbSoft(ctx, (c) => {
        c.ellipse(0, 0, s, s * 0.62, 0, 0, Math.PI * 2);
      }, PB.whale, 0.92, 12);

      // おなか(下半分だけ白くする)
      ctx.save();
      ctx.beginPath();
      ctx.ellipse(0, 0, s * 0.98, s * 0.6, 0, 0, Math.PI * 2);
      ctx.clip();
      pbSoft(ctx, (c) => {
        c.ellipse(s * 0.1, s * 0.45, s * 0.7, s * 0.3, 0, 0, Math.PI * 2);
      }, PB.whaleBelly, 0.9, 5);

      // おなかの筋(短く控えめに)
      ctx.strokeStyle = 'rgba(91, 159, 216, 0.35)';
      ctx.lineWidth = s * 0.02;
      for (let i = 0; i < 4; i++) {
        ctx.beginPath();
        ctx.moveTo(s * (0.0 + i * 0.15), s * 0.34);
        ctx.lineTo(s * (-0.02 + i * 0.15), s * 0.54);
        ctx.stroke();
      }
      ctx.restore();

      // 背中側を少し濃くして立体感を出す
      ctx.save();
      ctx.beginPath();
      ctx.ellipse(0, 0, s * 0.98, s * 0.6, 0, 0, Math.PI * 2);
      ctx.clip();
      ctx.globalAlpha = 0.25;
      ctx.fillStyle = '#3f7fbe';
      ctx.beginPath();
      ctx.ellipse(-s * 0.1, -s * 0.5, s * 0.9, s * 0.4, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();

      // 胸びれ
      pbSoft(ctx, (c) => {
        c.ellipse(-s * 0.05, s * 0.3, s * 0.26, s * 0.12, 0.6 + Math.sin(time * 1.6) * 0.15, 0, Math.PI * 2);
      }, PB.whale, 0.85, 5);

      // 潮吹き
      ctx.globalAlpha = 0.55;
      ctx.fillStyle = '#d7eefb';
      for (let i = 0; i < 6; i++) {
        const p = (time * 0.6 + i / 6) % 1;
        const r = s * (0.06 + p * 0.05);
        ctx.beginPath();
        ctx.arc(s * 0.35 + Math.sin(i * 2.1) * s * 0.18 * p, -s * (0.55 + p * 0.7), r, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;

      pbFace(ctx, s * 0.55, -s * 0.16, s / 24);
      ctx.restore();
    }

    function pbTurtle(ctx, x, y, s, time) {
      const paddle = Math.sin(time * 1.6) * 0.25;
      ctx.save();
      ctx.translate(x, y + Math.sin(time * 0.8) * s * 0.08);

      // ひれ(甲羅の外まではっきり出す)
      for (const [fx, fy, rot] of [[-s * 0.85, -s * 0.55, -0.7], [-s * 0.85, s * 0.55, 0.7], [s * 0.7, -s * 0.6, 0.7], [s * 0.7, s * 0.6, -0.7]]) {
        pbSoft(ctx, (c) => {
          c.ellipse(fx, fy, s * 0.46, s * 0.2, rot + paddle * (fy < 0 ? -1 : 1), 0, Math.PI * 2);
        }, '#9ad17e', 0.9, 5);
      }

      // しっぽ
      pbSoft(ctx, (c) => {
        c.ellipse(-s * 1.05, 0, s * 0.16, s * 0.1, 0, 0, Math.PI * 2);
      }, '#9ad17e', 0.85, 4);

      // 頭
      pbSoft(ctx, (c) => {
        c.ellipse(s * 1.08, 0, s * 0.34, s * 0.28, 0, 0, Math.PI * 2);
      }, '#9ad17e', 0.92, 5);

      // 甲羅(ひれが見えるよう少し小さめに)
      pbSoft(ctx, (c) => {
        c.ellipse(0, 0, s * 0.88, s * 0.7, 0, 0, Math.PI * 2);
      }, '#7fc97f', 0.95, 8);
      pbSoft(ctx, (c) => {
        c.ellipse(0, 0, s * 0.68, s * 0.54, 0, 0, Math.PI * 2);
      }, PB.turtle, 0.9, 6);

      // 甲羅の模様
      ctx.globalAlpha = 0.55;
      ctx.fillStyle = PB.turtleShell;
      for (const [px, py, pr] of [[0, 0, 0.2], [-s * 0.38, -s * 0.06, 0.14], [s * 0.36, -s * 0.06, 0.14], [-s * 0.16, -s * 0.34, 0.13], [s * 0.18, s * 0.32, 0.13], [-s * 0.18, s * 0.34, 0.12]]) {
        ctx.beginPath();
        ctx.ellipse(px, py, s * pr, s * pr * 0.85, 0, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;

      pbFace(ctx, s * 1.2, -s * 0.06, s / 26);
      ctx.restore();
    }

    function pbFish(ctx, x, y, s, dir, color, time, phase, striped) {
      ctx.save();
      ctx.translate(x, y + Math.sin(time * 1.5 + phase) * s * 0.25);
      ctx.scale(dir, 1);

      const tail = Math.sin(time * 4 + phase) * s * 0.25;
      pbSoft(ctx, (c) => {
        c.moveTo(-s * 0.7, 0);
        c.lineTo(-s * 1.35, -s * 0.5 + tail);
        c.lineTo(-s * 1.35, s * 0.5 + tail);
        c.closePath();
      }, color, 0.85, 6);

      pbSoft(ctx, (c) => {
        c.ellipse(0, 0, s, s * 0.66, 0, 0, Math.PI * 2);
      }, color, 0.92, 8);

      if (striped) {
        // カクレクマノミの白い帯
        ctx.globalAlpha = 0.9;
        ctx.fillStyle = '#ffffff';
        for (const bx of [-s * 0.35, s * 0.25]) {
          ctx.beginPath();
          ctx.ellipse(bx, 0, s * 0.14, s * 0.62, 0.1, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.globalAlpha = 1;
      }

      pbFace(ctx, s * 0.5, -s * 0.12, s / 18, { smile: false });
      ctx.restore();
    }

    function pbSeahorse(ctx, x, y, s, time) {
      ctx.save();
      ctx.translate(x, y + Math.sin(time * 0.9) * s * 0.18);
      ctx.rotate(Math.sin(time * 0.6) * 0.08);

      pbSoft(ctx, (c) => {
        c.moveTo(0, -s);
        c.quadraticCurveTo(s * 0.7, -s * 0.75, s * 0.42, -s * 0.2);
        c.quadraticCurveTo(s * 0.1, s * 0.35, s * 0.3, s * 0.75);
        c.quadraticCurveTo(s * 0.55, s * 1.05, s * 0.05, s * 0.95);
        c.quadraticCurveTo(-s * 0.3, s * 0.6, -s * 0.2, s * 0.1);
        c.quadraticCurveTo(-s * 0.4, -s * 0.6, 0, -s);
        c.closePath();
      }, PB.seahorse, 0.9, 8);

      pbFace(ctx, s * 0.18, -s * 0.62, s / 34, { smile: false });
      ctx.restore();
    }

    function pbCrab(ctx, x, y, s, time) {
      const step = Math.sin(time * 2.2) * s * 0.12;
      ctx.save();
      ctx.translate(x + step, y);

      // 脚
      ctx.strokeStyle = PB.crab;
      ctx.lineWidth = s * 0.1;
      ctx.lineCap = 'round';
      for (let i = 0; i < 3; i++) {
        const ly = s * (0.1 + i * 0.22);
        const wiggle = Math.sin(time * 4 + i) * s * 0.06;
        for (const sign of [-1, 1]) {
          ctx.beginPath();
          ctx.moveTo(sign * s * 0.6, ly - s * 0.2);
          ctx.quadraticCurveTo(sign * s * (1 + i * 0.1), ly + wiggle, sign * s * (1.1 + i * 0.05), ly + s * 0.3);
          ctx.stroke();
        }
      }

      // はさみ
      for (const sign of [-1, 1]) {
        const claw = Math.sin(time * 3 + (sign > 0 ? 0 : 1)) * 0.2;
        pbSoft(ctx, (c) => {
          c.ellipse(sign * s * 1.25, -s * 0.45, s * 0.34, s * 0.26, claw * sign, 0, Math.PI * 2);
        }, PB.crab, 0.9, 5);
      }

      // 甲羅
      pbSoft(ctx, (c) => {
        c.ellipse(0, 0, s, s * 0.7, 0, 0, Math.PI * 2);
      }, PB.crab, 0.92, 8);

      // 目
      for (const sign of [-1, 1]) {
        ctx.strokeStyle = PB.crab;
        ctx.lineWidth = s * 0.09;
        ctx.beginPath();
        ctx.moveTo(sign * s * 0.3, -s * 0.5);
        ctx.lineTo(sign * s * 0.32, -s * 0.85);
        ctx.stroke();
        ctx.fillStyle = PB.ink;
        ctx.beginPath();
        ctx.arc(sign * s * 0.32, -s * 0.92, s * 0.1, 0, Math.PI * 2);
        ctx.fill();
      }

      ctx.strokeStyle = PB.ink;
      ctx.lineWidth = s * 0.06;
      ctx.beginPath();
      ctx.arc(0, -s * 0.05, s * 0.28, 0.15 * Math.PI, 0.85 * Math.PI);
      ctx.stroke();

      ctx.restore();
    }

    /**
     * 動かない飾りを1枚に焼き付ける。resize時だけ描き直す。
     */
    function buildPicturebookLayer(width, height) {
      const layer = document.createElement('canvas');
      layer.width = width;
      layer.height = height;
      const ctx = layer.getContext('2d');

      // 紙のような下地と、縁のにじみ
      ctx.fillStyle = PB.paper;
      ctx.fillRect(0, 0, width, height);

      ctx.save();
      ctx.filter = 'blur(60px)';
      ctx.globalAlpha = 0.85;
      ctx.fillStyle = PB.wash;
      ctx.fillRect(0, 0, width, height * 0.3);
      ctx.fillRect(0, height * 0.72, width, height * 0.28);
      ctx.fillRect(0, 0, width * 0.22, height);
      ctx.fillRect(width * 0.78, 0, width * 0.22, height);
      ctx.fillStyle = PB.washDeep;
      ctx.globalAlpha = 0.5;
      ctx.fillRect(0, 0, width * 0.1, height);
      ctx.fillRect(width * 0.9, 0, width * 0.1, height);
      ctx.restore();

      // 中央は白く空ける
      ctx.save();
      ctx.filter = 'blur(45px)';
      ctx.fillStyle = PB.paper;
      ctx.beginPath();
      ctx.ellipse(width / 2, height / 2, width * 0.36, height * 0.34, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();

      // 砂地
      const sandY = height * 0.88;
      ctx.save();
      ctx.filter = 'blur(6px)';
      ctx.globalAlpha = 0.9;
      ctx.fillStyle = PB.sand;
      ctx.beginPath();
      ctx.moveTo(0, height);
      ctx.lineTo(0, sandY);
      for (let x = 0; x <= width; x += 120) {
        ctx.quadraticCurveTo(x + 60, sandY - 34, x + 120, sandY - (x % 240 === 0 ? 0 : 12));
      }
      ctx.lineTo(width, height);
      ctx.closePath();
      ctx.fill();
      ctx.restore();

      const s = Math.min(width, height);

      // 珊瑚(左右の下)
      const drawCoralFan = (x, y, size, color) => {
        ctx.save();
        ctx.strokeStyle = color;
        ctx.lineCap = 'round';
        ctx.globalAlpha = 0.85;
        for (let i = -3; i <= 3; i++) {
          ctx.lineWidth = size * 0.1;
          ctx.beginPath();
          ctx.moveTo(x, y);
          ctx.quadraticCurveTo(x + i * size * 0.16, y - size * 0.5, x + i * size * 0.3, y - size);
          ctx.stroke();
        }
        ctx.restore();
      };
      drawCoralFan(width * 0.86, sandY, s * 0.1, PB.coral);
      drawCoralFan(width * 0.07, sandY, s * 0.08, PB.coral);

      // 筒状の珊瑚
      ctx.save();
      ctx.globalAlpha = 0.85;
      for (let i = 0; i < 4; i++) {
        const cx = width * 0.93 + (i - 1.5) * s * 0.035;
        const ch = s * (0.1 + (i % 2) * 0.05);
        ctx.fillStyle = i % 2 ? PB.tube : '#d68fe8';
        ctx.beginPath();
        ctx.roundRect(cx - s * 0.018, sandY - ch, s * 0.036, ch, s * 0.018);
        ctx.fill();
      }
      ctx.restore();

      // ヒトデ
      const drawStar = (x, y, r, color) => {
        ctx.save();
        ctx.translate(x, y);
        ctx.globalAlpha = 0.9;
        ctx.fillStyle = color;
        ctx.beginPath();
        for (let i = 0; i < 5; i++) {
          const a = (i / 5) * Math.PI * 2 - Math.PI / 2;
          const a2 = a + Math.PI / 5;
          ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);
          ctx.quadraticCurveTo(Math.cos(a2) * r * 0.45, Math.sin(a2) * r * 0.45, Math.cos(a2) * r * 0.42, Math.sin(a2) * r * 0.42);
        }
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      };
      drawStar(width * 0.045, sandY - s * 0.02, s * 0.045, PB.star);
      drawStar(width * 0.055, height * 0.06, s * 0.03, PB.starGold);

      // 貝
      ctx.save();
      ctx.globalAlpha = 0.9;
      ctx.fillStyle = '#f7b9cd';
      ctx.beginPath();
      ctx.arc(width * 0.13, sandY + s * 0.005, s * 0.032, Math.PI, 0);
      ctx.fill();
      ctx.strokeStyle = '#e88fae';
      ctx.lineWidth = s * 0.004;
      for (let i = -2; i <= 2; i++) {
        ctx.beginPath();
        ctx.moveTo(width * 0.13, sandY + s * 0.005);
        ctx.lineTo(width * 0.13 + i * s * 0.012, sandY - s * 0.027);
        ctx.stroke();
      }
      ctx.restore();

      return layer;
    }

    /**
     * 額縁の飾りと、縁を泳ぐ魚の配置を画面の大きさに合わせて組み立てる。
     */
    function buildPicturebookElements() {
      const { width, height } = canvas;
      const s = Math.min(width, height);
      pbLayer = buildPicturebookLayer(width, height);

      const sandY = height * 0.88;
      pbKelps = [
        { x: width * 0.03, baseY: sandY + 10, height: height * 0.42, width: s * 0.022, color: PB.kelpA, sway: 0.5, amp: 18, phase: 0 },
        { x: width * 0.09, baseY: sandY + 10, height: height * 0.3, width: s * 0.018, color: PB.kelpC, sway: 0.42, amp: 22, phase: 1.2 },
        { x: width * 0.16, baseY: sandY + 10, height: height * 0.22, width: s * 0.016, color: PB.kelpD, sway: 0.6, amp: 14, phase: 2.4 },
        { x: width * 0.97, baseY: sandY + 10, height: height * 0.44, width: s * 0.022, color: PB.kelpB, sway: 0.46, amp: 20, phase: 0.7 },
        { x: width * 0.91, baseY: sandY + 10, height: height * 0.3, width: s * 0.018, color: PB.kelpA, sway: 0.55, amp: 16, phase: 1.9 },
        { x: width * 0.82, baseY: sandY + 10, height: height * 0.2, width: s * 0.015, color: PB.kelpC, sway: 0.5, amp: 18, phase: 3.1 }
      ];

      // 縁に沿ってゆっくり行き来する魚
      pbSwimmers = [
        { baseX: width * 0.1, y: height * 0.42, range: width * 0.05, size: s * 0.028, speed: 0.4, phase: 0, color: PB.clown, striped: true },
        { baseX: width * 0.14, y: height * 0.55, range: width * 0.05, size: s * 0.024, speed: 0.34, phase: 2.2, color: PB.clown, striped: true },
        { baseX: width * 0.89, y: height * 0.38, range: width * 0.05, size: s * 0.026, speed: 0.38, phase: 1.1, color: PB.tang, striped: false },
        { baseX: width * 0.5, y: height * 0.05, range: width * 0.12, size: s * 0.02, speed: 0.3, phase: 3.4, color: '#7fc6e8', striped: false },
        { baseX: width * 0.72, y: height * 0.95, range: width * 0.08, size: s * 0.022, speed: 0.36, phase: 0.6, color: PB.tang, striped: false }
      ];
    }

    function drawPicturebook(time, dt) {
      const { width, height } = canvas;
      if (pbLayer) {
        ctx.drawImage(pbLayer, 0, 0);
      }

      // 海藻(左右)
      for (const kelp of pbKelps) {
        pbKelp(ctx, kelp, time);
      }

      // 上をたゆたう点線(絵本の余白にある道しるべ)
      ctx.save();
      ctx.strokeStyle = '#8fc9e8';
      ctx.lineWidth = 3;
      ctx.setLineDash([10, 14]);
      ctx.lineDashOffset = -time * 24;
      ctx.beginPath();
      ctx.moveTo(width * 0.2, height * 0.1);
      ctx.bezierCurveTo(width * 0.4, height * 0.02, width * 0.6, height * 0.16, width * 0.82, height * 0.07);
      ctx.stroke();
      ctx.restore();

      // 額縁に配した生き物
      const s = Math.min(width, height);
      pbWhale(ctx, width * 0.12, height * 0.16, s * 0.11, time);
      pbTurtle(ctx, width * 0.88, height * 0.13, s * 0.075, time);
      pbSeahorse(ctx, width * 0.955, height * 0.52, s * 0.055, time);
      pbCrab(ctx, width * 0.14, height * 0.93, s * 0.05, time);

      for (const fish of pbSwimmers) {
        const x = fish.baseX + Math.sin(time * fish.speed + fish.phase) * fish.range;
        const dir = Math.cos(time * fish.speed + fish.phase) >= 0 ? 1 : -1;
        pbFish(ctx, x, fish.y, fish.size, dir, fish.color, time, fish.phase, fish.striped);
      }

      // 気泡
      for (const bubble of bubbles) {
        const r = bubble.r * 1.5;
        const x = bubble.x + Math.sin(time * bubble.drift + bubble.phase) * 16;
        ctx.beginPath();
        ctx.arc(x, bubble.y, r, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255, 255, 255, 0.6)';
        ctx.fill();
        ctx.lineWidth = 1.6;
        ctx.strokeStyle = 'rgba(143, 201, 232, 0.8)';
        ctx.stroke();
      }
    }

    const themes = { realistic: drawRealistic, storybook: drawStorybook, picturebook: drawPicturebook };

    /**
     * 気泡や生き物の位置を進める。絵柄によらず共通。
     */
    function step(nowMs, dt) {
      const { width, height } = canvas;

      for (const bubble of bubbles) {
        bubble.y -= bubble.speed * dt;
        if (bubble.y < -bubble.r * 4) {
          bubble.y = height + bubble.r * 4;
          bubble.x = Math.random() * width;
        }
      }
      if (nowMs > nextSwimmerAt) {
        spawnSwimmer();
        nextSwimmerAt = nowMs + 4000 + Math.random() * 9000;
      }
      for (const swimmer of swimmers) {
        swimmer.x += swimmer.speed * dt;
      }
      swimmers = swimmers.filter((s) => s.x > -width * 0.3 && s.x < width * 1.3);
    }

    /**
     * 1コマ描く。撮影ブースは自前の合成ループからこれを直接呼ぶ。
     */
    function drawFrame(nowMs = performance.now()) {
      if (!canvas.width || !canvas.height) return;
      const dt = Math.min((nowMs - lastFrameMs) / 1000, 0.1);
      lastFrameMs = nowMs;
      step(nowMs, dt);
      (themes[theme] || drawRealistic)(nowMs / 1000, dt);
    }

    function loop(nowMs) {
      if (!running) return;
      drawFrame(nowMs);
      requestAnimationFrame(loop);
    }

    /**
     * このシーン自身でアニメーションを回す。
     */
    function start() {
      if (running) return;
      if (reduceMotion) {
        // 動きを抑える設定のときは静止した1枚だけ描く
        drawFrame(performance.now());
        return;
      }
      running = true;
      lastFrameMs = performance.now();
      requestAnimationFrame(loop);
    }

    function stop() {
      running = false;
    }

    /**
     * 絵柄を切り替える。変わったときだけtrueを返す。
     */
    function setTheme(next) {
      if (!next || next === theme || !themes[next]) return false;
      theme = next;
      if (!running) {
        // 静止表示・外部ループのときは即座に描き直す
        drawFrame(performance.now());
      }
      return true;
    }

    return {
      canvas,
      reduceMotion,
      resize,
      start,
      stop,
      drawFrame,
      setTheme,
      get theme() { return theme; }
    };
  }

  global.OCEAN_THEMES = OCEAN_THEMES;
  global.createOceanScene = createOceanScene;
})(window);
