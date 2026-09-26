// 首屏那块信号面板的驱动。
//
// 画的是同一段声音的两次出现：左边是浏览器这头刚采到的波形，右边是那台
// Mac 的输入列表里 Remote Visio 的电平 —— 右边比左边晚几帧。产品要卖的就是
// 这个时间差本身，所以它是页面上唯一值得动起来的东西。
//
// 波形是合成的（页面上有标注），但用固定种子生成：每个访客看到的形状一样，
// 刷新也一样。随机噪声看着假，语音的"词—停顿—词"节奏才像人在说话。

(function () {
  const MINI = 8;        // 右侧迷你表柱数
  const DELAY = 7;       // 右侧滞后帧数，视觉上就是那 ~90ms
  const FPS = 30;        // 30fps 足够看，省一半电

  const meter = document.getElementById('meter');
  const mini = document.getElementById('mini');
  const readout = document.getElementById('readout');
  const rttEl = document.getElementById('rtt');
  if (!meter || !mini) return;

  // 柱子宽 3px、间距 2px 是写死在 CSS 里的，柱数按容器算 —— 波形要铺满，
  // 又不能因为窗口宽就把每根拉成胖柱子。
  const BARS = Math.max(16, Math.floor(meter.clientWidth / 5) || 48);

  const bars = [];
  for (let i = 0; i < BARS; i++) {
    const b = document.createElement('i');
    meter.appendChild(b);
    bars.push(b);
  }
  const minis = [];
  for (let i = 0; i < MINI; i++) {
    const b = document.createElement('i');
    mini.appendChild(b);
    minis.push(b);
  }

  // 确定性伪随机：同一个种子每次都长出同一段"话"。
  let seed = 20260817;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);

  // 合成一段语音包络：词（起音快、尾音收）夹着长短不一的停顿。
  const env = [];
  while (env.length < 340) {
    const words = 2 + Math.floor(rnd() * 3);
    for (let w = 0; w < words; w++) {
      const len = 10 + Math.floor(rnd() * 18);
      const peak = 0.45 + rnd() * 0.5;
      for (let i = 0; i < len; i++) {
        const t = i / len;
        // 起音 3 帧到顶，之后缓降；叠一层音节调制，免得每个词都是同一个包
        const shape = t < 0.12 ? t / 0.12 : Math.pow(1 - t, 0.65);
        const syl = 0.78 + 0.22 * Math.sin(t * Math.PI * (2 + rnd() * 3));
        env.push(Math.max(0, peak * shape * syl));
      }
      const gap = 2 + Math.floor(rnd() * 4);
      for (let i = 0; i < gap; i++) env.push(0.006 * rnd());
    }
    const pause = 7 + Math.floor(rnd() * 9);
    for (let i = 0; i < pause; i++) env.push(0.005 * rnd());
  }

  // 预填一屏：从空表长出来的头一秒像是产品没在工作，而它本该已经在说话了。
  const hist = [];
  const lead = BARS + DELAY + MINI;
  for (let i = 0; i < lead; i++) hist.push(env[i]);
  let cursor = lead;
  let lastRead = 0;
  let lastRtt = 0;

  const still = matchMedia('(prefers-reduced-motion: reduce)');

  function paint() {
    for (let i = 0; i < BARS; i++) {
      // 最新一帧画在最左边，波形因此向右推进 —— 和面板上"左发右收"的方向一致。
      // 颜色由 CSS 的固定渐变按高度给，这里只管高度。
      const v = hist[hist.length - 1 - i];
      bars[i].style.height = (2 + v * 74).toFixed(1) + 'px';
    }
    for (let i = 0; i < MINI; i++) {
      const v = hist[hist.length - 1 - DELAY - i] || 0;
      minis[i].style.height = (2 + v * 19).toFixed(1) + 'px';
    }
  }

  function tick(now) {
    const v = env[cursor % env.length];
    cursor++;
    hist.push(v);
    hist.shift();
    paint();

    // 读数每 200ms 刷一次：跟着帧率跳的数字没人读得出来
    if (now - lastRead > 200) {
      lastRead = now;
      const win = hist.slice(-6);
      const peak = Math.max(...win);
      readout.textContent = peak < 0.004 ? '−∞ dBFS' : (20 * Math.log10(peak)).toFixed(1).replace('-', '−') + ' dBFS';
    }
    // RTT 也慢慢浮动：一个纹丝不动的延迟数字反而不像真的链路
    if (rttEl && now - lastRtt > 1400) {
      lastRtt = now;
      rttEl.textContent = (86 + Math.floor(rnd() * 9)) + ' ms';
    }
  }

  if (still.matches) {
    // 不动版：给一帧有内容的波形，信息一样传达到，只是不跑循环
    for (let i = 0; i < hist.length; i++) hist[i] = env[i % env.length];
    paint();
    readout.textContent = '−12.4 dBFS';
    return;
  }

  let last = 0;
  let raf = 0;
  function loop(now) {
    raf = requestAnimationFrame(loop);
    if (now - last < 1000 / FPS) return;
    last = now;
    tick(now);
  }
  raf = requestAnimationFrame(loop);

  // 页面在后台就别烧 CPU 了
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      cancelAnimationFrame(raf);
      raf = 0;
    } else if (!raf) {
      raf = requestAnimationFrame(loop);
    }
  });
})();
