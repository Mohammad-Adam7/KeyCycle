/* KeyCycle landing page: a scroll-driven, three.js story of the key's life.
   It only starts when the page is shown to a visitor who is not signed in, and it stops for good
   when they sign in. Everything it touches lives inside #landing. */
window.KCLanding = (() => {
  const api = { started: false, running: false, keyHidden: false, paused: false };
  api.start = () => {
  if (api.started) return;
  api.started = true; api.running = true;
  const RM = matchMedia('(prefers-reduced-motion: reduce)').matches;
  gsap.registerPlugin(ScrollTrigger);
  const ROOT = document.getElementById('landing');
  const $ = (s, r = ROOT) => r.querySelector(s);
  const $$ = (s, r = ROOT) => Array.from(r.querySelectorAll(s));
  const mobile = () => innerWidth <= 820;

  /* ---------- clip wrappers for section transitions ---------- */
  $$('main > .panel').forEach(panel => {
    const line = $(':scope > .horizon', panel);
    if (!line) return;
    const wrap = document.createElement('div'); wrap.className = 'clipwrap';
    Array.from(panel.children).forEach(ch => { if (ch !== line) wrap.appendChild(ch); });
    panel.appendChild(wrap);
  });

  /* ---------- text splitting ---------- */
  $$('[data-split]').forEach(el => {
    const mode = el.dataset.split;
    const text = el.textContent.trim().replace(/\s+/g, ' ');
    el.textContent = '';
    const sr = document.createElement('span'); sr.className = 'sr'; sr.textContent = text; el.appendChild(sr);
    const parts = [];
    text.split(' ').forEach((word, i, arr) => {
      const w = document.createElement('span'); w.className = 'w'; w.setAttribute('aria-hidden', 'true');
      if (mode === 'chars') { for (const ch of word) { const c = document.createElement('span'); c.className = 'c'; c.textContent = ch; w.appendChild(c); parts.push(c); } }
      else { w.textContent = word; parts.push(w); }
      el.appendChild(w);
      if (i < arr.length - 1) el.appendChild(document.createTextNode(' '));
    });
    el._parts = parts;
    el._mode = mode;
  });
  const charsFrom = { opacity: 0, yPercent: 55, rotate: -10, filter: 'blur(6px)' };
  const wordsFrom = { opacity: 0, y: 14, filter: 'blur(8px)' };
  const reveal = (tl, el, at, dur = 1.2) => {
    if (!el || !el._parts) return;
    const chars = el._mode === 'chars';
    tl.from(el._parts, { ...(chars ? charsFrom : wordsFrom), duration: dur, ease: chars ? 'expo.out' : 'power3.out',
      stagger: { amount: chars ? dur * 0.45 : dur * 0.55 } }, at);
  };

  /* ---------- three.js stage ---------- */
  const canvas = $('#lp-stage');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.outputEncoding = THREE.sRGBEncoding;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(35, innerWidth / innerHeight, 0.1, 100);
  camera.position.set(0, 0, 12);

  // studio environment for the metal
  const pmrem = new THREE.PMREMGenerator(renderer);
  const env = new THREE.Scene();
  const sg = new THREE.SphereGeometry(20, 32, 16);
  const cols = [], pa = sg.attributes.position, lo = new THREE.Color(0x0b0e11), hi = new THREE.Color(0x2c4c76);
  for (let i = 0; i < pa.count; i++) { const t = (pa.getY(i) / 20 + 1) / 2; const c = lo.clone().lerp(hi, t); cols.push(c.r, c.g, c.b); }
  sg.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
  env.add(new THREE.Mesh(sg, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide })));
  const softbox = (x, y, z, w, h, k) => { const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: new THREE.Color(k, k * 0.93, k * 0.82), side: THREE.DoubleSide })); m.position.set(x, y, z); m.lookAt(0, 0, 0); env.add(m); };
  softbox(0, 9, 5, 12, 4, 3.2); softbox(-11, 2, 3, 4, 9, 1.6); softbox(10, -3, 6, 3, 9, 1.2); softbox(0, -6, 10, 10, 2, 0.6);
  scene.environment = pmrem.fromScene(env, 0.04).texture;
  scene.add(new THREE.AmbientLight(0xffffff, 0.15));
  const sun = new THREE.DirectionalLight(0xeaedf1, 1.4); sun.position.set(-4, 6, 8); scene.add(sun);

  const REDDK = new THREE.Color(0x1f3a5c).convertSRGBToLinear(), BRASS = new THREE.Color(0x6d8db7), DULL = new THREE.Color(0x7d8287), GLOW = new THREE.Color(0x86a0c3), RED = new THREE.Color(0xd6452f);
  const brass = new THREE.MeshStandardMaterial({ color: BRASS.clone(), metalness: 1, roughness: 0.26, envMapIntensity: 1.25 });

  // key, built from primitives, centred on its length
  const key = new THREE.Group(); key.rotation.order = 'YXZ';
  const add = (parent, geo, mat, x, y, z, rx = 0, ry = 0, rz = 0) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.rotation.set(rx, ry, rz); parent.add(m); return m; };
  add(key, new THREE.TorusGeometry(0.85, 0.2, 32, 96), brass, -1.6, 0, 0);
  add(key, new THREE.TorusGeometry(0.42, 0.07, 16, 64), brass, -1.6, 0, 0);
  add(key, new THREE.SphereGeometry(0.15, 24, 16), brass, -1.6, 0, 0);
  for (let i = 0; i < 4; i++) { const a = i * Math.PI / 2 + Math.PI / 4; add(key, new THREE.CylinderGeometry(0.045, 0.045, 0.3, 12), brass, -1.6 + Math.cos(a) * 0.54, Math.sin(a) * 0.54, 0, 0, 0, a - Math.PI / 2); }
  add(key, new THREE.CylinderGeometry(0.25, 0.25, 0.26, 32), brass, -0.43, 0, 0, 0, 0, Math.PI / 2);
  add(key, new THREE.CylinderGeometry(0.14, 0.14, 2.75, 32), brass, 1.0, 0, 0, 0, 0, Math.PI / 2);
  add(key, new THREE.TorusGeometry(0.15, 0.04, 12, 32), brass, 0.15, 0, 0, 0, Math.PI / 2, 0);
  add(key, new THREE.SphereGeometry(0.14, 24, 16), brass, 2.38, 0, 0);
  [[1.62, 0.55], [1.84, 0.34], [2.06, 0.7], [2.26, 0.44]].forEach(([x, h]) => add(key, new THREE.BoxGeometry(0.18, h, 0.16), brass, x, -0.13 - h / 2, 0));
  scene.add(key);

  // vault: a thick collar set into the page, a tunnel behind it, and a stepped door on a right-hand hinge
  const steel = new THREE.MeshStandardMaterial({ color: 0x7a848b, metalness: 1, roughness: 0.32, envMapIntensity: 1 });
  const steelDark = new THREE.MeshStandardMaterial({ color: 0x545e65, metalness: 1, roughness: 0.38, envMapIntensity: 1, side: THREE.DoubleSide });
  // The strong room is lit by painted gradients rather than scene lights: the renderer has no shadows,
  // so lights would flood the inside of the tunnel as if it had no roof.
  const gradTex = (w, h, paint) => { const c = document.createElement('canvas'); c.width = w; c.height = h; paint(c.getContext('2d'), w, h); const t = new THREE.CanvasTexture(c); t.encoding = THREE.sRGBEncoding; return t; };
  const tunnelTex = gradTex(8, 256, (x, w, h) => { const gr = x.createLinearGradient(0, 0, 0, h); gr.addColorStop(0, '#8b8f90'); gr.addColorStop(0.25, '#4b4f52'); gr.addColorStop(1, '#141618'); x.fillStyle = gr; x.fillRect(0, 0, w, h); });
  const wallTex = gradTex(256, 256, (x, w, h) => { const gr = x.createRadialGradient(128, 110, 10, 128, 128, 140); gr.addColorStop(0, '#234068'); gr.addColorStop(0.55, '#122135'); gr.addColorStop(1, '#0f1112'); x.fillStyle = gr; x.fillRect(0, 0, w, h); });
  const steelIn = new THREE.MeshBasicMaterial({ map: tunnelTex, side: THREE.BackSide, color: 0x000000 });
  const backWall = new THREE.MeshBasicMaterial({ map: wallTex, color: 0x000000 });
  const boxMat = new THREE.MeshStandardMaterial({ color: 0x325788, metalness: 0.9, roughness: 0.38, envMapIntensity: 0.2 });
  const black = new THREE.MeshBasicMaterial({ color: 0x050505 });
  const fitting = new THREE.MeshStandardMaterial({ color: 0x6d8db7, metalness: 1, roughness: 0.3, envMapIntensity: 1.2 });
  const vault = new THREE.Group(); vault.rotation.y = -0.55;

  // collar: an extruded ring with real thickness
  const collarShape = new THREE.Shape(); collarShape.absarc(0, 0, 3.0, 0, Math.PI * 2, false);
  const collarHole = new THREE.Path(); collarHole.absarc(0, 0, 2.2, 0, Math.PI * 2, true); collarShape.holes.push(collarHole);
  add(vault, new THREE.ExtrudeGeometry(collarShape, { depth: 0.9, bevelEnabled: true, bevelThickness: 0.08, bevelSize: 0.08, bevelSegments: 3, curveSegments: 96 }), steel, 0, 0, -0.9);
  for (let i = 0; i < 16; i++) { const a = i / 16 * Math.PI * 2; add(vault, new THREE.SphereGeometry(0.06, 12, 8), steel, Math.cos(a) * 2.62, Math.sin(a) * 2.62, 0.07); }

  // tunnel, ribs and the strong-room wall at the back
  add(vault, new THREE.CylinderGeometry(2.2, 2.2, 3.4, 96, 1, true), steelIn, 0, 0, -1.7, Math.PI / 2);
  [-1.1, -2.3].forEach(z => add(vault, new THREE.TorusGeometry(2.17, 0.045, 10, 96), steel, 0, 0, z));
  const lampMat = new THREE.MeshBasicMaterial({ color: 0xb1c2d8, transparent: true, opacity: 0 });
  add(vault, new THREE.TorusGeometry(2.14, 0.025, 8, 120), lampMat, 0, 0, -0.25);
  add(vault, new THREE.CircleGeometry(2.21, 96), backWall, 0, 0, -3.4);
  // the store: every key version hangs on its own hook, with a maroon owner tag beside it
  const pegGeo = new THREE.CylinderGeometry(0.018, 0.018, 0.14, 8), tagGeo = new THREE.BoxGeometry(0.07, 0.1, 0.012);
  const tagMat = new THREE.MeshBasicMaterial({ color: 0x000000 }); const TAG = new THREE.Color(0x1f3a5c).convertSRGBToLinear();
  const miniMat = new THREE.MeshStandardMaterial({ color: 0x6d8db7, metalness: 1, roughness: 0.28, envMapIntensity: 0.9, emissive: 0x101e30 });
  let hookN = 0;
  for (let y = 1.25; y >= -1.6; y -= 0.95) for (let x = -1.89; x <= 1.9; x += 0.42) {
    if (Math.hypot(Math.abs(x) + 0.12, Math.abs(y) + (y > 0 ? 0.15 : 0.6)) > 2.08) continue;
    add(vault, pegGeo, steel, x, y, -3.33, Math.PI / 2);
    const k = key.clone(); k.traverse(o => { if (o.isMesh) o.material = miniMat; });
    k.scale.setScalar(0.1); k.rotation.set(0, 0.35 * Math.sin(hookN * 2.1), -Math.PI / 2 + 0.06 * Math.sin(hookN * 1.3));
    k.position.set(x, y - 0.22, -3.3); vault.add(k);
    add(vault, tagGeo, tagMat, x + 0.11, y - 0.12, -3.32, 0, 0, 0.12);
    hookN++;
  }

  // the hinge is concealed: the door pivots about its right-hand edge with no visible hardware

  // door: lathe-turned profile with stepped rings, so it reads as a heavy machined slab
  const pivot = new THREE.Group(); pivot.position.set(2.5, 0, 0.36); vault.add(pivot);
  const door = new THREE.Group(); door.position.set(-2.5, 0, 0); pivot.add(door);
  const prof = [[0, 0.7], [1.55, 0.7], [1.62, 0.64], [1.95, 0.64], [2.02, 0.55], [2.3, 0.55], [2.45, 0.42], [2.45, 0.06], [2.38, 0], [0, 0]].map(([x, y]) => new THREE.Vector2(x, y));
  add(door, new THREE.LatheGeometry(prof, 128), steelDark, 0, 0, -0.35, Math.PI / 2);
  for (let i = 0; i < 20; i++) { const a = i / 20 * Math.PI * 2; add(door, new THREE.SphereGeometry(0.045, 12, 8), steel, Math.cos(a) * 2.16, Math.sin(a) * 2.16, 0.21); }
  // wheel
  const wheel = new THREE.Group(); wheel.position.set(0, 0.55, 0.53); door.add(wheel);
  add(wheel, new THREE.TorusGeometry(0.78, 0.075, 18, 72), steel, 0, 0, 0);
  for (let i = 0; i < 3; i++) add(wheel, new THREE.BoxGeometry(1.56, 0.09, 0.09), steel, 0, 0, 0, 0, 0, i * Math.PI / 3);
  for (let i = 0; i < 6; i++) { const a = i / 6 * Math.PI * 2; add(wheel, new THREE.SphereGeometry(0.11, 16, 12), fitting, Math.cos(a) * 0.78, Math.sin(a) * 0.78, 0); }
  add(wheel, new THREE.CylinderGeometry(0.2, 0.24, 0.22, 32), steel, 0, 0, -0.06, Math.PI / 2);
  // lock: a fixed brass bezel and a plug inside it. The keyway in the plug is the key's own
  // cross-section (round shaft plus the bit below it) at the scale the key has when it arrives,
  // and the plug turns with the key.
  const KEY_IN = 0.45, VAULT_K = 0.8, f = KEY_IN / VAULT_K;      // key scale / vault scale at the door
  const LOCK_Y = -1.18, FRONT = 0.36;
  const bezel = new THREE.Shape(); bezel.absarc(0, 0, 0.66, 0, Math.PI * 2, false);
  const bezelHole = new THREE.Path(); bezelHole.absarc(0, 0, 0.56, 0, Math.PI * 2, true); bezel.holes.push(bezelHole);
  add(door, new THREE.ExtrudeGeometry(bezel, { depth: 0.07, bevelEnabled: true, bevelThickness: 0.02, bevelSize: 0.02, bevelSegments: 2, curveSegments: 64 }), fitting, 0, LOCK_Y, FRONT);
  const plug = new THREE.Group(); plug.position.set(0, LOCK_Y, FRONT); door.add(plug);   // turns about the shaft centre
  const sr = (0.14 + 0.015) * f, sw = (0.16 + 0.03) * f / 2, sl = (0.83 + 0.03) * f;   // shaft radius, bit half-width, bit depth
  const ph = new THREE.Shape(); ph.absarc(0, 0, 0.55, 0, Math.PI * 2, false);
  const way = new THREE.Path(), a0 = Math.asin(sw / sr);
  way.moveTo(-sw, -sl); way.lineTo(sw, -sl); way.lineTo(sw, -sr * Math.cos(a0));
  way.absarc(0, 0, sr, -Math.PI / 2 + a0, Math.PI * 1.5 - a0, false); way.lineTo(-sw, -sl);
  ph.holes.push(way);
  add(plug, new THREE.ExtrudeGeometry(ph, { depth: 0.05, bevelEnabled: true, bevelThickness: 0.01, bevelSize: 0.01, bevelSegments: 1, curveSegments: 64 }), fitting, 0, 0, 0);
  add(plug, new THREE.CircleGeometry(0.54, 64), black, 0, 0, -0.004);
  const keyhole = new THREE.Object3D(); keyhole.position.set(0, LOCK_Y, FRONT + 0.07); door.add(keyhole);

  const vLight = new THREE.PointLight(0xa4b8d2, 0, 9, 1.6); vLight.position.set(0, 1.1, -1.4); vault.add(vLight);
  const vLight2 = new THREE.PointLight(0xc3cedc, 0, 5, 1.6); vLight2.position.set(0, -0.4, -2.4); vault.add(vLight2);
  scene.add(vault);

  /* ---------- passphrase rig: keyboard, flip tiles, Argon2id memory disk ---------- */
  const PHRASE = 'quiet-lantern-71';
  const pp = new THREE.Group(); scene.add(pp);
  const redraws = [];
  const glyph = (ch, bg, fg, size = 88) => {
    const c = document.createElement('canvas'); c.width = 128; c.height = 160;
    const t = new THREE.CanvasTexture(c); t.encoding = THREE.sRGBEncoding; t.anisotropy = 4;
    const draw = () => {
      const x = c.getContext('2d'); x.clearRect(0, 0, 128, 160);
      if (bg) { x.fillStyle = bg; x.fillRect(0, 0, 128, 160); }
      x.fillStyle = fg;
      if (ch === '•') { x.beginPath(); x.arc(64, 80, 17, 0, Math.PI * 2); x.fill(); }
      else { x.font = `500 ${size}px 'JetBrains Mono', ui-monospace, monospace`; x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText(ch, 64, 86); }
      t.needsUpdate = true;
    };
    draw(); redraws.push(draw); return t;
  };
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => redraws.forEach(d => d()));
  const roundRect = (w, h, r) => {
    const s = new THREE.Shape(), x = -w / 2, y = -h / 2;
    s.moveTo(x + r, y); s.lineTo(x + w - r, y); s.quadraticCurveTo(x + w, y, x + w, y + r);
    s.lineTo(x + w, y + h - r); s.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    s.lineTo(x + r, y + h); s.quadraticCurveTo(x, y + h, x, y + h - r);
    s.lineTo(x, y + r); s.quadraticCurveTo(x, y, x + r, y); return s;
  };

  // input tiles: the typed character on the front, a mask dot on the back
  const tileGeo = new THREE.BoxGeometry(0.3, 0.4, 0.07);
  const tileEdge = new THREE.MeshLambertMaterial({ color: new THREE.Color(0x234168).convertSRGBToLinear() });
  const dotMat = new THREE.MeshStandardMaterial({ map: glyph('•', '#e0e5eb', '#234168'), roughness: 0.6, envMapIntensity: 0.6 });
  const tiles = [...PHRASE].map((ch, i) => {
    const front = new THREE.MeshStandardMaterial({ map: glyph(ch, '#e0e5eb', '#172a44'), roughness: 0.6, envMapIntensity: 0.6 });
    const m = new THREE.Mesh(tileGeo, [tileEdge, tileEdge, tileEdge, tileEdge, front, dotMat]);
    m.userData.home = new THREE.Vector3((i - (PHRASE.length - 1) / 2) * 0.34, 1.75, 0);
    m.userData.seed = i * 1.7;
    pp.add(m); return m;
  });

  // keyboard: maroon case, sculpted cream keycaps, full-width rows with modifiers and a space bar
  const kb = new THREE.Group(); kb.position.set(0, -0.95, 0); kb.rotation.x = 0.72; pp.add(kb);
  const U = 0.4, ROWS = [
    [...'1234567890-'].map(c => [c, 1]).concat([['', 1.9]]),
    [['', 1.4]].concat([...'qwertyuiop'].map(c => [c, 1]), [['', 1.5]]),
    [['', 1.7]].concat([...'asdfghjkl'].map(c => [c, 1]), [['', 2.2]]),
    [['', 2.2]].concat([...'zxcvbnm'].map(c => [c, 1]), [['', 3.7]]),
    [['', 3.9], ['', 5.6], ['', 3.4]],
  ];
  const caseMat = new THREE.MeshLambertMaterial({ color: new THREE.Color(0x1c3352).convertSRGBToLinear() });   // r128 reads hex as linear
  const capMat = new THREE.MeshStandardMaterial({ color: 0xdae0e8, metalness: 0, roughness: 0.5, envMapIntensity: 0.7 });
  const caseGeo = new THREE.ExtrudeGeometry(roundRect(12.9 * U + 0.36, 5 * U + 0.36, 0.16), { depth: 0.16, bevelEnabled: true, bevelThickness: 0.05, bevelSize: 0.05, bevelSegments: 4, curveSegments: 12 });
  add(kb, caseGeo, caseMat, 0, -0.14, 0, -Math.PI / 2);
  const capGeos = {};
  const capGeo = (w) => capGeos[w] || (capGeos[w] = new THREE.ExtrudeGeometry(roundRect(w * U - 0.07, U - 0.07, 0.06), { depth: 0.07, bevelEnabled: true, bevelThickness: 0.035, bevelSize: 0.025, bevelSegments: 3, curveSegments: 6 }));
  const legendGeo = new THREE.PlaneGeometry(0.24, 0.3);
  const caps = {};
  ROWS.forEach((row, r) => {
    let x = -12.9 * U / 2;
    row.forEach(([ch, w]) => {
      const cap = new THREE.Group();
      cap.position.set(x + (w * U) / 2, 0.02, (r - 2) * U);
      add(cap, capGeo(w), capMat, 0, 0, 0, -Math.PI / 2);
      if (ch) {
        const lm = new THREE.MeshStandardMaterial({ map: glyph(ch, null, '#1c3453', 80), transparent: true, roughness: 0.5, emissive: 0x000000 });
        add(cap, legendGeo, lm, 0, 0.142, 0, -Math.PI / 2);
        cap.userData.legend = lm; caps[ch] = cap;
      }
      kb.add(cap); x += w * U;
    });
  });
  const capKeys = Object.keys(caps);
  const kbLight = new THREE.PointLight(0xa4b8d2, 0, 3, 2); kb.add(kbLight);

  // Argon2id as a cryptex: four rings are the four lanes, each ring face is a memory block.
  // Every pass turns all four rings to new positions and re-inks them; after the third pass they
  // line up on the derived bytes, the end cap slides off, and the master key comes out.
  const lin = (h) => new THREE.Color(h).convertSRGBToLinear();
  const crypt = new THREE.Group(); crypt.rotation.set(0.32, -0.42, 0); crypt.position.set(0, 0.1, 0); pp.add(crypt);
  const LANE_X = [-1.08, -0.36, 0.36, 1.08], RING_R = 0.8, RING_W = 0.64, CELLS = 16;
  const ALIGNED = ['9f', '3c', 'e1', '7a'];
  const HEX = '0123456789abcdef';
  const ringTex = (L) => {
    const c = document.createElement('canvas'); c.width = 1024; c.height = 160;
    const t = new THREE.CanvasTexture(c); t.encoding = THREE.sRGBEncoding; t.anisotropy = 4;
    const draw = () => {
      const x = c.getContext('2d');
      x.fillStyle = '#dde2e9'; x.fillRect(0, 0, 1024, 160);
      for (let i = 0; i < CELLS; i++) {
        const cx = i * 64 + 32;
        x.fillStyle = 'rgba(23,42,68,0.10)'; x.fillRect(i * 64, 0, 1.5, 160);
        const txt = i === 0 ? ALIGNED[L] : HEX[(i * 7 + L * 5) % 16] + HEX[(i * 11 + L * 3 + 4) % 16];
        x.save(); x.translate(cx, 80); x.rotate(Math.PI / 2);
        x.fillStyle = '#172a44'; x.font = "500 46px 'JetBrains Mono', ui-monospace, monospace"; x.textAlign = 'center'; x.textBaseline = 'middle';
        x.fillText(txt, 0, 2); x.restore();
      }
      t.needsUpdate = true;
    };
    draw(); redraws.push(draw); return t;
  };
  const brassM = new THREE.MeshStandardMaterial({ color: 0x6d8db7, metalness: 1, roughness: 0.28, envMapIntensity: 1.2 });
  const capFace = new THREE.MeshLambertMaterial({ color: lin(0x1c3352) });
  const rings = LANE_X.map((x, L) => {
    const g = new THREE.Group(); g.position.x = x; crypt.add(g);
    const side = new THREE.MeshStandardMaterial({ map: ringTex(L), roughness: 0.55, metalness: 0, envMapIntensity: 0.5, flatShading: true, emissive: 0x000000 });
    const m = new THREE.Mesh(new THREE.CylinderGeometry(RING_R, RING_R, RING_W - 0.04, CELLS, 1), [side, capFace, capFace]);
    m.rotation.z = Math.PI / 2; g.add(m);
    [-1, 1].forEach(sg => { const r = new THREE.Mesh(new THREE.TorusGeometry(RING_R + 0.01, 0.028, 8, 64), brassM); r.rotation.y = Math.PI / 2; r.position.x = sg * (RING_W / 2 - 0.02); g.add(r); });
    g.userData.side = side;
    return g;
  });
  // end caps, with a maroon band and a brass crown; the right cap comes off at the end
  const makeCap = (dir) => {
    const g = new THREE.Group();
    add(g, new THREE.CylinderGeometry(0.88, 0.88, 0.5, 48), brassM, 0, 0, 0, 0, 0, Math.PI / 2);
    add(g, new THREE.CylinderGeometry(0.9, 0.9, 0.16, 48), capFace, 0, 0, 0, 0, 0, Math.PI / 2);
    add(g, new THREE.CylinderGeometry(0.6, 0.78, 0.22, 48), brassM, dir * 0.36, 0, 0, 0, 0, Math.PI / 2);
    add(g, new THREE.SphereGeometry(0.16, 20, 14), brassM, dir * 0.52, 0, 0);
    g.position.x = dir * 1.72; crypt.add(g); return g;
  };
  const capL = makeCap(-1), capR = makeCap(1);
  // alignment window: two brass rails along the front face
  const rail = new THREE.BoxGeometry(2.9, 0.035, 0.05);
  const railA = add(crypt, rail, brassM, 0, 0.19, RING_R + 0.04), railB = add(crypt, rail, brassM, 0, -0.19, RING_R + 0.04);
  const haloTex = (() => { const c = document.createElement('canvas'); c.width = c.height = 128; const x = c.getContext('2d'), gr = x.createRadialGradient(64, 64, 0, 64, 64, 64);
    gr.addColorStop(0, 'rgba(178,195,217,1)'); gr.addColorStop(0.35, 'rgba(151,174,204,0.45)'); gr.addColorStop(1, 'rgba(151,174,204,0)'); x.fillStyle = gr; x.fillRect(0, 0, 128, 128);
    const t = new THREE.CanvasTexture(c); t.encoding = THREE.sRGBEncoding; return t; })();
  const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: haloTex, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending }));
  halo.scale.set(4.4, 2.6, 1); crypt.add(halo);
  // the key is revealed lying along the cryptex's own axis, so it starts in exactly the cryptex's pose
  const cE = new THREE.Euler().setFromQuaternion(new THREE.Quaternion().setFromEuler(crypt.rotation), 'YXZ');
  const CRX = cE.x, CRY = cE.y, CRZ = cE.z;
  // ring angles: cumulative turns (in cells) after each pass, per lane
  const STEP = 2 * Math.PI / CELLS;
  const TURNS = [[5, -7, 3, 9], [-4, 6, -11, 2], [8, -3, 5, -6]];
  const CUM = [[0, 0, 0, 0]]; TURNS.forEach((t, k) => CUM.push(CUM[k].map((v, L) => v + t[L])));
  const FACE = 0.5;          // cell index that faces the window at angle 0 (set from the texture layout)
  const PASS_COL = [0xdde2e9, 0xa8bbd4, 0x8ba5c6, 0x95accb].map(lin);
  const clamp01 = (x) => Math.max(0, Math.min(1, x));
  const bump = (x) => (x > 0 && x < 1 ? Math.sin(Math.PI * x) : 0);
  const outBack = (x) => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2); };
  const inOut = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
  const settle = (x) => { if (x <= 0) return 0; if (x >= 1) return 1; const e = inOut(Math.min(1, x / 0.85)); return e + Math.sin(Math.min(1, x / 0.85) * Math.PI) * 0 + (x > 0.85 ? Math.sin((x - 0.85) / 0.15 * Math.PI) * 0.025 : 0); };
  const tv = new THREE.Vector3(), tv2 = new THREE.Vector3();
  const cryptOut = (out) => out.set(0, 0, 0).applyMatrix4(crypt.matrix);   // cryptex centre, in pp space

  const updatePP = (now) => {
    const n = PS.type;
    // keys: press, glow, and a lamp under the key being pressed
    let lit = 0;
    capKeys.forEach(ch => {
      let p = 0;
      for (let i = 0; i < PHRASE.length; i++) if (PHRASE[i] === ch) p = Math.max(p, bump((n - i + 0.3) / 0.7));
      const cap = caps[ch]; cap.position.y = 0.02 - 0.08 * p;
      cap.userData.legend.emissive.setRGB(0.9 * p, 0.25 * p, 0.2 * p);
      if (p > lit) { lit = p; kbLight.position.set(cap.position.x, 0.5, cap.position.z); }
    });
    kbLight.intensity = lit * 1.4;
    kb.scale.setScalar(Math.max(0.0001, PS.kb));
    kb.visible = PS.kb > 0.002;
    kb.position.y = -0.95 - (1 - PS.kb) * 0.8;
    kb.updateMatrixWorld(true);
    crypt.updateMatrix();
    // tiles rise out of the key that typed them, flip to a dot, then glide into the left end cap
    tv2.set(-2.3, 0, 0).applyMatrix4(crypt.matrix);
    tiles.forEach((t, i) => {
      const a = clamp01((n - i) / 0.6), fl = clamp01((n - i - 3.4) / 0.6);
      const fly = clamp01((PS.fly - (i / tiles.length) * 0.6) / 0.4), fe = inOut(fly);
      const h = t.userData.home, ae = 1 - Math.pow(1 - a, 3);
      const cap = caps[PHRASE[i]];
      if (cap && a < 1) { cap.getWorldPosition(tv); pp.worldToLocal(tv); } else tv.copy(h);
      tv.lerp(h, ae); tv.y += Math.sin(ae * Math.PI) * 0.5;
      t.position.copy(tv).lerp(tv2, fe); t.position.y += Math.sin(fe * Math.PI) * 0.6;
      t.rotation.set((1 - ae) * -1.2, fl * Math.PI - fe * 0.6, 0);
      t.scale.setScalar(Math.max(0.0001, (a > 0 ? outBack(a) : 0) * (1 - 0.8 * fe)));
      t.visible = a > 0.001 && fe < 0.98;
    });
    // cryptex
    crypt.scale.setScalar(Math.max(0.0001, PS.mill));
    crypt.visible = PS.mill > 0.002;
    const P3 = PS.hash * 3, pass = Math.min(2, Math.floor(P3));
    rings.forEach((g, L) => {
      let ang = 0, flash = 0;
      for (let k = 0; k < 3; k++) {
        const local = clamp01((P3 - k - L * 0.12) / 0.52);
        const e = settle(local);
        ang += (CUM[k + 1][L] - CUM[k][L]) * STEP * e;
        if (local > 0.85 && local < 1) flash = Math.max(flash, Math.sin((local - 0.85) / 0.15 * Math.PI));
      }
      // align: turn on to the nearest whole turn so the derived bytes face the window
      const tgt = Math.round(ang / (2 * Math.PI)) * 2 * Math.PI;
      ang += (tgt - ang) * settle(clamp01((PS.align - L * 0.1) / 0.6));
      // opening: rings part outward from the middle, swell slightly, then fall away
      const op = clamp01((PS.cap - Math.abs(L - 1.5) * 0.12) / 0.8), oe = inOut(op);
      g.rotation.x = ang + FACE * STEP + oe * (L < 2 ? -1 : 1) * 1.2;
      g.position.x = LANE_X[L] * (1 + oe * 1.1);
      const rs = (1 + 0.18 * Math.sin(Math.min(1, op * 1.6) * Math.PI / 2)) * (1 - clamp01((op - 0.45) / 0.55));
      g.scale.set(Math.max(0.0001, 1 - clamp01((op - 0.45) / 0.55)), Math.max(0.0001, rs), Math.max(0.0001, rs));
      g.visible = rs > 0.002;
      const done = Math.min(3, Math.floor(P3 - L * 0.12 + 0.48));
      const side = g.userData.side;
      side.color.copy(PASS_COL[Math.max(0, Math.min(3, done))]);
      side.emissive.setRGB(0.35 * flash + 0.25 * PS.align, 0.18 * flash + 0.16 * PS.align, 0.05 * flash);
    });
    const ce = inOut(clamp01(PS.cap / 0.7)), cf = Math.max(0.0001, 1 - clamp01((PS.cap - 0.3) / 0.7));
    [capL, capR].forEach((cp, i) => { const d = i ? 1 : -1; cp.position.x = d * (1.72 + ce * 1.5); cp.rotation.x = d * ce * 1.4; cp.scale.setScalar(cf); cp.visible = cf > 0.002; });
    const rl = Math.max(0.0001, 1 - clamp01(PS.cap / 0.4));
    railA.scale.set(rl, 1, 1); railB.scale.set(rl, 1, 1); railA.visible = railB.visible = rl > 0.002;
    halo.material.opacity = Math.sin(clamp01(PS.cap) * Math.PI) * 0.55 + clamp01((PS.cap - 0.5) * 2) * 0.25 * PS.mill;
  };

  /* ---------- key's life rig: print, packets, old version, countdown, break ---------- */
  renderer.localClippingEnabled = true;
  const lifeG = new THREE.Group(); scene.add(lifeG);
  // Rotated: the retired version steps back as a translucent ghost
  const ghostMat = new THREE.MeshStandardMaterial({ color: lin(0x809cc1), metalness: 0.5, roughness: 0.5, transparent: true, opacity: 0, depthWrite: false });
  const ghost = key.clone(); ghost.traverse(o => { if (o.isMesh) o.material = ghostMat; }); scene.add(ghost);
  // Revoked: two halves of the key, each clipped at the break
  const halfPlanes = [new THREE.Plane(), new THREE.Plane()];
  const halfMats = halfPlanes.map(pl => { const m = brass.clone(); m.clippingPlanes = [pl]; m.clipShadows = true; return m; });
  const halves = halfMats.map(m => { const h = key.clone(); h.rotation.order = 'YXZ'; h.traverse(o => { if (o.isMesh) o.material = m; }); scene.add(h); return h; });
  // Created: the key is printed from bow to tip behind a ring of light
  const printPlane = new THREE.Plane();
  const printRing = add(key, new THREE.TorusGeometry(1, 0.04, 8, 72), new THREE.MeshBasicMaterial({ color: 0x9eb3cf, transparent: true, opacity: 0, depthWrite: false }), 0, 0, 0, 0, Math.PI / 2, 0);
  // In use: plain data tiles pass through the key and come out sealed
  const PKT = 7, pktGeo = new THREE.BoxGeometry(0.46, 0.6, 0.08);
  const pktEdge = new THREE.MeshLambertMaterial({ color: lin(0xc9d3df) });
  const sealFace = new THREE.MeshStandardMaterial({ map: glyph('•', '#234168', '#e0e5eb'), roughness: 0.6, envMapIntensity: 0.5 });
  const packets = [...'payroll'].map((ch, i) => {
    const face = new THREE.MeshStandardMaterial({ map: glyph(ch, '#e0e5eb', '#172a44'), roughness: 0.6, envMapIntensity: 0.6 });
    const m = new THREE.Mesh(pktGeo, [pktEdge, pktEdge, pktEdge, pktEdge, face, face]);
    m.userData.plain = m.material; m.userData.sealed = [tileEdge, tileEdge, tileEdge, tileEdge, sealFace, sealFace];
    lifeG.add(m); return m;
  });
  // Expired: a ring of ticks that runs down
  const TICKS = 48, tickGeo = new THREE.BoxGeometry(0.07, 0.26, 0.05), tickOff = new THREE.MeshLambertMaterial({ color: lin(0xadbfd7) });
  const ticks = [];
  for (let i = 0; i < TICKS; i++) {
    const a = Math.PI / 2 - (i / TICKS) * Math.PI * 2;
    const m = new THREE.Mesh(tickGeo, brassM); m.position.set(Math.cos(a) * 3.1, Math.sin(a) * 3.1, -0.3); m.rotation.z = a - Math.PI / 2;
    lifeG.add(m); ticks.push(m);
  }
  // Revoked: a maroon wax seal with a cross
  const seal = new THREE.Group(); scene.add(seal);
  const waxM = new THREE.MeshLambertMaterial({ color: lin(0x234168) }), waxD = new THREE.MeshLambertMaterial({ color: lin(0x192f4c) });
  add(seal, new THREE.CylinderGeometry(0.55, 0.58, 0.12, 40), waxM, 0, 0, 0, Math.PI / 2);
  add(seal, new THREE.TorusGeometry(0.42, 0.035, 8, 40), waxD, 0, 0, 0.07);
  add(seal, new THREE.BoxGeometry(0.5, 0.08, 0.05), waxD, 0, 0, 0.08, 0, 0, Math.PI / 4);
  add(seal, new THREE.BoxGeometry(0.5, 0.08, 0.05), waxD, 0, 0, 0.08, 0, 0, -Math.PI / 4);

  const BREAK_X = 0.45, REDL = new THREE.Color(0xd6452f);
  const lv = new THREE.Vector3(), lv2 = new THREE.Vector3();
  const updateLife = (now, u, ksBase) => {
    domWorld(anchorEls.life, 0, lifeG.position);
    lifeG.scale.setScalar(u * 0.72);
    // print
    const printing = LS.print > 0.0005 && LS.print < 0.9995;
    const cut = -2.75 + LS.print * 5.4;
    if (printing) {
      key.updateMatrixWorld(true);
      lv.set(1, 0, 0).transformDirection(key.matrixWorld).negate();
      key.localToWorld(lv2.set(cut, 0, 0));
      printPlane.setFromNormalAndCoplanarPoint(lv, lv2);
    }
    if ((brass.clippingPlanes ? brass.clippingPlanes.length : 0) !== (printing ? 1 : 0)) { brass.clippingPlanes = printing ? [printPlane] : []; brass.needsUpdate = true; }
    printRing.position.x = cut;
    const rr = cut < -0.5 ? Math.sqrt(Math.max(0, 1.12 * 1.12 - (cut + 1.6) * (cut + 1.6))) + 0.12 : cut > 1.45 ? 0.9 : 0.32;
    printRing.scale.setScalar(Math.max(0.2, rr));
    printRing.material.opacity = printing ? 1 : 0;
    // packets
    const tsec = now / 1000;
    packets.forEach((m, i) => {
      const f = (tsec * 0.16 + i / PKT) % 1, x = -3.3 + f * 6.6, edge = Math.min(1, Math.min(f, 1 - f) * 7);
      const sealed = x > 0;
      if ((m.material === m.userData.sealed) !== sealed) m.material = sealed ? m.userData.sealed : m.userData.plain;
      m.position.set(x, -1.55 + Math.sin(f * Math.PI * 2 + i) * 0.08, 1.3);
      m.rotation.set(0, clamp01((x + 0.45) / 0.9) * Math.PI, 0);
      const s = Math.max(0.0001, LS.use * edge); m.scale.setScalar(s); m.visible = s > 0.002;
    });
    // countdown
    ticks.forEach((m, i) => {
      const on = i / TICKS >= LS.tick;
      m.material = on ? brassM : tickOff;
      const s = Math.max(0.0001, LS.clock); m.scale.set(s, s * (on ? 1 : 0.6), s); m.visible = LS.clock > 0.002;
    });
    // ghost of the retired version
    ghost.visible = LS.ghost > 0.002;
    if (ghost.visible) {
      ghost.position.copy(key.position).add(lv.set(-1.1, 0.7, -1.8).multiplyScalar(u * 0.72 * LS.ghost));
      ghost.rotation.set(0, key.rotation.y, key.rotation.z, 'YXZ');
      ghost.scale.setScalar(ksBase * 0.94);
      ghostMat.opacity = 0.45 * clamp01(LS.ghost * 2.5);
    }
    // break
    const show = LS.brk > 0.0005 && LS.out > 0.002;
    halves.forEach((h, i) => {
      h.visible = show; if (!show) return;
      const sg = i ? 1 : -1, b = LS.brk;
      h.position.copy(key.position); h.quaternion.copy(key.quaternion); h.scale.setScalar(Math.max(0.0001, ksBase * LS.out));
      h.translateX(sg * b * 1.0); h.translateY(-b * 0.15); h.rotateZ(-sg * b * 0.3);
      h.updateMatrixWorld(true);
      lv.set(1, 0, 0).transformDirection(h.matrixWorld).multiplyScalar(i ? 1 : -1);
      h.localToWorld(lv2.set(BREAK_X, 0, 0));
      halfPlanes[i].setFromNormalAndCoplanarPoint(lv, lv2);
      const m = halfMats[i]; m.color.copy(brass.color); m.roughness = brass.roughness;
      m.emissive.copy(brass.emissive); m.emissive.r += 0.12 * b; m.emissive.g += 0.02 * b;
    });
    seal.visible = show && LS.seal > 0.002;
    if (seal.visible) {
      key.localToWorld(seal.position.set(BREAK_X, 0, 0)); seal.position.z += 1.2 * u;
      seal.position.y -= 0.9 * u * 0.72;
      seal.rotation.set(0, 0, -0.25);
      seal.scale.setScalar(Math.max(0.0001, outBack(LS.seal) * u * 0.6 * LS.out));
    }
  };

  /* ---------- sealed-with-context rig: a window envelope closed with a wax seal stamped by the key ---------- */
  // Address = key id and version, postmark = nonce, window = ciphertext, wax seal = the authentication tag.
  const cG = new THREE.Group(); scene.add(cG);
  const EW = 4.6, EH = 2.8, FLAP = 1.3, ED = 0.1;
  const EX = -0.2, EY = -0.26;                      // the envelope's tilt, which the key matches when it stamps
  const envl = new THREE.Group(); envl.rotation.set(EX, EY, 0); cG.add(envl);
  const canvasTex = (w, h, paint) => {
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const t = new THREE.CanvasTexture(c); t.encoding = THREE.sRGBEncoding; t.anisotropy = 8;
    const draw = () => { paint(c.getContext('2d'), w, h); t.needsUpdate = true; };
    draw(); redraws.push(draw); t.userData = { draw }; return t;
  };
  let pseed = 7; const prnd = () => (pseed = (pseed * 16807) % 2147483647) / 2147483647;
  const paperFill = (x, w, h, base) => {
    x.fillStyle = base; x.fillRect(0, 0, w, h);
    pseed = 7; for (let i = 0; i < 2600; i++) { x.fillStyle = `rgba(90,60,40,${0.025 + prnd() * 0.03})`; x.fillRect(prnd() * w, prnd() * h, 1.2, 1.2); }
  };
  const FRONT_W = 1024, FRONT_H = Math.round(1024 * EH / EW);
  const WIN = { x: 600, y: 400, w: 360, h: 112 };
  const altPos = { x: 0, y: 0 };                    // where the changed character sits, in canvas pixels
  const envFront = (variant) => canvasTex(FRONT_W, FRONT_H, (x, w, h) => {
    paperFill(x, w, h, '#dce2e9');
    // the back folds of the envelope, so the paper reads as layered
    x.fillStyle = 'rgba(46,80,124,0.05)'; x.beginPath(); x.moveTo(0, h); x.lineTo(w * 0.44, h * 0.52); x.lineTo(w * 0.56, h * 0.52); x.lineTo(w, h); x.closePath(); x.fill();
    x.strokeStyle = 'rgba(23,42,68,0.13)'; x.lineWidth = 2; x.beginPath(); x.moveTo(0, h); x.lineTo(w * 0.44, h * 0.52); x.lineTo(w * 0.56, h * 0.52); x.lineTo(w, h); x.stroke();
    x.strokeStyle = 'rgba(23,42,68,0.16)'; x.lineWidth = 2; x.strokeRect(18, 18, w - 36, h - 36);
    // postmark: the nonce, used once
    const px = 812, py = 232;
    x.strokeStyle = 'rgba(35,65,104,0.75)'; x.lineWidth = 3;
    for (let k = 0; k < 4; k++) { x.beginPath(); for (let s = 0; s <= 60; s++) { const xx = px - 330 + s * 4.2; x.lineTo(xx, py - 30 + k * 20 + Math.sin(s * 0.5) * 5); } x.stroke(); }
    x.fillStyle = '#dce2e9'; x.beginPath(); x.arc(px, py, 80, 0, Math.PI * 2); x.fill();
    x.beginPath(); x.arc(px, py, 78, 0, Math.PI * 2); x.stroke(); x.beginPath(); x.arc(px, py, 64, 0, Math.PI * 2); x.stroke();
    x.fillStyle = 'rgba(35,65,104,0.85)'; x.textAlign = 'center'; x.textBaseline = 'middle';
    x.font = "600 22px 'Hanken Grotesk', system-ui, sans-serif"; x.fillText('NONCE', px, py - 18);
    x.font = "500 19px 'JetBrains Mono', ui-monospace, monospace"; x.fillText('Qm9Xr2tLp1Va', px, py + 12);
    // address: the key id and version
    const ax = 96, ab = 430;
    x.textAlign = 'left'; x.textBaseline = 'alphabetic'; x.fillStyle = '#1c3453';
    x.font = "700 100px 'Hanken Grotesk', system-ui, sans-serif";
    const pre = x.measureText('Key '), m7 = x.measureText('7');
    x.fillText('Key 7', ax, ab);
    x.font = "500 34px 'Hanken Grotesk', system-ui, sans-serif"; x.fillStyle = '#2d4e79'; x.fillText('version 3', ax + 12, ab + 70);
    if (variant === 'readdressed') {
      // strike through the 7 using its measured ink box, then write the 9 just after it
      const l = ax + pre.width - m7.actualBoundingBoxLeft, r = ax + pre.width + m7.actualBoundingBoxRight;
      const t = ab - m7.actualBoundingBoxAscent, bt = ab + m7.actualBoundingBoxDescent;
      const cx = (l + r) / 2, cy = (t + bt) / 2, hw = (r - l) / 2 + 14, hh = (bt - t) / 2 + 4;
      x.strokeStyle = '#c2451e'; x.lineWidth = 7; x.lineCap = 'round';
      x.beginPath(); x.moveTo(cx - hw, cy + hh * 0.75); x.lineTo(cx + hw, cy - hh * 0.75); x.stroke();
      x.fillStyle = '#c2451e'; x.font = "700 100px 'Hanken Grotesk', system-ui, sans-serif"; x.fillText('9', r + 22, ab);
    }
    // window: the ciphertext and tag
    const { x: wx, y: wy, w: ww, h: wh } = WIN;
    x.fillStyle = 'rgba(199,209,221,0.95)'; x.fillRect(wx, wy, ww, wh);
    x.strokeStyle = 'rgba(23,42,68,0.25)'; x.lineWidth = 2; x.strokeRect(wx, wy, ww, wh);
    x.fillStyle = 'rgba(255,255,255,0.35)'; x.fillRect(wx + 6, wy + 6, ww - 12, 10);
    x.textAlign = 'left'; x.textBaseline = 'middle';
    const base = "500 30px 'JetBrains Mono', ui-monospace, monospace", big = "700 46px 'JetBrains Mono', ui-monospace, monospace";
    const parts = variant === 'altered' ? [['c3Vw', base, '#172a44'], ['a', big, '#c2451e'], ['XJzZW…8fK2', base, '#172a44']] : [['c3VwZXJzZW…8fK2', base, '#172a44']];
    const widths = parts.map(([s2, f]) => { x.font = f; return x.measureText(s2).width; });
    let tx = wx + ww / 2 - widths.reduce((a, b) => a + b, 0) / 2;
    parts.forEach(([s2, f, col], i) => {
      x.font = f;
      if (f === big) {
        altPos.x = tx + widths[i] / 2; altPos.y = wy + wh / 2 + 2;
        x.fillStyle = 'rgba(194,69,30,0.18)'; x.fillRect(tx - 6, wy + 14, widths[i] + 12, wh - 28);
      }
      x.fillStyle = col; x.fillText(s2, tx, wy + wh / 2 + 4); tx += widths[i];
    });
  });
  const frontTex = { ok: envFront('ok'), readdressed: envFront('readdressed'), altered: envFront('altered') };
  const creamM = new THREE.MeshLambertMaterial({ color: lin(0xc9d3df) });
  const frontMat = new THREE.MeshLambertMaterial({ map: frontTex.ok });
  // body: a slab with real thickness whose front swells gently where the letter sits inside
  const bodyGeo = new THREE.BoxGeometry(EW, EH, ED, 40, 24, 1);
  const bulge = (bx, by) => 0.14 * Math.max(0, 1 - Math.pow(2 * bx / EW, 2)) * Math.max(0, 1 - Math.pow(2 * by / EH, 2)) * Math.min(1, Math.max(0, (EH / 2 - FLAP + 0.1 - by) / 0.9));
  { const ps = bodyGeo.attributes.position; for (let i = 0; i < ps.count; i++) if (ps.getZ(i) > 0) ps.setZ(i, ps.getZ(i) + bulge(ps.getX(i), ps.getY(i))); bodyGeo.computeVertexNormals(); }
  add(envl, bodyGeo, [creamM, creamM, creamM, creamM, frontMat, creamM], 0, 0, 0);
  const shadowTex = canvasTex(256, 160, (x, w, h) => { x.clearRect(0, 0, w, h); const g = x.createRadialGradient(w / 2, h / 2, 8, w / 2, h / 2, w / 2); g.addColorStop(0, 'rgba(18,35,55,0.42)'); g.addColorStop(0.6, 'rgba(18,35,55,0.16)'); g.addColorStop(1, 'rgba(18,35,55,0)'); x.fillStyle = g; x.fillRect(0, 0, w, h); });
  const envShadow = add(cG, new THREE.PlaneGeometry(EW * 1.3, EH * 1.35), new THREE.MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false }), 0.3, -0.38, -0.7);
  // flap: paper outside, maroon security tint inside, hinged on the top edge, with a little thickness
  const flapShape = new THREE.Shape(); flapShape.moveTo(-EW / 2, 0); flapShape.lineTo(EW / 2, 0); flapShape.lineTo(0.14, -FLAP + 0.05); flapShape.quadraticCurveTo(0, -FLAP - 0.04, -0.14, -FLAP + 0.05); flapShape.lineTo(-EW / 2, 0);
  const flapGeo = new THREE.ShapeGeometry(flapShape, 8);
  const fuv = flapGeo.attributes.uv, fpos = flapGeo.attributes.position;
  for (let i = 0; i < fuv.count; i++) fuv.setXY(i, fpos.getX(i) / EW + 0.5, fpos.getY(i) / FLAP + 1);
  const flapOut = new THREE.MeshLambertMaterial({ map: canvasTex(512, 160, (x, w, h) => {
    paperFill(x, w, h, '#d1d8e2');
    x.strokeStyle = 'rgba(23,42,68,0.3)'; x.lineWidth = 3; x.beginPath(); x.moveTo(0, 1); x.lineTo(w / 2, h - 1); x.lineTo(w, 1); x.stroke();
  }) });
  const flapIn = new THREE.MeshLambertMaterial({ map: canvasTex(512, 160, (x, w, h) => {
    x.fillStyle = '#cbd4e0'; x.fillRect(0, 0, w, h); x.strokeStyle = 'rgba(35,65,104,0.35)'; x.lineWidth = 1.4;
    for (let i = -h; i < w; i += 7) { x.beginPath(); x.moveTo(i, 0); x.lineTo(i + h, h); x.stroke(); }
  }), side: THREE.BackSide });
  const envFlap = new THREE.Group(); envFlap.position.set(0, EH / 2, ED / 2 + 0.006); envl.add(envFlap);
  envFlap.add(new THREE.Mesh(flapGeo, flapOut)); const fIn = new THREE.Mesh(flapGeo, flapIn); fIn.position.z = -0.004; envFlap.add(fIn);
  const flapShadow = add(envl, new THREE.ShapeGeometry(flapShape, 8), new THREE.MeshBasicMaterial({ color: 0x122337, transparent: true, opacity: 0.08, depthWrite: false }), 0, EH / 2 - 0.035, ED / 2 + 0.003);

  // wax seal: two pieces cut along a jagged crack, extruded with rounded edges, each carrying its part of the print
  const SEAL_Y = EH / 2 - FLAP + 0.14, SEAL_R = 0.44, WAX_D = 0.05, WAX_B = 0.035;
  const SEAL_TOP = WAX_D + WAX_B;
  const waxSide = new THREE.MeshLambertMaterial({ color: lin(0x1f3a5c) });
  const waxTop = new THREE.MeshLambertMaterial({ color: lin(0x2b4b75) });
  const SEAL_Z = ED / 2 + 0.012 + WAX_B;
  const wseal = new THREE.Group(); wseal.position.set(0, SEAL_Y, SEAL_Z); envl.add(wseal);
  const rimNoise = (a) => 1 + 0.05 * Math.sin(a * 7) + 0.035 * Math.sin(a * 13 + 1);
  const rimPt = (a) => { const r = SEAL_R * rimNoise(a); return [Math.cos(a) * r, Math.sin(a) * r]; };
  const aT = Math.PI / 2 - 0.05, aB = -Math.PI / 2 + 0.04;
  const CRACK = [rimPt(aT), ...[[-0.05, 0.7], [0.06, 0.46], [-0.01, 0.22], [0.08, -0.02], [-0.03, -0.26], [0.05, -0.5], [-0.04, -0.74]].map(([x, y]) => [x * SEAL_R, y * SEAL_R]), rimPt(aB)];
  const arc = (shape, a0, a1, steps) => { for (let k = 1; k <= steps; k++) { const [x, y] = rimPt(a0 + (a1 - a0) * k / steps); shape.lineTo(x, y); } };
  const leftShape = new THREE.Shape(); leftShape.moveTo(...CRACK[0]); arc(leftShape, aT, aB + Math.PI * 2, 40); for (let i = CRACK.length - 2; i > 0; i--) leftShape.lineTo(...CRACK[i]); leftShape.lineTo(...CRACK[0]);
  const rightShape = new THREE.Shape(); rightShape.moveTo(...CRACK[CRACK.length - 1]); arc(rightShape, aB, aT, 40); for (let i = 1; i < CRACK.length - 1; i++) rightShape.lineTo(...CRACK[i]); rightShape.lineTo(...CRACK[CRACK.length - 1]);
  let crackStep = -1, printStamped = false;
  const printTex = canvasTex(512, 512, (x, w, h) => {
    x.clearRect(0, 0, w, h); const c = w / 2, R = w / 2 * 0.98;
    const g = x.createRadialGradient(c - 40, c - 50, 20, c, c, R); g.addColorStop(0, 'rgba(202,211,223,0.22)'); g.addColorStop(1, 'rgba(8,14,22,0.22)'); x.fillStyle = g; x.fillRect(0, 0, w, h);
    if (printStamped) {
      // the key's bow, pressed in: outer ring, inner ring, four spokes and a centre boss, all on one centre
      const emboss = (fn) => { x.save(); x.translate(3, 3); x.strokeStyle = x.fillStyle = 'rgba(215,222,230,0.35)'; fn(); x.restore(); x.strokeStyle = x.fillStyle = 'rgba(8,16,26,0.78)'; fn(); };
      emboss(() => { x.lineWidth = 26; x.beginPath(); x.arc(c, c, R * 0.64, 0, Math.PI * 2); x.stroke(); });
      emboss(() => { x.lineWidth = 10; x.beginPath(); x.arc(c, c, R * 0.32, 0, Math.PI * 2); x.stroke(); });
      emboss(() => { x.lineWidth = 9; for (let k = 0; k < 4; k++) { const a = Math.PI / 4 + k * Math.PI / 2; x.beginPath(); x.moveTo(c + Math.cos(a) * R * 0.36, c + Math.sin(a) * R * 0.36); x.lineTo(c + Math.cos(a) * R * 0.56, c + Math.sin(a) * R * 0.56); x.stroke(); } });
      emboss(() => { x.beginPath(); x.arc(c, c, R * 0.1, 0, Math.PI * 2); x.fill(); });
      emboss(() => { x.font = "700 44px 'JetBrains Mono', monospace"; x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText('7', c, c + R * 0.82); x.fillText('3', c, c - R * 0.82); });
    }
    // hairline crack that runs top to bottom along the same path the pieces part on
    const len = Math.max(0, crackStep) / 12;
    if (len > 0) {
      const P = CRACK.map(([px2, py2]) => [c + px2 / SEAL_R * (w / 2), c - py2 / SEAL_R * (w / 2)]);
      const n = (P.length - 1) * len;
      x.strokeStyle = 'rgba(4,7,12,0.9)'; x.lineWidth = 5; x.lineJoin = 'round'; x.beginPath(); x.moveTo(...P[0]);
      for (let i = 1; i <= Math.floor(n); i++) x.lineTo(...P[i]);
      const f = n % 1, j = Math.floor(n);
      if (f && j + 1 < P.length) x.lineTo(P[j][0] + (P[j + 1][0] - P[j][0]) * f, P[j][1] + (P[j + 1][1] - P[j][1]) * f);
      x.stroke();
    }
  });
  const printMat = new THREE.MeshBasicMaterial({ map: printTex, transparent: true, depthWrite: false });
  const makePiece = (shape) => {
    const pts = shape.getPoints(); const cx = pts.reduce((a, p) => a + p.x, 0) / pts.length, cy = pts.reduce((a, p) => a + p.y, 0) / pts.length;
    const g = new THREE.Group(); g.position.set(cx, cy, 0); wseal.add(g);
    const geo = new THREE.ExtrudeGeometry(shape, { depth: WAX_D, bevelEnabled: true, bevelThickness: WAX_B, bevelSize: 0.03, bevelSegments: 4, curveSegments: 6 });
    geo.translate(-cx, -cy, 0); g.add(new THREE.Mesh(geo, [waxTop, waxSide]));
    const dg = new THREE.ShapeGeometry(shape, 6), du = dg.attributes.uv, dp = dg.attributes.position;
    for (let i = 0; i < du.count; i++) du.setXY(i, dp.getX(i) / (2 * SEAL_R) + 0.5, dp.getY(i) / (2 * SEAL_R) + 0.5);
    dg.translate(-cx, -cy, 0);
    const decal = new THREE.Mesh(dg, printMat); decal.position.z = SEAL_TOP + 0.003; g.add(decal);
    g.userData.home = new THREE.Vector3(cx, cy, 0); return g;
  };
  const pieces = [makePiece(leftShape), makePiece(rightShape)];
  // flakes that break off along the crack
  const flakeShape = new THREE.Shape(); flakeShape.moveTo(0, 0.08); flakeShape.lineTo(0.07, -0.04); flakeShape.lineTo(-0.06, -0.05); flakeShape.lineTo(0, 0.08);
  const flakeGeo = new THREE.ExtrudeGeometry(flakeShape, { depth: 0.03, bevelEnabled: false });
  const flakes = [1, 2, 3, 4, 5, 6].map((ci, i) => {
    const m = new THREE.Mesh(flakeGeo, [waxTop, waxSide]); wseal.add(m);
    const [px2, py2] = CRACK[ci];
    m.userData = { p: new THREE.Vector3(px2, py2, SEAL_TOP * 0.6), v: new THREE.Vector3((i % 2 ? 1 : -1) * (0.15 + (i % 3) * 0.12), 0.25 + (i % 2) * 0.2, 0.5 + (i % 3) * 0.2), s: 0.8 + (i % 3) * 0.3, d: (i * 0.07) % 0.2 };
    return m;
  });
  // sealing wax stick and the drop it lets fall
  const stick = new THREE.Group(); envl.add(stick);
  add(stick, new THREE.CylinderGeometry(0.09, 0.09, 1.5, 24), waxSide, 0, 0.75, 0);
  const tipMat = new THREE.MeshLambertMaterial({ color: lin(0x2b4b75), emissive: 0x000000 });
  add(stick, new THREE.SphereGeometry(0.1, 20, 14), tipMat, 0, 0, 0);
  const waxDrop = add(envl, new THREE.SphereGeometry(0.17, 24, 18), waxTop, 0, SEAL_Y, 0.9);
  // magnifier that finds the changed character
  const mag = new THREE.Group(); envl.add(mag);
  add(mag, new THREE.TorusGeometry(0.34, 0.035, 12, 64), brassM, 0, 0, 0);
  add(mag, new THREE.CircleGeometry(0.33, 48), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.12, depthWrite: false }), 0, 0, 0);
  add(mag, new THREE.CylinderGeometry(0.035, 0.04, 0.7, 16), lin ? new THREE.MeshLambertMaterial({ color: lin(0x1c3352) }) : brassM, 0.42, -0.42, 0, 0, 0, Math.PI / 4);
  const altRing = add(envl, new THREE.RingGeometry(0.16, 0.2, 48), new THREE.MeshBasicMaterial({ color: 0xd2501f, transparent: true, opacity: 0, depthWrite: false }), 0, 0, ED / 2 + 0.1);
  const winToLocal = (px, py, out) => out.set((px / FRONT_W - 0.5) * EW, (0.5 - py / FRONT_H) * EH, ED / 2 + 0.01);

  const sealWorld = (out) => out.set(0, SEAL_Y, SEAL_Z + SEAL_TOP).applyMatrix4(envl.matrixWorld);
  const keyEuler = new THREE.Euler(0, 0, 0, 'YXZ'), keyQ = new THREE.Quaternion();
  const cv = new THREE.Vector3();
  const updateCipher = (now, u) => {
    cG.visible = CS.s > 0.002;
    if (!cG.visible) return;
    const tsec = now / 1000, b = inOut(clamp01(CS.build));
    envl.position.set(0, (1 - b) * -2.4, (1 - b) * -1.5);
    envl.rotation.set(EX + (1 - b) * 0.9, EY + (1 - b) * -0.5, (1 - b) * 0.25);
    envl.scale.setScalar(Math.max(0.0001, 0.6 + 0.4 * b));
    envShadow.material.opacity = b; envShadow.position.y = -0.38 + (1 - b) * -2.4;
    const cl = inOut(clamp01(CS.close));
    envFlap.rotation.x = -Math.PI * 0.96 * (1 - cl);
    flapShadow.visible = cl > 0.98;
    // stick comes in, its tip glows and a drop forms, falls, lands and spreads into a puddle
    const st = CS.stick, d = CS.drop;
    stick.visible = st > 0.002;
    stick.position.set(0.55 + (1 - st) * 1.6, SEAL_Y + 0.75 + (1 - st) * 0.8, 0.95);
    stick.rotation.set(0.35, 0, -0.55);
    tipMat.emissive.setRGB(0.5 * st, 0.12 * st, 0.02 * st);
    stick.updateMatrix(); cv.set(0, 0, 0).applyMatrix4(stick.matrix);
    const form = clamp01(d / 0.35), fall = clamp01((d - 0.35) / 0.3), spread = clamp01((d - 0.65) / 0.35);
    waxDrop.visible = d > 0.005 && fall < 1;
    waxDrop.position.set(cv.x + (0 - cv.x) * fall, cv.y - 0.12 * form + (SEAL_Y - cv.y + 0.12 * form) * fall * fall, cv.z + (ED / 2 + 0.05 - cv.z) * fall);
    waxDrop.scale.set(form * (1 - fall * 0.3), form * (1 + fall * 0.5), form);
    wseal.visible = spread > 0;
    const sp = spread > 0 ? Math.min(1, 0.25 + 0.75 * outBack(spread)) : 0.0001;
    wseal.scale.set(sp, sp, Math.max(0.0001, (spread > 0 ? 0.5 + 0.5 * spread : 0) * (1 - 0.35 * CS.dip)));
    // print, then the break: a hairline runs down the seal, the seal tenses, then snaps into two pieces
    // that shift apart on the paper, each twisting slightly, while a few flakes spring off the crack
    const cs = Math.round(clamp01(CS.brk / 0.42) * 12);
    const stampedNow = CS.stamped > 0.5, pk = (stampedNow ? 100 : 0) + cs;
    if (printTex.userData.k !== pk) { crackStep = cs; printStamped = stampedNow; printTex.userData.k = pk; printTex.userData.draw(); }
    const tense = CS.brk > 0.05 && CS.brk < 0.42 ? clamp01((CS.brk - 0.05) / 0.37) : 0;
    wseal.position.x = Math.sin(tsec * 90) * 0.006 * tense;
    const snap = clamp01((CS.brk - 0.42) / 0.2), se = 1 - Math.pow(1 - snap, 4);
    const MOVES = [[-0.06, 0.012, 0.07, -0.1], [0.08, -0.018, -0.09, 0.08]];
    pieces.forEach((g, i) => {
      const [mx, my, rz, ry] = MOVES[i];
      g.position.set(g.userData.home.x + mx * se, g.userData.home.y + my * se, 0.006 * Math.sin(snap * Math.PI));
      g.rotation.set(0, ry * se, rz * se);
    });
    flakes.forEach(m => {
      const { p, v, s, d } = m.userData, t = clamp01((CS.brk - 0.42 - d * 0.3) / 0.5);
      m.visible = t > 0 && t < 1;
      m.position.set(p.x + v.x * t, p.y + v.y * t - 1.6 * t * t, p.z + v.z * t);
      m.rotation.set(t * 8 * s, t * 5, t * 3); m.scale.setScalar(Math.max(0.0001, s * (1 - t * 0.5)));
    });
    // the writing on the envelope changes in the two attacks
    const wantF = CS.alt > 0.5 ? frontTex.altered : CS.swap > 0.5 ? frontTex.readdressed : frontTex.ok;
    if (frontMat.map !== wantF) { frontMat.map = wantF; frontMat.needsUpdate = true; }
    // the magnifier glides in over the changed character; a ring pulses around it
    winToLocal(altPos.x, altPos.y, cv);
    const mg = inOut(clamp01(CS.mag));
    mag.visible = mg > 0.002;
    mag.position.set(cv.x + (1 - mg) * 2.6, cv.y - (1 - mg) * 0.9, ED / 2 + 0.18 + bulge(cv.x, cv.y));
    mag.rotation.set(0, 0, (1 - mg) * 0.6);
    altRing.position.set(cv.x, cv.y, ED / 2 + 0.02 + bulge(cv.x, cv.y));
    const pulse = 0.5 + 0.5 * Math.sin(tsec * 6);
    altRing.material.opacity = CS.alt > 0.5 ? 0.55 + 0.4 * pulse : 0;
    altRing.scale.setScalar(1 + 0.25 * pulse);
  };

  /* ---------- the record rig: a brass chain, one link per audit entry ---------- */
  // "A chain is only as strong as its weakest link": every entry is a forged link with a tag. Someone edits #44;
  // a auLamp walks the chain from the first entry, finds that #44 no longer fits, and the chain parts there.
  const auG = new THREE.Group(); scene.add(auG);
  const chainG = new THREE.Group(); chainG.rotation.set(0.18, -0.32, 0); auG.add(chainG);
  const AU_ENTRIES = [
    ['#41', 'login', 'operator1', '3fa9'], ['#42', 'encrypt', 'operator1', 'b81d'], ['#43', 'key_rotate', 'admin', '0e47'],
    ['#44', 'decrypt', 'denied', '9d12'], ['#45', 'key_revoke', 'admin', '5c6a'], ['#46', 'audit_verify', 'admin', 'e203'],
  ];
  const AU_LEAD = 2, AU_PITCH = 0.66, AU_LINKS = AU_LEAD + AU_ENTRIES.length, AU_BAD = AU_LEAD + 3;
  const auLinkGeo = new THREE.TorusGeometry(0.3, 0.075, 16, 48);
  const auHalfGeo = new THREE.TorusGeometry(0.3, 0.075, 16, 24, Math.PI);
  const auLinkX = (i) => (i - (AU_LINKS - 1) / 2) * AU_PITCH;
  const auLinkY = (i) => { const x = auLinkX(i) / (AU_PITCH * AU_LINKS / 2); return 0.22 * (x * x - 1); };   // a gentle sag
  const AU_PAT = lin(0x5aa08f), AU_OXL = lin(0xc2451e), AU_BRL = new THREE.Color(0x6d8db7);
  const auTagTex = (e, variant) => canvasTex(256, 300, (x, w, h) => {
    paperFill(x, w, h, '#dce2e9');
    x.strokeStyle = 'rgba(23,42,68,0.35)'; x.lineWidth = 4; x.strokeRect(6, 6, w - 12, h - 12);
    x.fillStyle = '#6d8db7'; x.beginPath(); x.arc(w / 2, 34, 12, 0, Math.PI * 2); x.fill();
    x.fillStyle = '#dce2e9'; x.beginPath(); x.arc(w / 2, 34, 6, 0, Math.PI * 2); x.fill();
    x.textAlign = 'center'; x.textBaseline = 'middle';
    x.fillStyle = '#234168'; x.font = "500 54px 'JetBrains Mono', ui-monospace, monospace"; x.fillText(e[0], w / 2, 96);
    x.fillStyle = '#172a44'; x.font = "600 26px 'Hanken Grotesk', system-ui, sans-serif"; x.fillText(e[1], w / 2, 150);
    if (variant === 'edited') {
      x.font = "500 24px 'Hanken Grotesk', system-ui, sans-serif"; x.fillStyle = '#2d4e79'; x.fillText('denied', w / 2 - 46, 186);
      x.strokeStyle = '#c2451e'; x.lineWidth = 4; x.beginPath(); x.moveTo(w / 2 - 88, 188); x.lineTo(w / 2 - 4, 184); x.stroke();
      x.fillStyle = '#c2451e'; x.font = "700 26px 'Hanken Grotesk', system-ui, sans-serif"; x.fillText('success', w / 2 + 52, 186);
    } else { x.font = "500 24px 'Hanken Grotesk', system-ui, sans-serif"; x.fillStyle = '#2d4e79'; x.fillText(e[2], w / 2, 186); }
    x.fillStyle = 'rgba(23,42,68,0.6)'; x.font = "500 22px 'JetBrains Mono', ui-monospace, monospace"; x.fillText('hash ' + e[3] + '…', w / 2, 246);
  });
  const auTagGeo = new THREE.BoxGeometry(0.54, 0.64, 0.025);
  const auTagEdge = new THREE.MeshLambertMaterial({ color: lin(0xb1c2d8) });
  const auLinks = [], auTags = [];
  for (let i = 0; i < AU_LINKS; i++) {
    const mat = new THREE.MeshStandardMaterial({ color: 0x6d8db7, metalness: 1, roughness: 0.3, envMapIntensity: 1.2, transparent: i < AU_LEAD, opacity: 1, emissive: 0x000000 });
    const g = new THREE.Group(); chainG.add(g);
    if (i === AU_BAD) {
      const L = new THREE.Mesh(auHalfGeo, mat), R = new THREE.Mesh(auHalfGeo, mat);
      L.rotation.z = Math.PI / 2; R.rotation.z = -Math.PI / 2; g.add(L, R); g.userData.halves = [L, R];
      // rough fracture faces on the four broken ends
      const fracM = new THREE.MeshStandardMaterial({ color: lin(0x8a3a22), metalness: 0.6, roughness: 0.75, flatShading: true });
      const fracGeo = new THREE.DodecahedronGeometry(0.088, 0), fracs = [];
      [L, R].forEach(h => [0, Math.PI].forEach((a, k) => {
        const f = new THREE.Mesh(fracGeo, fracM); f.visible = false; fracs.push(f); f.position.set(Math.cos(a) * 0.3, Math.sin(a) * 0.3 + (k ? 0.01 : -0.01), 0);
        f.rotation.set(0.4 + k, 0.7 * k, 0.3); f.scale.set(1, 0.55, 1); h.add(f);
      }));
      g.userData.fracM = fracM; g.userData.fracs = fracs;
    } else g.add(new THREE.Mesh(auLinkGeo, mat));
    g.scale.set(1.55, 1, 1);
    g.userData.mat = mat; g.userData.flat = i % 2 === 1;   // the tampered link faces the viewer
    auLinks.push(g);
    if (i >= AU_LEAD) {
      const e = AU_ENTRIES[i - AU_LEAD];
      const tg = new THREE.Group(); chainG.add(tg);
      const ring = add(tg, new THREE.TorusGeometry(0.06, 0.016, 8, 24), brassM, 0, -0.02, 0);
      const face = new THREE.MeshLambertMaterial({ map: auTagTex(e, 'ok') });
      const card = new THREE.Mesh(auTagGeo, [auTagEdge, auTagEdge, auTagEdge, auTagEdge, face, face]); card.position.y = -0.4; tg.add(card);
      tg.userData = { face, ok: face.map, edited: i === AU_BAD ? auTagTex(e, 'edited') : null, card, ring };
      auTags.push(tg);
    } else auTags.push(null);
  }
  const auLamp = new THREE.Sprite(new THREE.SpriteMaterial({ map: haloTex, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending }));
  auLamp.scale.set(1.3, 1.3, 1); chainG.add(auLamp);
  const auLampRing = add(chainG, new THREE.TorusGeometry(0.5, 0.025, 8, 64), new THREE.MeshBasicMaterial({ color: 0x5aa08f, transparent: true, opacity: 0 }), 0, 0, 0, 0, Math.PI / 2, 0);
  const updateAudit = (now, u) => {
    domWorld(anchorEls.audit, 0, auG.position);
    auG.scale.setScalar(Math.max(0.0001, u * 1.3 * AS.s));
    auG.visible = AS.s > 0.002;
    if (!auG.visible) return;
    const tsec = now / 1000;
    const fall = clamp01((AS.brk - 0.25) / 0.75), fe = fall * fall;
    auLinks.forEach((g, i) => {
      const f = clamp01((AS.forge * (AU_LINKS + 1.2) - i) / 1.2), e = outBack(f);
      const x = auLinkX(i), y = auLinkY(i);
      g.position.set(x, y + (1 - e) * 1.2, (1 - f) * 0.8);
      g.rotation.set(g.userData.flat ? 0 : Math.PI / 2, 0, (1 - f) * 1.4);
      g.visible = f > 0.001;
      const m = g.userData.mat;
      if (i < AU_LEAD) m.opacity = (0.35 + 0.3 * i) * f;
      // verification auLamp tints the auLinks it has checked
      const checked = AS.scan * (AU_BAD - AU_LEAD + 0.5) + AU_LEAD - 0.3 >= i && i < AU_BAD;
      m.color.copy(AU_BRL).lerp(checked ? AU_PAT : AU_BRL, checked ? 0.75 : 0);
      if (i === AU_BAD) {
        const red = clamp01(AS.brk * 3);
        m.color.lerp(AU_OXL, red); m.emissive.setRGB(0.35 * red, 0.06 * red, 0);
        // turned three-quarters so the tube and the broken ends read in depth
        g.rotation.y = 0.55;
        const [L, R] = g.userData.halves, open = outBack(clamp01(AS.brk / 0.3));
        L.rotation.set(0, -open * 0.35, Math.PI / 2 + open * 0.45); L.position.set(-open * 0.05, 0, open * 0.06);
        const gone = 1 - clamp01((fall - 0.45) / 0.5);
        R.rotation.set(fall * 2.4, open * 0.4 + fall * 1.6, -Math.PI / 2 - open * 0.45 - fall * 1.8); R.position.set(open * 0.08, -fe * 2.6, open * 0.1);
        R.scale.setScalar(Math.max(0.0001, gone)); R.visible = fall < 0.95;
        g.userData.fracM.emissive.setRGB(0.4 * red, 0.1 * red, 0);
        // the fracture faces only exist once the link has actually broken
        const fs = clamp01(AS.brk / 0.12);
        g.userData.fracs.forEach(f => { f.visible = fs > 0.001; f.scale.set(fs, 0.55 * fs, fs); });
      }
      if (i > AU_BAD) {
        // the cut-off links fall, tumble and fade before they leave this section
        const gone = 1 - clamp01((fall - 0.45) / 0.5);
        g.position.y -= fe * 2.6; g.rotation.z += fall * (i % 2 ? 1.6 : -1.2); g.rotation.x += fall * 1.4;
        g.scale.set(1.55, 1, 1).multiplyScalar(Math.max(0.0001, gone)); if (fall >= 0.95) g.visible = false;
      }
      const tg = auTags[i];
      if (tg) {
        const ti = clamp01((AS.forge * (AU_LINKS + 1.2) - i - 0.6) / 1.0);
        tg.visible = ti > 0.001;
        tg.position.set(x, y - 0.32 - (1 - ti) * 0.3, 0.04);
        tg.rotation.set(0, 0, Math.sin(tsec * 1.4 + i) * 0.05 + (1 - ti) * 0.9);
        tg.scale.setScalar(Math.max(0.0001, ti));
        if (i === AU_BAD) {
          const ed = AS.edit; tg.rotation.y = inOut(ed) * Math.PI * 2;
          const want = ed > 0.5 ? tg.userData.edited : tg.userData.ok;
          if (tg.userData.face.map !== want) { tg.userData.face.map = want; tg.userData.face.needsUpdate = true; }
          tg.rotation.z += Math.sin(clamp01(AS.brk) * Math.PI * 3) * 0.25 * (1 - clamp01(AS.brk));
        }
        if (i > AU_BAD) {
          const gone = 1 - clamp01((fall - 0.45) / 0.5);
          tg.position.y -= fe * 2.6; tg.rotation.z += fall * 0.8; tg.scale.setScalar(Math.max(0.0001, ti * gone)); if (fall >= 0.95) tg.visible = false;
        }
      }
    });
    // the auLamp walks link to link and stops, red, at the first one that no longer fits
    const lp = AS.scan * (AU_BAD - AU_LEAD) + AU_LEAD, li = Math.min(AU_BAD, lp);
    const xa = auLinkX(Math.floor(li)), xb = auLinkX(Math.min(AU_LINKS - 1, Math.floor(li) + 1)), fr = li % 1;
    auLamp.position.set(xa + (xb - xa) * fr, auLinkY(Math.floor(li)) + (auLinkY(Math.floor(li) + 1) - auLinkY(Math.floor(li))) * fr, 0.25);
    const on = AS.scan > 0.001 ? 1 : 0, atBad = AS.scan >= 0.999;
    auLamp.material.opacity = on * (atBad ? 0.9 - 0.6 * clamp01(AS.brk * 2) : 0.75);
    auLamp.material.color.setRGB(atBad ? 1 : 0.6, atBad ? 0.45 : 1, atBad ? 0.35 : 0.85);
    auLampRing.position.copy(auLamp.position);
    auLampRing.material.opacity = on * (atBad ? 0.9 * (1 - clamp01(AS.brk * 2)) : 0.8);
    auLampRing.material.color.setRGB(atBad ? 0.76 : 0.35, atBad ? 0.27 : 0.63, atBad ? 0.12 : 0.56);
    auLampRing.scale.setScalar(1 + 0.08 * Math.sin(tsec * 6));
  };

  /* ---------- three roles rig: access badges on lanyards and a reader that answers each tap ---------- */
  // Heist-film access control: each role is a badge; tapped on the reader it lights green or red. The reader is the
  // server: the badge only says who you are, the reader decides what you may do.
  const roG = new THREE.Group(); scene.add(roG);
  const ROLE_DEF = [
    { name: 'Administrator', band: '#234168', line: 'Keys, users, settings, backups', id: 'KC-0001' },
    { name: 'Operator', band: '#4374b4', line: 'Encrypt and decrypt', id: 'KC-0007' },
    { name: 'Viewer', band: '#2d6a5c', line: 'Read only', id: 'KC-0013' },
  ];
  const badgeTex = (d) => canvasTex(512, 740, (x, w, h) => {
    paperFill(x, w, h, '#e0e5eb');
    x.fillStyle = d.band; x.fillRect(0, 0, w, 150);
    x.fillStyle = '#e0e5eb'; x.beginPath(); x.roundRect ? x.roundRect(w / 2 - 70, 40, 140, 26, 13) : x.rect(w / 2 - 70, 40, 140, 26); x.fill();
    x.fillStyle = 'rgba(224,229,235,0.85)'; x.font = "500 30px 'Hanken Grotesk', system-ui, sans-serif"; x.textAlign = 'center'; x.fillText('KeyCycle access', w / 2, 118);
    // emblem: a small key in a ring
    x.strokeStyle = d.band; x.lineWidth = 6; x.beginPath(); x.arc(w / 2, 280, 70, 0, Math.PI * 2); x.stroke();
    x.lineWidth = 8; x.beginPath(); x.arc(w / 2 - 22, 280, 18, 0, Math.PI * 2); x.stroke(); x.beginPath(); x.moveTo(w / 2 - 4, 280); x.lineTo(w / 2 + 42, 280); x.lineTo(w / 2 + 42, 298); x.moveTo(w / 2 + 26, 280); x.lineTo(w / 2 + 26, 294); x.stroke();
    x.fillStyle = '#1c3453'; x.font = "700 72px 'Hanken Grotesk', system-ui, sans-serif"; x.fillText(d.name, w / 2, 450);
    x.fillStyle = '#2d4e79'; x.font = "500 30px 'Hanken Grotesk', system-ui, sans-serif"; x.fillText(d.line, w / 2, 510);
    x.fillStyle = '#101e30'; x.fillRect(0, 600, w, 54);
    x.fillStyle = 'rgba(23,42,68,0.7)'; x.font = "500 26px 'JetBrains Mono', ui-monospace, monospace"; x.fillText(d.id, w / 2, 700);
  });
  const BW = 0.9, BH = 1.3;
  const badgeBody = new THREE.ExtrudeGeometry(roundRect(BW, BH, 0.07), { depth: 0.03, bevelEnabled: true, bevelThickness: 0.012, bevelSize: 0.012, bevelSegments: 2 });
  const badgeEdge = new THREE.MeshLambertMaterial({ color: lin(0xc3cedc) });
  const lanyardMats = ROLE_DEF.map(d => new THREE.MeshLambertMaterial({ color: lin(parseInt(d.band.slice(1), 16)), side: THREE.DoubleSide }));
  const badges = ROLE_DEF.map((d, i) => {
    const g = new THREE.Group(); roG.add(g);
    add(g, badgeBody, badgeEdge, 0, -BH / 2, -0.015);
    add(g, new THREE.PlaneGeometry(BW - 0.02, BH - 0.02), new THREE.MeshLambertMaterial({ map: badgeTex(d) }), 0, -BH / 2, 0.03);
    add(g, new THREE.BoxGeometry(0.22, 0.12, 0.06), brassM, 0, 0.02, 0.01);
    add(g, new THREE.TorusGeometry(0.06, 0.018, 8, 24), brassM, 0, 0.12, 0.01);
    const strap = new THREE.Mesh(new THREE.PlaneGeometry(0.12, 1), lanyardMats[i]); roG.add(strap);
    const peg = add(roG, new THREE.SphereGeometry(0.07, 16, 12), brassM, 0, 0, 0);
    g.userData.strap = strap; g.userData.peg = peg; return g;
  });
  const badgeRail = add(roG, new THREE.CylinderGeometry(0.025, 0.025, 1, 12), brassM, 0, 0, 0, 0, 0, Math.PI / 2);
  const railL = new THREE.Vector3(), railR = new THREE.Vector3();
  // the reader: a dark plate with a brass bezel, a tap target and a light ring
  const reader = new THREE.Group(); roG.add(reader);
  add(reader, new THREE.ExtrudeGeometry(roundRect(1.0, 1.4, 0.14), { depth: 0.22, bevelEnabled: true, bevelThickness: 0.04, bevelSize: 0.04, bevelSegments: 3 }), new THREE.MeshLambertMaterial({ color: lin(0x101e30) }), 0, 0, -0.22);
  add(reader, new THREE.TorusGeometry(0.34, 0.04, 12, 64), brassM, 0, 0.12, 0.06);
  const ledMat = new THREE.MeshBasicMaterial({ color: 0x555555 });
  add(reader, new THREE.TorusGeometry(0.26, 0.025, 10, 64), ledMat, 0, 0.12, 0.07);
  const glassM = new THREE.MeshLambertMaterial({ color: lin(0x172b45) });
  add(reader, new THREE.CircleGeometry(0.24, 48), glassM, 0, 0.12, 0.05);
  add(reader, new THREE.BoxGeometry(0.6, 0.06, 0.02), brassM, 0, -0.42, 0.04);
  const readerGlow = new THREE.Sprite(new THREE.SpriteMaterial({ map: haloTex, transparent: true, opacity: 0, depthWrite: false })); readerGlow.scale.set(1.6, 1.6, 1); reader.add(readerGlow); readerGlow.position.set(0, 0.12, 0.2);
  const GREEN = lin(0x3f9a84), REDR = lin(0xc2451e), IDLE = lin(0x33598a);
  const RESULT = [false, true, false];            // administrator refused (standard key), operator allowed, viewer refused
  const bv = new THREE.Vector3(), bv2 = new THREE.Vector3();
  const updateRoles = (now, u) => {
    roG.visible = RS.s > 0.002;
    if (!roG.visible) return;
    const tsec = now / 1000, sc = u * 1.15 * RS.s;
    domWorld(anchorEls.reader, 0, reader.position);
    const rd = inOut(clamp01(RS.reader));
    reader.position.x += (1 - rd) * 3 * u; reader.scale.setScalar(Math.max(0.0001, sc * rd)); reader.visible = rd > 0.002;
    reader.rotation.set(0, -0.25, 0);
    let led = 0, ok = true;
    badges.forEach((g, i) => {
      domWorld(anchorEls['badge' + i], 0, bv);
      const drop = outBack(clamp01((RS.drop * 1.5) - i * 0.25)), t = inOut(clamp01(RS['t' + i]));
      const home = bv.clone(); if (i === 0) railL.copy(home); if (i === 2) railR.copy(home);
      bv.y += (1 - drop) * 4 * u;
      // to the reader: the badge's face lands just in front of the tap target
      reader.localToWorld(bv2.set(-0.62, 0.32 + BH / 2, 0.3));
      g.position.copy(bv).lerp(bv2, t);
      g.scale.setScalar(Math.max(0.0001, sc));
      g.rotation.set(0, -0.25 * t + Math.sin(tsec * 1.1 + i) * 0.12 * (1 - t), Math.sin(tsec * 0.9 + i * 2) * 0.03 * (1 - t) + (1 - drop) * 0.3);
      g.visible = RS.drop * 1.5 - i * 0.25 > 0;
      if (RS['t' + i] > 0.97) { led = Math.max(led, clamp01((RS['t' + i] - 0.97) / 0.03)); ok = RESULT[i]; }
      // lanyard from high above the badge's home down to its clip
      const strap = g.userData.strap, top = home.clone(); top.y += 0.42 * sc; top.z -= 0.05; g.userData.peg.position.copy(top); g.userData.peg.visible = g.visible;
      // when the badge leaves for the reader it unclips, and the lanyard is left hanging from its peg
      const clip = bv.clone().add(bv2.set(0, 0.12 * sc, 0)).lerp(top.clone().add(bv2.set(0, -0.18 * sc, 0)), inOut(clamp01(t * 3)));
      const mid = top.clone().add(clip).multiplyScalar(0.5), len = top.distanceTo(clip);
      strap.position.copy(mid); strap.scale.set(sc, Math.max(0.0001, len), 1);
      strap.rotation.set(0, 0, Math.atan2(clip.x - top.x, top.y - clip.y));
      strap.visible = g.visible;
    });
    // the rail drops in with the first badge and spans out to the last one
    const railIn = clamp01(RS.drop * 1.5);
    badgeRail.visible = railIn > 0.001;
    badgeRail.position.copy(railL).add(railR).multiplyScalar(0.5); badgeRail.position.y += 0.42 * sc; badgeRail.position.z -= 0.07;
    badgeRail.scale.set(Math.max(0.0001, sc), Math.max(0.0001, (railL.distanceTo(railR) + 0.4 * sc) * inOut(railIn)), Math.max(0.0001, sc));
    badges.forEach(g => { g.userData.peg.scale.setScalar(Math.max(0.0001, sc)); });
    ledMat.color.copy(IDLE).lerp(ok ? GREEN : REDR, led);
    readerGlow.material.opacity = led * 0.6;
    readerGlow.material.color.copy(ok ? GREEN : REDR);
  };

  /* ---------- recovery drill rig: a backup strongbox restored under a bell jar ---------- */
  // Museum-heist calm rather than disaster movie: the backup is checked, its contents are lifted into a sealed glass
  // case, and only there is a key tested. The live vault is never touched.
  const rcG = new THREE.Group(); rcG.rotation.set(0.12, -0.25, 0); scene.add(rcG);
  const boxM = new THREE.MeshStandardMaterial({ color: 0x5f686e, metalness: 0.85, roughness: 0.55, envMapIntensity: 0.55 });
  const box = new THREE.Group(); box.position.set(-1.7, 0, 0); rcG.add(box);
  {
    const BWd = 1.5, BHt = 0.75, BDp = 1.0, T = 0.06;
    const velvet = new THREE.MeshLambertMaterial({ color: lin(0x122236) });
    add(box, new THREE.BoxGeometry(BWd, T, BDp), boxM, 0, T / 2, 0);
    add(box, new THREE.BoxGeometry(BWd, BHt, T), boxM, 0, BHt / 2, BDp / 2 - T / 2);
    add(box, new THREE.BoxGeometry(BWd, BHt, T), boxM, 0, BHt / 2, -BDp / 2 + T / 2);
    add(box, new THREE.BoxGeometry(T, BHt, BDp - 2 * T), boxM, -BWd / 2 + T / 2, BHt / 2, 0);
    add(box, new THREE.BoxGeometry(T, BHt, BDp - 2 * T), boxM, BWd / 2 - T / 2, BHt / 2, 0);
    // lining: floor and four inner walls, deep maroon velvet, so the inside reads as a cavity
    const iw = BWd - 2 * T - 0.004, idp = BDp - 2 * T - 0.004, ih = BHt - T - 0.01;
    add(box, new THREE.BoxGeometry(iw, 0.012, idp), velvet, 0, T + 0.006, 0);
    add(box, new THREE.BoxGeometry(iw, ih, 0.012), velvet, 0, T + ih / 2, idp / 2 - 0.006);
    add(box, new THREE.BoxGeometry(iw, ih, 0.012), velvet, 0, T + ih / 2, -idp / 2 + 0.006);
    add(box, new THREE.BoxGeometry(0.012, ih, idp), velvet, -iw / 2 + 0.006, T + ih / 2, 0);
    add(box, new THREE.BoxGeometry(0.012, ih, idp), velvet, iw / 2 - 0.006, T + ih / 2, 0);
    // brass rim along the opening
    add(box, new THREE.BoxGeometry(BWd + 0.02, 0.025, 0.07), brassM, 0, BHt, BDp / 2 - 0.035);
    add(box, new THREE.BoxGeometry(BWd + 0.02, 0.025, 0.07), brassM, 0, BHt, -BDp / 2 + 0.035);
    add(box, new THREE.BoxGeometry(0.07, 0.025, BDp), brassM, -BWd / 2 + 0.035, BHt, 0);
    add(box, new THREE.BoxGeometry(0.07, 0.025, BDp), brassM, BWd / 2 - 0.035, BHt, 0);
  }
  [[-1, -1], [1, -1], [-1, 1], [1, 1]].forEach(([sx, sz]) => [0.02, 0.73].forEach(y => add(box, new THREE.BoxGeometry(0.14, 0.14, 0.14), brassM, sx * 0.72, y, sz * 0.47)));
  const lid = new THREE.Group(); lid.position.set(0, 0.75, -0.5); box.add(lid);
  const lidM = new THREE.MeshStandardMaterial({ color: 0x5f686e, metalness: 0.8, roughness: 0.7, envMapIntensity: 0.25 });
  add(lid, new THREE.BoxGeometry(1.54, 0.14, 1.04), [lidM, lidM, lidM, new THREE.MeshLambertMaterial({ color: lin(0x122236) }), lidM, lidM], 0, 0.07, 0.5);
  add(lid, new THREE.TorusGeometry(0.16, 0.03, 8, 24, Math.PI), brassM, 0, 0.15, 0.5);
  // tamper tag on the front: a wax disc on a string; it turns green when the HMAC checks out
  const tagWax = new THREE.MeshLambertMaterial({ color: lin(0x2b4b75), emissive: 0x000000 });
  add(box, new THREE.CylinderGeometry(0.16, 0.17, 0.05, 32), tagWax, 0, 0.42, 0.53, Math.PI / 2);
  add(box, new THREE.BoxGeometry(0.02, 0.36, 0.01), new THREE.MeshLambertMaterial({ color: lin(0x1c3453) }), 0, 0.62, 0.51);
  const tagCheck = canvasTex(128, 128, (x) => { x.clearRect(0, 0, 128, 128); x.strokeStyle = '#e0e5eb'; x.lineWidth = 12; x.lineCap = 'round'; x.beginPath(); x.moveTo(38, 66); x.lineTo(56, 84); x.lineTo(92, 44); x.stroke(); });
  const checkMat = new THREE.MeshBasicMaterial({ map: tagCheck, transparent: true, opacity: 0, depthWrite: false });
  add(box, new THREE.PlaneGeometry(0.26, 0.26), checkMat, 0, 0.42, 0.56);
  // contents: a short audit chain and a key
  const content = new THREE.Group(); rcG.add(content);
  const miniLinkMats = [0, 1, 2].map(() => new THREE.MeshStandardMaterial({ color: 0x6d8db7, metalness: 1, roughness: 0.3, envMapIntensity: 1.2 }));
  const miniChain = new THREE.Group(); content.add(miniChain);
  miniLinkMats.forEach((m, i) => { const l = new THREE.Mesh(new THREE.TorusGeometry(0.13, 0.035, 10, 32), m); l.scale.set(1.5, 1, 1); l.position.x = (i - 1) * 0.3; l.rotation.x = i % 2 ? Math.PI / 2 : 0; miniChain.add(l); });
  const proofKey = key.clone(); proofKey.traverse(o => { if (o.isMesh) o.material = miniMat; }); proofKey.rotation.order = 'YXZ'; rcG.add(proofKey);
  // pedestal and bell jar
  const ped = new THREE.Group(); ped.position.set(1.6, 0, 0); rcG.add(ped);
  add(ped, new THREE.CylinderGeometry(0.75, 0.85, 0.16, 48), new THREE.MeshLambertMaterial({ color: lin(0x1c3352) }), 0, 0.08, 0);
  add(ped, new THREE.TorusGeometry(0.76, 0.03, 8, 64), brassM, 0, 0.16, 0, Math.PI / 2);
  const jar = new THREE.Group(); ped.add(jar);
  const glass = new THREE.MeshStandardMaterial({ color: 0xffffff, metalness: 0.1, roughness: 0.05, transparent: true, opacity: 0.26, envMapIntensity: 2, depthWrite: false, side: THREE.DoubleSide });
  add(jar, new THREE.CylinderGeometry(0.7, 0.7, 1.0, 48, 1, true), glass, 0, 0.66, 0);
  add(jar, new THREE.SphereGeometry(0.7, 48, 16, 0, Math.PI * 2, 0, Math.PI / 2), glass, 0, 1.16, 0);
  add(jar, new THREE.SphereGeometry(0.09, 16, 12), brassM, 0, 1.9, 0);
  add(jar, new THREE.TorusGeometry(0.71, 0.03, 8, 64), brassM, 0, 0.17, 0, Math.PI / 2);
  const jarGlow = new THREE.Sprite(new THREE.SpriteMaterial({ map: haloTex, transparent: true, opacity: 0, depthWrite: false })); jarGlow.scale.set(2.4, 2.4, 1); jarGlow.position.set(0, 0.7, 0); ped.add(jarGlow);
  // padlock that the restored key opens, and the proof it reveals
  const lock = new THREE.Group(); lock.position.set(0.18, 0.5, 0.05); ped.add(lock);
  add(lock, new THREE.BoxGeometry(0.36, 0.3, 0.16), new THREE.MeshLambertMaterial({ color: lin(0x234168) }), 0, 0, 0);
  const LOCK_FRONT = 0.08, KH_Y = -0.02;
  const kh = new THREE.Shape(); kh.absarc(0, 0.012, 0.026, 0, Math.PI * 2, false);
  const khSlot = new THREE.Shape(); khSlot.moveTo(-0.013, 0.005); khSlot.lineTo(0.013, 0.005); khSlot.lineTo(0.013, -0.075); khSlot.lineTo(-0.013, -0.075); khSlot.lineTo(-0.013, 0.005);
  const khMat = new THREE.MeshBasicMaterial({ color: 0x030508 });
  add(lock, new THREE.ShapeGeometry(kh, 24), khMat, 0, KH_Y, LOCK_FRONT + 0.002);
  add(lock, new THREE.ShapeGeometry(khSlot), khMat, 0, KH_Y, LOCK_FRONT + 0.002);
  add(lock, new THREE.TorusGeometry(0.052, 0.01, 8, 32), brassM, 0, KH_Y + 0.012, LOCK_FRONT + 0.004);
  const shackle = new THREE.Group(); lock.add(shackle);
  add(shackle, new THREE.TorusGeometry(0.11, 0.025, 8, 32, Math.PI), brassM, 0, 0.14, 0);
  const proofTag = add(ped, new THREE.PlaneGeometry(0.5, 0.2), new THREE.MeshBasicMaterial({ map: canvasTex(256, 100, (x, w, h) => { paperFill(x, w, h, '#e0e5eb'); x.strokeStyle = '#2d6a5c'; x.lineWidth = 4; x.strokeRect(3, 3, w - 6, h - 6); x.fillStyle = '#2d6a5c'; x.font = "500 40px 'JetBrains Mono', monospace"; x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText('payroll', w / 2, h / 2 + 2); }), transparent: true, opacity: 0 }), 0.18, 0.95, 0.12);
  const scanLamp = new THREE.Sprite(new THREE.SpriteMaterial({ map: haloTex, transparent: true, opacity: 0, depthWrite: false })); scanLamp.scale.set(0.9, 0.9, 1); rcG.add(scanLamp);
  const cvA = new THREE.Vector3(), cvB = new THREE.Vector3(), BRL_R = new THREE.Color(0x6d8db7), WAXC = lin(0x2b4b75);
  const updateRecovery = (now, u) => {
    domWorld(anchorEls.recov, 0, rcG.position);
    rcG.scale.setScalar(Math.max(0.0001, u * 1.05 * QS.s));
    rcG.visible = QS.s > 0.002;
    if (!rcG.visible) return;
    const tsec = now / 1000, inn = outBack(clamp01(QS.build));
    box.position.y = (1 - inn) * 2; box.scale.setScalar(Math.max(0.0001, inn));
    ped.position.y = (1 - inn) * -1.5; ped.scale.setScalar(Math.max(0.0001, inn));
    // 1: authenticate, a lamp passes over the tamper tag and it turns green
    const a1 = QS.auth;
    scanLamp.material.opacity = Math.sin(clamp01(a1) * Math.PI) * 0.8 + Math.sin(clamp01(QS.chain) * Math.PI) * 0.8;
    scanLamp.material.color.copy(GREEN);
    cvA.set(-1.7 - 0.6 + a1 * 1.2, 0.42, 0.75); scanLamp.position.copy(cvA);
    const ok1 = clamp01((a1 - 0.6) / 0.3);
    tagWax.color.copy(WAXC).lerp(GREEN, ok1); checkMat.opacity = ok1;
    // 2: the lid opens and the chain inside rises; the lamp walks it link by link
    lid.rotation.x = -inOut(clamp01(QS.open)) * 1.9;
    const rise = inOut(clamp01(QS.open * 1.4 - 0.4));
    // 3: the chain and the key float across into the glass case, which then lowers over them
    const mv = inOut(clamp01(QS.move)), arcY = Math.sin(mv * Math.PI) * 1.0;
    cvA.set(-1.7, 0.45 + rise * 0.65, 0); cvB.set(1.6 - 0.1, 0.62, 0);
    content.position.copy(cvA).lerp(cvB, mv); content.position.y += arcY;
    content.visible = QS.open > 0.3 || mv > 0;
    content.scale.setScalar(1 - mv * 0.15);
    miniChain.position.set(-0.1, 0.2, 0);
    if (QS.chain > 0 && QS.chain < 1) { scanLamp.position.set(content.position.x - 0.4 + QS.chain * 0.8, content.position.y + 0.2, 0.4); }
    miniLinkMats.forEach((m, i) => m.color.copy(BRL_R).lerp(GREEN, clamp01(QS.chain * 3 - i)));
    // 4: in the case, the key turns to point at the padlock, slides into its keyway, turns a quarter, and the
    // shackle springs open; the proof appears
    const cs = content.scale.x, sk = 0.13 * cs, TIP = 2.52 * sk;
    proofKey.visible = content.visible;
    proofKey.scale.setScalar(sk);
    cvA.set(-0.05 * cs, -0.12 * cs, 0.12 * cs).add(content.position);               // resting with the contents
    const ap = inOut(clamp01(QS.prove / 0.35)), push = inOut(clamp01((QS.prove - 0.35) / 0.15));
    const turn = inOut(clamp01((QS.prove - 0.5) / 0.15)), pop = outBack(clamp01((QS.prove - 0.62) / 0.23));
    // keyway centre in this scene's space (the pedestal and lock are not rotated inside it)
    cvB.set(ped.position.x + lock.position.x, ped.position.y + lock.position.y * ped.scale.y + (KH_Y + 0.012) * ped.scale.y, ped.position.z + lock.position.z + LOCK_FRONT);
    const front = cvB.clone(); front.z += TIP + 0.12;                                // lined up, tip just off the face
    const inside = cvB.clone(); inside.z += TIP - 0.06;                              // tip pushed in past the face
    proofKey.position.copy(cvA).lerp(front, ap).lerp(inside, push);
    proofKey.rotation.set(turn * Math.PI / 2, ap * Math.PI / 2, 0);
    shackle.position.y = pop * 0.1; shackle.rotation.y = pop * 1.2;
    const jl = inOut(clamp01(QS.jar));
    jar.position.y = (1 - jl) * 1.15; glass.opacity = 0.26 * clamp01(QS.build);
    jarGlow.material.opacity = 0.5 * clamp01(QS.prove * 1.2) + 0.2 * jl * Math.sin(tsec * 2) ** 2 * clamp01(QS.prove);
    jarGlow.material.color.copy(GREEN);
    proofTag.material.opacity = clamp01((QS.prove - 0.7) / 0.25); proofTag.position.y = 0.85 + proofTag.material.opacity * 0.12;
  };

  /* ---------- animated state ---------- */
  // K = key, V = vault. Their values are a pure function of scroll position (see TRACKS below),
  // so fast scrolling, jumping or reloading mid-page always lands on the right pose.
  const K = { s: 0.8, vis: 1, rx: 0, ry: 0.4, rz: -0.32, spin: 1, push: 0, glow: 0, dim: 0, red: 0 };
  const V = { s: 0, open: 0, wheel: 0, glow: 0, plug: 0 };
  const PS = { s: 0, type: 0, kb: 1, mill: 0, fly: 0, hash: 0, align: 0, cap: 0, out: 0 };
  const RS = { s: 0, drop: 0, reader: 0, t0: 0, t1: 0, t2: 0 };
  const QS = { s: 0, build: 0, auth: 0, open: 0, chain: 0, move: 0, jar: 0, prove: 0 };
  const AS = { s: 0, forge: 0, edit: 0, scan: 0, brk: 0 };
  const CS = { s: 0, build: 0, close: 0, stick: 0, drop: 0, dip: 0, stamped: 0, swap: 0, alt: 0, mag: 0, brk: 0 };
  const LS = { print: 1, use: 0, ghost: 0, clock: 0, tick: 0, brk: 0, seal: 0, out: 1 };
  const intro = { s: RM ? 1 : 0.2, rz: RM ? 0 : -1.2 };

  // anchor positions that depend on layout
  const placeAnchors = () => {
    const m = mobile();
    const set = (n, l, t) => { const el = $(`[data-anchor="${n}"]`); if (el) { el.style.left = l; el.style.top = t; } };
    set('vaultSpot', m ? '50%' : '74%', m ? '70%' : '52%');
    set('approach', '50%', m ? '50%' : '28%');
    set('vaultRest', m ? '50%' : '60%', m ? '90%' : '84%');
    set('life', m ? '50%' : '74%', m ? '80%' : '48%');
    set('pass', m ? '50%' : '72%', m ? '70%' : '46%');
    const ver = $('#ver'); ver.style.left = m ? '50%' : '74%'; ver.style.top = m ? '90%' : '66%';
  };
  placeAnchors();

  const tmp = new THREE.Vector3(), dir = new THREE.Vector3(), nrm = new THREE.Vector3();
  const domWorld = (el, z, out) => {
    const r = el.getBoundingClientRect();
    tmp.set(((r.left + r.width / 2) / innerWidth) * 2 - 1, -((r.top + r.height / 2) / innerHeight) * 2 + 1, 0.5).unproject(camera);
    dir.copy(tmp).sub(camera.position).normalize();
    const d = (z - camera.position.z) / dir.z;
    return out.copy(camera.position).addScaledVector(dir, d);
  };
  const anchorEls = {}; $$('[data-anchor]').forEach(el => anchorEls[el.dataset.anchor] = el);
  const unit = () => { const h = 2 * Math.tan(THREE.MathUtils.degToRad(17.5)) * 12; const w = h * camera.aspect; return THREE.MathUtils.clamp(Math.min(w / 13, h / 7.5), 0.38, 1); };

  /* ---------- scroll tracks ---------- */
  const ST = {}, TL = {};                       // filled in by the section builders below
  const I = (id, f) => () => { const s = ST[id + 'In']; return s ? s.start + f * (s.end - s.start) : 0; };
  const T = (id, t) => () => { const s = TL[id] && TL[id].scrollTrigger; return s ? s.start + (t / TL[id].duration()) * (s.end - s.start) : 0; };
  const P0 = () => 0;
  const PI = Math.PI, IN = PI / 2 - 0.6;
  const TRACKS = {
    'K.s':     [[I('vault', 0), 0.8], [I('vault', 1), 0.62], [T('vault', 1.6), 0.62], [T('vault', 3.8), 0.45], [T('vault', 6.4), 0.45], [T('vault', 8.2), 0.62], [I('passphrase', 0), 0.62], [I('passphrase', 1), 0.55], [T('passphrase', 10.1), 0.52], [T('passphrase', 11.2), 0.52], [T('passphrase', 12.0), 0.6], [I('lifecycle', 0), 0.6], [I('lifecycle', 1), 0.72], [I('ciphertext', 0), 0.72], [I('ciphertext', 1), 0.42], [I('final', 0), 0.42], [I('final', 1), 0.85]],
    'K.vis':   [[I('passphrase', 0), 1], [I('passphrase', 0.6), 0], [T('passphrase', 10.25), 0], [T('passphrase', 10.32), 1], [I('lifecycle', 0), 1], [I('lifecycle', 0.6), 0], [T('lifecycle', 1.2), 0], [T('lifecycle', 1.22), 1], [T('lifecycle', 9.4), 1], [T('lifecycle', 9.42), 0], [I('ciphertext', 0.3), 0], [I('ciphertext', 0.8), 1], [I('audit', 0), 1], [I('audit', 0.6), 0], [I('final', 0), 0], [I('final', 1), 1]],
    'K.rz':    [[T('vault', 1.6), -0.32], [T('vault', 3.8), 0], [T('vault', 6.4), 0], [T('vault', 8.2), -0.32], [I('passphrase', 0), -0.32], [I('passphrase', 1), 0], [T('passphrase', 10.2), 0], [T('passphrase', 10.25), CRZ], [T('passphrase', 11.2), CRZ], [T('passphrase', 12.0), 0]],
    'K.ry':    [[T('vault', 1.6), 0.4], [T('vault', 3.8), IN], [T('vault', 6.4), IN], [T('vault', 8.2), 0.4], [T('passphrase', 10.2), 0.4], [T('passphrase', 10.25), CRY], [T('passphrase', 11.2), CRY], [T('passphrase', 12.0), 0.4], [T('ciphertext', 2.4), 0.4], [T('ciphertext', 2.9), EY], [T('ciphertext', 4.2), EY], [T('ciphertext', 4.7), 0.4]],
    'K.spin':  [[T('vault', 1.6), 1], [T('vault', 3.8), 0], [T('vault', 6.4), 0], [T('vault', 8.2), 1], [T('passphrase', 9.7), 1], [T('passphrase', 10.2), 0], [T('passphrase', 11.3), 0], [T('passphrase', 12.2), 1], [T('lifecycle', 9.4), 1], [T('lifecycle', 10.4), 0.25], [I('ciphertext', 0), 0.25], [I('ciphertext', 1), 1], [T('ciphertext', 2.4), 1], [T('ciphertext', 2.9), 0], [T('ciphertext', 4.2), 0], [T('ciphertext', 4.7), 1]],
    'K.push':  [[T('vault', 3.8), 0], [T('vault', 4.7), 0.9], [T('vault', 6), 0.9], [T('vault', 6.8), 0]],
    'K.rx':    [[T('vault', 4.7), 0], [T('vault', 5.7), PI / 2], [T('vault', 6.4), PI / 2], [T('vault', 8.2), 0], [T('passphrase', 10.2), 0], [T('passphrase', 10.25), CRX], [T('passphrase', 11.2), CRX], [T('passphrase', 12.0), 0], [T('lifecycle', 5.4), 0], [T('lifecycle', 6.8), PI * 2], [T('ciphertext', 2.4), PI * 2], [T('ciphertext', 2.9), PI * 2 + EX], [T('ciphertext', 4.2), PI * 2 + EX], [T('ciphertext', 4.7), PI * 2]],
    'K.glow':  [[T('passphrase', 10.4), 0], [T('passphrase', 11.3), 1], [I('lifecycle', 0), 1], [I('lifecycle', 1), 0], [T('lifecycle', 3.6), 0], [T('lifecycle', 4.2), 0.8], [T('lifecycle', 4.8), 0], [T('ciphertext', 3.15), 0], [T('ciphertext', 3.5), 0.8], [T('ciphertext', 4.0), 0]],
    'K.dim':   [[T('lifecycle', 7.4), 0], [T('lifecycle', 8.4), 1], [T('lifecycle', 9.4), 1], [T('lifecycle', 10.4), 0.55], [I('ciphertext', 0), 0.55], [I('ciphertext', 1), 0]],
    'K.red':   [[T('lifecycle', 9.4), 0], [T('lifecycle', 10.4), 1], [I('ciphertext', 0), 1], [I('ciphertext', 1), 0]],
    'V.s':     [[T('vault', 0), 0], [T('vault', 1.8), 1], [I('passphrase', 0), 1], [I('passphrase', 0.8), 0]],
    'V.wheel': [[T('vault', 4.8), 0], [T('vault', 6.2), PI * 1.5]],
    'V.plug':  [[T('vault', 4.7), 0], [T('vault', 5.7), -PI / 2]],
    'V.open':  [[T('vault', 7.4), 0], [T('vault', 9.8), 1]],
    'L.print': [[T('lifecycle', 1.15), 1], [T('lifecycle', 1.2), 0], [T('lifecycle', 2.9), 1]],
    'L.use':   [[T('lifecycle', 3.0), 0], [T('lifecycle', 3.4), 1], [T('lifecycle', 4.9), 1], [T('lifecycle', 5.3), 0]],
    'L.ghost': [[T('lifecycle', 5.3), 0], [T('lifecycle', 6.3), 1], [T('lifecycle', 7.0), 1], [T('lifecycle', 7.4), 0]],
    'L.clock': [[T('lifecycle', 7.1), 0], [T('lifecycle', 7.5), 1], [T('lifecycle', 9.0), 1], [T('lifecycle', 9.3), 0]],
    'L.tick':  [[T('lifecycle', 7.5), 0], [T('lifecycle', 8.6), 1]],
    'L.brk':   [[T('lifecycle', 9.4), 0], [T('lifecycle', 10.2), 1]],
    'L.seal':  [[T('lifecycle', 9.9), 0], [T('lifecycle', 10.5), 1]],
    'L.out':   [[I('ciphertext', 0), 1], [I('ciphertext', 0.5), 0]],
    'C.s':     [[I('ciphertext', 0), 0], [I('ciphertext', 0.5), 1], [I('audit', 0), 1], [I('audit', 0.6), 0]],
    'C.build': [[I('ciphertext', 0.2), 0], [T('ciphertext', 1.6), 1]],
    'C.close': [[T('ciphertext', 1.7), 0], [T('ciphertext', 2.5), 1]],
    'C.stick': [[T('ciphertext', 2.1), 0], [T('ciphertext', 2.45), 1], [T('ciphertext', 2.95), 1], [T('ciphertext', 3.25), 0]],
    'C.drop':  [[T('ciphertext', 2.4), 0], [T('ciphertext', 3.05), 1]],
    'C.dip':   [[T('ciphertext', 3.05), 0], [T('ciphertext', 3.5), 1], [T('ciphertext', 3.7), 1], [T('ciphertext', 4.2), 0]],
    'C.stamped': [[T('ciphertext', 3.49), 0], [T('ciphertext', 3.51), 1]],
    'C.swap':  [[T('ciphertext', 4.7), 0], [T('ciphertext', 4.72), 1], [T('ciphertext', 5.95), 1], [T('ciphertext', 5.97), 0]],
    'C.alt':   [[T('ciphertext', 6.5), 0], [T('ciphertext', 6.52), 1]],
    'C.mag':   [[T('ciphertext', 6.5), 0], [T('ciphertext', 6.95), 1]],
    'C.brk':   [[T('ciphertext', 4.8), 0], [T('ciphertext', 5.75), 1], [T('ciphertext', 5.85), 1], [T('ciphertext', 6.1), 0], [T('ciphertext', 6.95), 0], [T('ciphertext', 7.9), 1]],
    'A.s':     [[I('audit', 0), 0], [I('audit', 0.5), 1], [I('roles', 0), 1], [I('roles', 0.6), 0]],
    'A.forge': [[T('audit', 0.8), 0], [T('audit', 3.2), 1]],
    'A.edit':  [[T('audit', 3.5), 0], [T('audit', 4.1), 1]],
    'A.scan':  [[T('audit', 4.4), 0], [T('audit', 6.3), 1]],
    'A.brk':   [[T('audit', 6.35), 0], [T('audit', 7.6), 1]],
    'R.s':     [[I('roles', 0), 0], [I('roles', 0.5), 1], [I('recovery', 0), 1], [I('recovery', 0.6), 0]],
    'R.drop':  [[T('roles', 0.6), 0], [T('roles', 2.2), 1]],
    'R.reader': [[T('roles', 2.0), 0], [T('roles', 2.7), 1]],
    'R.t1':    [[T('roles', 3.0), 0], [T('roles', 3.6), 1], [T('roles', 4.1), 1], [T('roles', 4.6), 0]],
    'R.t0':    [[T('roles', 4.8), 0], [T('roles', 5.4), 1], [T('roles', 5.9), 1], [T('roles', 6.4), 0]],
    'R.t2':    [[T('roles', 6.6), 0], [T('roles', 7.2), 1], [T('roles', 7.7), 1], [T('roles', 8.2), 0]],
    'Q.s':     [[I('recovery', 0), 0], [I('recovery', 0.5), 1], [I('final', 0), 1], [I('final', 0.6), 0]],
    'Q.build': [[T('recovery', 0.8), 0], [T('recovery', 1.9), 1]],
    'Q.auth':  [[T('recovery', 2.3), 0], [T('recovery', 3.3), 1]],
    'Q.open':  [[T('recovery', 3.5), 0], [T('recovery', 4.2), 1]],
    'Q.chain': [[T('recovery', 4.2), 0], [T('recovery', 4.9), 1]],
    'Q.move':  [[T('recovery', 5.1), 0], [T('recovery', 5.9), 1]],
    'Q.jar':   [[T('recovery', 5.9), 0], [T('recovery', 6.5), 1]],
    'Q.prove': [[T('recovery', 6.7), 0], [T('recovery', 8.0), 1]],
    'P.s':     [[I('passphrase', 0), 0], [I('passphrase', 1), 1], [I('lifecycle', 0), 1], [I('lifecycle', 0.6), 0]],
    'P.type':  [[T('passphrase', 1), 0], [T('passphrase', 4.6), PHRASE.length + 4]],
    'P.kb':    [[T('passphrase', 4.6), 1], [T('passphrase', 5.4), 0]],
    'P.mill':  [[T('passphrase', 4.8), 0], [T('passphrase', 5.8), 1], [T('passphrase', 11.0), 1], [T('passphrase', 11.7), 0]],
    'P.fly':   [[T('passphrase', 5.6), 0], [T('passphrase', 6.9), 1]],
    'P.hash':  [[T('passphrase', 6.9), 0], [T('passphrase', 9.6), 1]],
    'P.align': [[T('passphrase', 9.6), 0], [T('passphrase', 10.2), 1]],
    'P.cap':   [[T('passphrase', 10.3), 0], [T('passphrase', 11.2), 1]],
  };
  const PATH = [[P0, 'hero'], [I('vault', 0), 'hero'], [I('vault', 1), 'approach'], [T('vault', 1.6), 'approach'], [T('vault', 3.8), 'keyhole'],
    [T('vault', 6.4), 'keyhole'], [T('vault', 8.2), 'vaultRest'], [I('passphrase', 0), 'vaultRest'], [I('passphrase', 1), 'pass'], [T('passphrase', 10.2), 'pass'], [T('passphrase', 10.25), 'cryptex'], [T('passphrase', 11.2), 'cryptex'], [T('passphrase', 12.0), 'pass'],
    [I('lifecycle', 0), 'pass'], [I('lifecycle', 1), 'life'], [I('ciphertext', 0), 'life'], [I('ciphertext', 1), 'cipherKey'],
    [I('final', 0), 'cipherKey'], [I('final', 1), 'final']];
  const ease = (x) => x * x * (3 - 2 * x);
  const sample = (keys, y) => {
    let a = keys[0], av = a[0]();
    if (y <= av) return a[1];
    for (let i = 1; i < keys.length; i++) {
      const b = keys[i], bv = b[0]();
      if (y <= bv) return bv - av < 1e-6 ? b[1] : a[1] + (b[1] - a[1]) * ease((y - av) / (bv - av));
      a = b; av = bv;
    }
    return a[1];
  };
  const pathAt = (y) => {
    let av = PATH[0][0]();
    for (let i = 1; i < PATH.length; i++) {
      const bv = PATH[i][0]();
      if (y <= bv) return [PATH[i - 1][1], PATH[i][1], bv - av < 1e-6 ? 1 : ease((y - av) / (bv - av))];
      av = bv;
    }
    const n = PATH[PATH.length - 1][1]; return [n, n, 1];
  };
  const applyTracks = (y) => {
    const objs = { K, V, P: PS, L: LS, C: CS, A: AS, R: RS, Q: QS }; for (const k in TRACKS) { const [o, p] = k.split('.'); objs[o][p] = sample(TRACKS[k], y); }
  };

  let spin = 0, last = performance.now(), ys = scrollY, tracksReady = false;
  const P = new THREE.Vector3(), Q = new THREE.Vector3();
  const resize = () => {
    renderer.setSize(innerWidth, innerHeight, false);
    camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
    placeAnchors();
  };
  addEventListener('resize', resize); resize();

  /* ---------- guilloché background ---------- */
  // Engraved security-print rosettes, like a banknote. They breathe slowly, and each section
  // moves the rosette behind its main subject.
  const bgc = $('#lp-bg'), g = bgc.getContext('2d');
  let bw = 0, bh = 0, bd = 1;
  const bgResize = () => { bd = Math.min(devicePixelRatio, 1.5); bw = innerWidth; bh = innerHeight; bgc.width = bw * bd; bgc.height = bh * bd; };
  addEventListener('resize', bgResize); bgResize();
  const BGP = { //        hero  vault passph life  cipher audit roles recov final
    cx:  [0.50, 0.74, 0.70, 0.74, 0.50, 0.50, 0.15, 0.86, 0.50],
    cy:  [0.30, 0.52, 0.62, 0.48, 0.62, 0.58, 0.55, 0.30, 0.30],
    R:   [0.46, 0.40, 0.34, 0.38, 0.56, 0.62, 0.44, 0.36, 0.44],
    rot: [0.00, 0.60, 1.10, 1.70, 2.20, 2.90, 3.40, 4.00, 4.60],
  };
  const BG_IDS = ['vault', 'passphrase', 'lifecycle', 'ciphertext', 'audit', 'roles', 'recovery', 'final'];
  const BGT = {};
  for (const k in BGP) BGT[k] = [[P0, BGP[k][0]], ...BG_IDS.map((id, i) => [I(id, 1), BGP[k][i + 1]])];
  const RINGS = [[0.52, 24, 1], [0.78, 36, -1], [1.0, 48, 1]];
  const drawBg = (t, y) => {
    const cx = sample(BGT.cx, y) * bw, cy = sample(BGT.cy, y) * bh, R = sample(BGT.R, y) * Math.min(bw, bh) * 1.15, rot = sample(BGT.rot, y);
    g.setTransform(bd, 0, 0, bd, 0, 0); g.clearRect(0, 0, bw, bh);
    g.lineWidth = 0.7;
    const steps = 260, lines = 12;
    RINGS.forEach(([base, petals, dirn], ri) => {
      const amp = R * 0.055, b = R * base;
      g.strokeStyle = ri === 1 ? 'rgba(35,65,104,0.10)' : 'rgba(35,65,104,0.07)';
      for (let k = 0; k < lines; k++) {
        g.beginPath();
        const ph = k * 0.42 + t * 0.22 * dirn;
        for (let s2 = 0; s2 <= steps; s2++) {
          const th = (s2 / steps) * PI * 2;
          const rho = b + amp * Math.sin(petals * th + ph) + amp * 0.45 * Math.sin(5 * th - t * 0.13 * dirn + ri);
          const x = cx + rho * Math.cos(th + rot + t * 0.015 * dirn), yy = cy + rho * Math.sin(th + rot + t * 0.015 * dirn);
          s2 ? g.lineTo(x, yy) : g.moveTo(x, yy);
        }
        g.stroke();
      }
    });
  };

  const anchorPos = (n, ks, out) => {
    if (n === 'keyhole') {
      keyhole.getWorldPosition(out);
      nrm.set(0, 0, 1).applyQuaternion(vault.quaternion);
      return out.addScaledVector(nrm, (2.45 - K.push) * ks);
    }
    if (n === 'cryptex') return pp.localToWorld(cryptOut(out));
    if (n === 'cipherKey') {
      // hover above and to the right; when pressing, the bow centre sits on the seal
      sealWorld(lv2);
      keyEuler.set(K.rx, K.ry + spin, K.rz + intro.rz); keyQ.setFromEuler(keyEuler);
      tv.set(1.6 * ks, 0, 0).applyQuaternion(keyQ);
      const press = lv2.clone().add(tv); nrm.set(0, 0, 1).applyQuaternion(envl.getWorldQuaternion(new THREE.Quaternion()));
      press.addScaledVector(nrm, 0.02 * unit());
      const hover = cG.localToWorld(out.set(2.2, 2.2, 0.8));
      return out.copy(hover).lerp(press, inOut(clamp01(CS.dip)));
    }
    return domWorld(anchorEls[n], 0, out);
  };

  const frame = (now) => {
    if (!api.running) return;
    if (api.paused) { requestAnimationFrame(frame); return; }   // the sign-in card is covering the page
    const raw = (now - last) / 1000, dt = Math.min(0.05, raw); last = now;
    if (tracksReady && !RM) { ys += (scrollY - ys) * (1 - Math.exp(-Math.min(0.25, raw) * 7)); if (Math.abs(scrollY - ys) < 0.5) ys = scrollY; applyTracks(ys); }
    drawBg(RM ? 0 : now / 1000, RM ? scrollY : ys);
    const u = unit();
    // vault
    domWorld(anchorEls.vaultSpot, -1.4, vault.position);
    vault.scale.setScalar(Math.max(0.0001, u * 0.8 * V.s));
    vault.visible = V.s > 0.002;
    pivot.rotation.y = 1.75 * V.open;
    wheel.rotation.z = V.wheel;
    plug.rotation.z = V.plug;
    const lit = 0.35 + 0.65 * V.glow; steelIn.color.setScalar(lit); backWall.color.setScalar(lit); tagMat.color.copy(TAG).multiplyScalar(lit);
    lampMat.opacity = V.glow; vLight.intensity = V.glow * 1.6; vLight2.intensity = V.glow * 0.9;
    vault.updateMatrixWorld(true);
    // cipher rig placement (the key reads it)
    domWorld(anchorEls.cipher, 0, cG.position); cG.scale.setScalar(Math.max(0.0001, u * 1.05 * CS.s)); cG.updateMatrixWorld(true);
    // passphrase rig
    domWorld(anchorEls.pass, 0, pp.position);
    pp.scale.setScalar(Math.max(0.0001, u * 0.95 * PS.s));
    pp.visible = PS.s > 0.002;
    if (pp.visible) updatePP(now);
    // key
    const ks = u * K.s * K.vis * intro.s;
    if (RM) anchorPos('hero', ks, P);
    else {
      const [a, b, f] = pathAt(ys);
      anchorPos(a, ks, P);
      if (b !== a) { anchorPos(b, ks, Q); P.lerp(Q, f); }
    }
    if (!RM) {
      spin += dt * 0.45 * K.spin;
      if (K.spin < 0.999) { const tgt = Math.round(spin / (PI * 2)) * PI * 2; spin += (tgt - spin) * Math.min(1, (1 - K.spin) * 0.12); }
    }
    key.position.copy(P);
    key.position.y += RM ? 0 : Math.sin(now / 1400) * 0.06 * K.spin * u;
    key.rotation.set(K.rx, K.ry + spin, K.rz + intro.rz);
    key.scale.setScalar(Math.max(0.0001, ks));
    key.visible = ks > 0.002 && !api.keyHidden;
    key.updateMatrixWorld(true);
    updateLife(now, u, Math.max(0.0001, u * K.s * intro.s));
    updateCipher(now, u);
    updateAudit(now, u);
    updateRoles(now, u);
    updateRecovery(now, u);
    brass.color.copy(BRASS).lerp(DULL, K.dim * 0.85);
    brass.roughness = 0.26 + K.dim * 0.3;
    brass.emissive.setRGB(GLOW.r * K.glow * 0.28 + RED.r * K.red * 0.22, GLOW.g * K.glow * 0.2 + RED.g * K.red * 0.05, GLOW.b * K.glow * 0.08 + RED.b * K.red * 0.05);
    brass.color.lerp(REDDK, K.red * 0.55);
    renderer.render(scene, camera);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);

  /* ---------- helpers for scroll scenes ---------- */
  // Each pinned scene gets a fixed length (dur) so the key tracks above can address it in the same time units.
  const pinTL = (id, len, dur) => {
    const panel = $('#' + id);
    ST[id + 'In'] = ScrollTrigger.create({ trigger: panel, start: 'top bottom', end: 'top top' });
    const tl = RM ? gsap.timeline({ paused: true })
      : gsap.timeline({ defaults: { ease: 'power2.inOut' }, scrollTrigger: { trigger: panel, pin: true, start: 'top top', end: `+=${len}%`, scrub: 0.7, anticipatePin: 1 } });
    tl.to({}, { duration: dur }, 0);
    TL[id] = tl;
    return tl;
  };
  // Section transition: a brass horizon line draws across the boundary, the new section opens
  // out of it like light through a door gap, and the section above recedes.
  const panels = $$('main > .panel');
  const seam = (id) => {
    const panel = $('#' + id);
    if (!ST[id + 'In']) ST[id + 'In'] = ScrollTrigger.create({ trigger: panel, start: 'top bottom', end: 'top top' });
    if (RM) return;
    const idx = panels.indexOf(panel);
    const wrap = $('.clipwrap', panel), line = $(':scope > .horizon', panel);
    const prevPanel = panels[idx - 1];
    const prev = prevPanel && ($('.clipwrap', prevPanel) || $('.inner', prevPanel));
    const tl = gsap.timeline({ scrollTrigger: { trigger: panel, start: 'top bottom', end: 'top 15%', scrub: 0.6 } });
    tl.fromTo(line, { scaleX: 0, opacity: 1 }, { scaleX: 1, duration: 0.35, ease: 'power3.out', immediateRender: true }, 0)
      .to(line, { opacity: 0, duration: 0.25, ease: 'none' }, 0.75)
      .fromTo(wrap, { clipPath: 'ellipse(0% 0% at 50% 0%)' }, { clipPath: 'ellipse(120% 140% at 50% 0%)', duration: 0.9, ease: 'power2.inOut', immediateRender: true }, 0.1);
    if (prev) tl.fromTo(prev, { opacity: 1, scale: 1 }, { opacity: 0.2, scale: 0.97, duration: 1, ease: 'none', immediateRender: false }, 0);
  };
  const finish = (tl) => { if (RM) tl.progress(1); };

  /* ---------- hero intro ---------- */
  const heroIntro = () => {
    const txt = $('.wordmark text'), tag = $('.tagline');
    if (RM) { gsap.set(txt, { strokeDashoffset: 0, fillOpacity: 1 }); return; }
    const tl = gsap.timeline({ delay: 0.15 });
    tl.to(intro, { s: 1, rz: 0, duration: 2.2, ease: 'expo.out' }, 0)
      .to(txt, { strokeDashoffset: 0, duration: 2.6, ease: 'power2.inOut' }, 0.2)
      .to(txt, { fillOpacity: 1, strokeWidth: 0, duration: 1.1, ease: 'power2.out' }, 1.9);
    reveal(tl, tag, 1.9, 1.4);
    tl.from('#lp-signin, #landing .mark', { opacity: 0, y: -10, duration: 1, stagger: 0.1 }, 2.4);
  };
  (document.fonts && document.fonts.ready ? document.fonts.ready : Promise.resolve()).then(heroIntro);

  /* ---------- vault ---------- */
  seam('vault');
  {
    const tl = pinTL('vault', 230, 10.4), c = $('#vault');
    reveal(tl, $('.title', c), 0, 1.2);
    reveal(tl, $('.lede', c), 0.4, 1.4);
    reveal(tl, $('.body', c), 1.2, 1.8);
    $$('.facts li', c).forEach((li, i) => reveal(tl, li, 3.6 + i * 1.4, 1.2));
    finish(tl);
    if (RM) Object.assign(V, { s: 1, open: 1, glow: 1 });
  }

  /* ---------- passphrase ---------- */
  seam('passphrase');
  {
    const tl = pinTL('passphrase', 340, 13), c = $('#passphrase');
    const params = $$('.pp-caption .params span', c), out = $('.pp-caption .out', c);
    reveal(tl, $('.title', c), 0, 1.2);
    reveal(tl, $('.lede', c), 0.4, 1.2);
    $$('.body', c).forEach((b, i) => reveal(tl, b, 1 + i * 1.4, 1.6));
    tl.from($('.pp-caption', c), { opacity: 0, y: 16, duration: 1 }, 0.6);
    const passEl = params[2];
    const pState = (t) => {
      params.forEach((p, i) => p.classList.toggle('on', t >= 6.4 + i * 0.25));
      const pr = (t - 6.9) / 2.7;   // matches P.hash, eased the same way
      const e = Math.max(0, Math.min(1, pr)), eh = e * e * (3 - 2 * e);
      passEl.textContent = pr > 0 && pr < 1 ? `pass ${Math.min(3, Math.floor(eh * 3) + 1)} of 3` : '3 passes';
      out.classList.toggle('show', t >= 11.4);
    };
    tl.eventCallback('onUpdate', () => pState(tl.time()));
    finish(tl); pState(RM ? 99 : 0);
  }

  /* ---------- lifecycle ---------- */
  seam('lifecycle');
  {
    const tl = pinTL('lifecycle', 320, 11.4), c = $('#lifecycle');
    const lis = $$('.stages li', c), cards = $$('.stage-card', c), ver = $('#ver');
    gsap.set(cards, { opacity: 0 }); gsap.set(cards[0], { opacity: 1 });
    reveal(tl, $('.title', c), 0, 1.2);
    reveal(tl, $('.lede', c), 0.4, 1.2);
    tl.from(lis, { opacity: 0, y: 12, stagger: 0.12, duration: 0.6 }, 0.6)
      .from(cards[0].children, { opacity: 0, y: 14, filter: 'blur(6px)', stagger: 0.15, duration: 0.8 }, 0.8)
      .from(ver, { opacity: 0, scale: 0.6, duration: 0.6 }, 0.9);
    const S = [1.2, 3.2, 5.2, 7.2, 9.2];
    for (let i = 1; i < 5; i++) {
      tl.to(cards[i - 1], { opacity: 0, y: -12, filter: 'blur(6px)', duration: 0.5 }, S[i])
        .fromTo(cards[i], { opacity: 0, y: 14, filter: 'blur(6px)' }, { opacity: 1, y: 0, filter: 'blur(0px)', duration: 0.7, immediateRender: false }, S[i] + 0.35);
    }
    const prog = () => {
      const t = tl.time();
      let s = 0; S.forEach((x, i) => { if (t >= x) s = i; });
      lis.forEach((li, i) => { li.classList.toggle('on', i === s); li.classList.toggle('done', i < s); });
      ver.textContent = t >= 9.4 ? 'revoked' : t >= 7.4 ? 'v2 expired' : t >= 6.1 ? 'v2 current, v1 retired' : 'v1 current';
      ver.classList.toggle('bad', t >= 7.4);
    };
    tl.eventCallback('onUpdate', prog);
    finish(tl); prog();
  }

  /* ---------- ciphertext ---------- */
  seam('ciphertext');
  {
    const tl = pinTL('ciphertext', 260, 9, ), c = $('#ciphertext');
    const verdict = $('.verdict', c), why = $('#verdict-why');
    reveal(tl, $('.title', c), 0, 1.2);
    reveal(tl, $('.lede', c), 0.4, 1.4);
    reveal(tl, $('.body', c), 1, 1.4);
    let last = '';
    const cState = (t) => {
      const k = t >= 7.3 ? 'flip' : t >= 5.1 && t < 5.95 ? 'swap' : 'none';
      if (k === last) return; last = k;
      why.textContent = k === 'flip' ? 'One character changed: seal broken, decryption refused' : 'Readdressed to key 9: seal broken, decryption refused';
      gsap.to(verdict, { opacity: k === 'none' ? 0 : 1, y: k === 'none' ? 12 : 0, duration: 0.35, overwrite: true });
    };
    tl.eventCallback('onUpdate', () => cState(tl.time()));
    finish(tl); cState(RM ? 99 : 0);
  }

  /* ---------- audit ---------- */
  seam('audit');
  {
    const tl = pinTL('audit', 240, 8.6), c = $('#audit');
    const status = $('#audit-status');
    reveal(tl, $('.title', c), 0, 1.2);
    reveal(tl, $('.lede', c), 0.4, 1.4);
    reveal(tl, $('.body', c), 1, 1.6);
    let lastPhase = -1;
    const aState = (t) => {
      const phase = t < 3.5 ? 0 : t < 4.4 ? 1 : t < 6.35 ? 2 : 3;
      if (phase === lastPhase) return; lastPhase = phase;
      status.innerHTML = ['&nbsp;', 'Someone edits entry #44 to hide a denied request.', 'Verifying from entry #41…',
        'Verification failed. <strong>The first entry that no longer fits is #44.</strong>'][phase];
    };
    tl.eventCallback('onUpdate', () => aState(tl.time()));
    finish(tl); aState(RM ? 99 : 0);
  }

  /* ---------- roles ---------- */
  seam('roles');
  {
    const tl = pinTL('roles', 260, 9), c = $('#roles'), cap = $('#tap-caption');
    reveal(tl, $('.title', c), 0, 1.2);
    reveal(tl, $('.lede', c), 0.4, 1.4);
    $$('.role', c).forEach((rl, i) => { reveal(tl, $('h3', rl), 1.2 + i * 0.25, 1.1); reveal(tl, $('p', rl), 1.5 + i * 0.25, 1.3); });
    const CAPS = [
      '&nbsp;',
      '<strong>Operator</strong>: encrypt with a standard key<br><span class="ok">Allowed</span>',
      '<strong>Administrator</strong>: encrypt with a standard key<br><span class="no">Refused, administrators use test keys only</span> <code>FORBIDDEN</code>',
      '<strong>Viewer</strong>: decrypt a package<br><span class="no">Refused, viewers only read</span> <code>FORBIDDEN</code>',
    ];
    let lastC = -1;
    const rState = (t) => {
      const k = t >= 7.15 ? 3 : t >= 5.35 ? 2 : t >= 3.55 ? 1 : 0;
      if (k === lastC) return; lastC = k;
      cap.innerHTML = CAPS[k];
      if (!RM) gsap.fromTo(cap, { opacity: 0, y: 8 }, { opacity: 1, y: 0, duration: 0.35, overwrite: true });
    };
    tl.eventCallback('onUpdate', () => rState(tl.time()));
    finish(tl); rState(RM ? 0 : 0);
  }

  /* ---------- recovery ---------- */
  seam('recovery');
  {
    const tl = pinTL('recovery', 250, 9.2), c = $('#recovery'), steps = $$('.steps li', c);
    reveal(tl, $('.title', c), 0, 1.2);
    reveal(tl, $('.lede', c), 0.4, 1.4);
    reveal(tl, $('.body', c), 1, 1.6);
    tl.from(steps, { opacity: 0, y: 20, filter: 'blur(6px)', stagger: 0.2, duration: 0.8 }, 1.2)
      .to($('.steps .fill', c), { scaleX: 1, duration: 5.6, ease: 'none' }, 2.3);
    const ON = [3.2, 4.9, 6.4, 7.9];
    const rState = (t) => steps.forEach((x, j) => x.classList.toggle('on', t >= ON[j]));
    tl.eventCallback('onUpdate', () => rState(tl.time()));
    finish(tl); rState(RM ? 99 : 0);
  }

  /* ---------- finale ---------- */
  seam('final');
  $$('#final [data-split]').forEach(el => {
    if (RM) return;
    const chars = el._mode === 'chars';
    gsap.from(el._parts, { ...(chars ? charsFrom : wordsFrom), duration: 1.2, ease: chars ? 'expo.out' : 'power3.out', stagger: { amount: chars ? 0.5 : 0.6 },
      scrollTrigger: { trigger: el, start: 'top 85%', toggleActions: 'play none none reverse' } });
  });
  ScrollTrigger.addEventListener('refresh', () => { tracksReady = true; ys = scrollY; });
  ScrollTrigger.refresh();


  /* ---------- sign in: hand the key to the app's sign-in card ---------- */
  const AUTH_H = 2 * 12 * Math.tan(THREE.MathUtils.degToRad(15));          // the sign-in key's camera
  const LAND_H = 2 * 12 * Math.tan(THREE.MathUtils.degToRad(17.5));        // this page's camera
  api.keyScreen = () => {
    key.updateMatrixWorld(true);
    const v = key.position.clone().project(camera);
    return { x: (v.x + 1) / 2 * innerWidth, y: (1 - v.y) / 2 * innerHeight, s: key.scale.x * AUTH_H / LAND_H,
      visible: key.visible, rx: key.rotation.x, ry: key.rotation.y, rz: key.rotation.z };
  };
  const openAuth = () => { if (window.KCApp) window.KCApp.openAuth({ from: api.keyScreen() }); };
  $$('#lp-signin, [data-open-signin]').forEach(b => b.addEventListener('click', openAuth));
  api.stop = () => {
    api.running = false;
    ScrollTrigger.getAll().forEach(t => t.kill(true));
    renderer.dispose();
  };

  if (document.readyState === 'complete') ScrollTrigger.refresh(); else addEventListener('load', () => ScrollTrigger.refresh());
  };
  api.stop = () => {};
  api.keyScreen = () => null;
  return api;
})();
