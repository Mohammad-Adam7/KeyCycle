/* KeyCycle 3D helpers shared by the app's small scenes (dashboard vault, audit chain, key drawer,
   sign-in key). Each scene is a Stage: it owns one canvas, sizes itself to that canvas, and only
   renders while the canvas is on screen and the tab is visible, so idle pages cost nothing. */
window.KC3D = (() => {
  const T = THREE;
  const lin = (hex) => new T.Color(hex).convertSRGBToLinear();
  // Some machines have WebGL switched off. The app still works there, just without its 3D pieces.
  const ok = (() => {
    try { const c = document.createElement('canvas'); return Boolean(window.WebGLRenderingContext && (c.getContext('webgl') || c.getContext('experimental-webgl'))); }
    catch (_) { return false; }
  })();

  // A soft studio: dark below, warm above, three softboxes. Metal needs something to reflect.
  const makeEnv = (renderer) => {
    const pm = new T.PMREMGenerator(renderer), env = new T.Scene();
    const sg = new T.SphereGeometry(20, 24, 12), cols = [], pa = sg.attributes.position;
    for (let i = 0; i < pa.count; i++) {
      const t = (pa.getY(i) / 20 + 1) / 2, c = new T.Color(0x0b0e11).lerp(new T.Color(0x2c4c76), t);
      cols.push(c.r, c.g, c.b);
    }
    sg.setAttribute('color', new T.Float32BufferAttribute(cols, 3));
    env.add(new T.Mesh(sg, new T.MeshBasicMaterial({ vertexColors: true, side: T.BackSide })));
    const box = (x, y, z, w, h, k) => {
      const m = new T.Mesh(new T.PlaneGeometry(w, h), new T.MeshBasicMaterial({ color: new T.Color(k, k * 0.93, k * 0.82), side: T.DoubleSide }));
      m.position.set(x, y, z); m.lookAt(0, 0, 0); env.add(m);
    };
    box(0, 9, 5, 12, 4, 3.2); box(-11, 2, 3, 4, 9, 1.6); box(10, -3, 6, 3, 9, 1.2);
    const tex = pm.fromScene(env, 0.04).texture;
    pm.dispose();
    return tex;
  };
  const addLights = (scene) => {
    scene.add(new T.AmbientLight(0xffffff, 0.2));
    const sun = new T.DirectionalLight(0xeaedf1, 1.3); sun.position.set(-4, 6, 8); scene.add(sun);
  };
  const add = (parent, geo, mat, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0) => {
    const m = new T.Mesh(geo, mat); m.position.set(x, y, z); m.rotation.set(rx, ry, rz); parent.add(m); return m;
  };
  const brass = () => new T.MeshStandardMaterial({ color: 0x6d8db7, metalness: 1, roughness: 0.27, envMapIntensity: 1.25, emissive: 0x000000 });
  const steel = () => new T.MeshStandardMaterial({ color: 0x7a848b, metalness: 1, roughness: 0.32 });

  // The KeyCycle key: bow with an inner ring and four spokes, collar, shaft, four teeth.
  // About 5.2 units long, centred on its length, lying along +x with the teeth below.
  const buildKey = (mat) => {
    const k = new T.Group(); k.rotation.order = 'YXZ';
    add(k, new T.TorusGeometry(0.85, 0.2, 28, 80), mat, -1.6, 0, 0);
    add(k, new T.TorusGeometry(0.42, 0.07, 14, 56), mat, -1.6, 0, 0);
    add(k, new T.SphereGeometry(0.15, 20, 14), mat, -1.6, 0, 0);
    for (let i = 0; i < 4; i++) {
      const a = i * Math.PI / 2 + Math.PI / 4;
      add(k, new T.CylinderGeometry(0.045, 0.045, 0.3, 10), mat, -1.6 + Math.cos(a) * 0.54, Math.sin(a) * 0.54, 0, 0, 0, a - Math.PI / 2);
    }
    add(k, new T.CylinderGeometry(0.25, 0.25, 0.26, 28), mat, -0.43, 0, 0, 0, 0, Math.PI / 2);
    add(k, new T.CylinderGeometry(0.14, 0.14, 2.75, 24), mat, 1.0, 0, 0, 0, 0, Math.PI / 2);
    add(k, new T.SphereGeometry(0.14, 20, 14), mat, 2.38, 0, 0);
    [[1.62, 0.55], [1.84, 0.34], [2.06, 0.7], [2.26, 0.44]].forEach(([x, h]) => add(k, new T.BoxGeometry(0.18, h, 0.16), mat, x, -0.13 - h / 2, 0));
    return k;
  };

  // A round vault door in a thick collar, hinged on the right, with a wheel and a brass keyhole.
  const buildVault = () => {
    const st = steel(), stD = new T.MeshStandardMaterial({ color: 0x545e65, metalness: 1, roughness: 0.38, side: T.DoubleSide }), br = brass();
    const g = new T.Group();
    const cs = new T.Shape(); cs.absarc(0, 0, 3.0, 0, Math.PI * 2, false);
    const ch = new T.Path(); ch.absarc(0, 0, 2.2, 0, Math.PI * 2, true); cs.holes.push(ch);
    add(g, new T.ExtrudeGeometry(cs, { depth: 0.9, bevelEnabled: true, bevelThickness: 0.08, bevelSize: 0.08, bevelSegments: 3, curveSegments: 72 }), st, 0, 0, -0.9);
    for (let i = 0; i < 14; i++) { const a = i / 14 * Math.PI * 2; add(g, new T.SphereGeometry(0.06, 10, 8), st, Math.cos(a) * 2.62, Math.sin(a) * 2.62, 0.07); }
    const glow = new T.MeshBasicMaterial({ color: 0x9cb2ce, transparent: true, opacity: 0 });
    add(g, new T.CircleGeometry(2.2, 64), glow, 0, 0, -0.85);
    const pivot = new T.Group(); pivot.position.set(2.5, 0, 0.36); g.add(pivot);
    const door = new T.Group(); door.position.set(-2.5, 0, 0); pivot.add(door);
    const prof = [[0, 0.7], [1.55, 0.7], [1.62, 0.64], [1.95, 0.64], [2.02, 0.55], [2.3, 0.55], [2.45, 0.42], [2.45, 0.06], [2.38, 0], [0, 0]].map(([x, y]) => new T.Vector2(x, y));
    add(door, new T.LatheGeometry(prof, 96), stD, 0, 0, -0.35, Math.PI / 2);
    for (let i = 0; i < 18; i++) { const a = i / 18 * Math.PI * 2; add(door, new T.SphereGeometry(0.045, 10, 8), st, Math.cos(a) * 2.16, Math.sin(a) * 2.16, 0.21); }
    const wheel = new T.Group(); wheel.position.set(0, 0.45, 0.53); door.add(wheel);
    add(wheel, new T.TorusGeometry(0.8, 0.08, 16, 64), st);
    for (let i = 0; i < 3; i++) add(wheel, new T.BoxGeometry(1.6, 0.1, 0.1), st, 0, 0, 0, 0, 0, i * Math.PI / 3);
    for (let i = 0; i < 6; i++) { const a = i / 6 * Math.PI * 2; add(wheel, new T.SphereGeometry(0.12, 14, 10), br, Math.cos(a) * 0.8, Math.sin(a) * 0.8, 0); }
    add(wheel, new T.CylinderGeometry(0.22, 0.26, 0.24, 28), st, 0, 0, -0.06, Math.PI / 2);
    add(door, new T.TorusGeometry(0.34, 0.06, 10, 40), br, 0, -1.25, 0.38);
    add(door, new T.CircleGeometry(0.3, 32), new T.MeshBasicMaterial({ color: 0x04080d }), 0, -1.25, 0.37);
    return { group: g, pivot, wheel, glow };
  };

  // A short chain of interlocking links, alternating flat and edge-on.
  const buildChain = (n = 7, pitch = 0.64) => {
    const g = new T.Group(), geo = new T.TorusGeometry(0.3, 0.075, 16, 48), links = [];
    for (let i = 0; i < n; i++) {
      const m = new T.Mesh(geo, brass());
      m.scale.set(1.55, 1, 1); m.position.x = (i - (n - 1) / 2) * pitch; m.rotation.x = i % 2 ? Math.PI / 2 : 0;
      g.add(m); links.push(m);
    }
    return { group: g, links };
  };

  // A canvas with its own renderer, camera and scene that renders only while visible.
  class Stage {
    constructor(canvas, { fov = 30, z = 12, env = true } = {}) {
      this.canvas = canvas;
      this.renderer = new T.WebGLRenderer({ canvas, antialias: true, alpha: true });
      this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
      this.renderer.outputEncoding = T.sRGBEncoding;
      this.renderer.toneMapping = T.ACESFilmicToneMapping;
      this.scene = new T.Scene();
      this.camera = new T.PerspectiveCamera(fov, 1, 0.1, 60); this.camera.position.set(0, 0, z);
      if (env) this.scene.environment = makeEnv(this.renderer);
      addLights(this.scene);
      this.onFrame = null; this.visible = true; this.forced = false;
      if ('IntersectionObserver' in window) {
        this.io = new IntersectionObserver((es) => { this.visible = es.some(e => e.isIntersecting); });
        this.io.observe(canvas);
      }
      this.loop = this.loop.bind(this);
      requestAnimationFrame(this.loop);
    }
    fit() {
      const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
      if (!w || !h) return false;
      const pr = this.renderer.getPixelRatio();
      if (this.canvas.width !== Math.round(w * pr) || this.canvas.height !== Math.round(h * pr)) {
        this.renderer.setSize(w, h, false); this.camera.aspect = w / h; this.camera.updateProjectionMatrix();
      }
      return true;
    }
    loop(now) {
      if (this.disposed) return;
      requestAnimationFrame(this.loop);
      if (document.hidden || (!this.visible && !this.forced) || !this.fit()) return;
      if (this.onFrame) this.onFrame(now / 1000);
      this.renderer.render(this.scene, this.camera);
    }
    dispose() { this.disposed = true; if (this.io) this.io.disconnect(); this.renderer.dispose(); }
  }

  return { ok, T, lin, makeEnv, addLights, add, brass, steel, buildKey, buildVault, buildChain, Stage };
})();
