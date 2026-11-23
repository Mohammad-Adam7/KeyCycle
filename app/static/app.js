/* KeyCycle app controller.
   One class, KeyCycleApp, runs the sign-in screen and the signed-in app. It talks to the API with
   fetch, keeps the CSRF token from the session in memory, and renders every view with template
   strings in which every value that came from the server goes through this.escape(). */

class ApiError extends Error {
  constructor(status, code, message, body) {
    super(message);
    this.status = status; this.code = code; this.body = body || null;
  }
}

class KeyCycleApp {
  constructor() {
    this.RM = matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.user = null; this.csrf = null; this.vaultLocked = true;
    this.current = null; this.keys = []; this.target = null;
    this.ROUTES = { dashboard: '/dashboard', keys: '/keys', crypto: '/crypto', history: '/history', audit: '/audit', backup: '/backup', admin: '/admin' };
    this.TITLES = { dashboard: 'Dashboard', keys: 'Keys', crypto: 'Encrypt and decrypt', history: 'Decision history', audit: 'Audit chain', backup: 'Backups and recovery', admin: 'Users and settings' };
    this.VIEW_ROLES = { crypto: ['administrator', 'operator'], audit: ['administrator'], backup: ['administrator'], admin: ['administrator'] };
  }

  /* ---------- small helpers ---------- */
  escape(str) {
    if (str === null || str === undefined) return '';
    return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  $(s, r = document) { return r.querySelector(s); }
  $$(s, r = document) { return Array.from(r.querySelectorAll(s)); }
  ago(iso) {
    if (!iso) return '';
    const t = Date.parse(iso); if (Number.isNaN(t)) return iso;
    const s = Math.round((Date.now() - t) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.round(s / 60)} min ago`;
    if (s < 86400) return `${Math.round(s / 3600)} h ago`;
    return new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  }
  day(iso) { if (!iso) return '—'; const t = Date.parse(iso); return Number.isNaN(t) ? iso : new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }); }
  daysUntil(iso) { if (!iso) return null; return Math.max(0, Math.ceil((Date.parse(iso) - Date.now()) / 86400000)); }
  roleName(r) { return { administrator: 'Administrator', operator: 'Operator', viewer: 'Viewer' }[r] || r; }
  can(view) { const need = this.VIEW_ROLES[view]; return !need || Boolean(this.user && need.includes(this.user.role)); }
  isAdmin() { return Boolean(this.user && this.user.role === 'administrator'); }

  /* ---------- API ---------- */
  async api(method, path, body) {
    const opts = { method, headers: { Accept: 'application/json' }, credentials: 'same-origin' };
    if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    if (method !== 'GET' && this.csrf) opts.headers['X-CSRF-Token'] = this.csrf;
    let res;
    try { res = await fetch(path, opts); } catch (_) { throw new ApiError(0, 'NETWORK', 'The server could not be reached.'); }
    let data = null;
    try { data = await res.json(); } catch (_) { data = null; }
    if (!res.ok) {
      const err = new ApiError(res.status, (data && data.code) || `HTTP_${res.status}`, (data && data.message) || 'The request failed.', data);
      if (err.code === 'SESSION_EXPIRED' && this.user && !path.startsWith('/api/auth/')) this.sessionEnded();
      throw err;
    }
    return data;
  }
  async allKeys() {
    const out = []; let after = 0;
    for (let page = 0; page < 20; page++) {
      const res = await this.api('GET', `/api/keys?limit=100&after_id=${after}`);
      out.push(...res.data.items);
      if (res.data.next_cursor === null || res.data.next_cursor === undefined) break;
      after = res.data.next_cursor;
    }
    return out;
  }
  explain(err) {
    const M = {
      NETWORK: 'The server could not be reached.', VAULT_LOCKED: 'The vault is locked. An administrator has to unlock it first.',
      FORBIDDEN: 'Your role isn’t allowed to do that.', CONFIRMATION_REQUIRED: 'The confirmation expired. Try again.',
      RATE_LIMITED: 'Too many requests. Wait a moment and try again.', TOO_MANY_ATTEMPTS: 'Too many attempts. Try again later.',
    };
    return M[err.code] || err.message || 'Something went wrong.';
  }

  /* ---------- toasts ---------- */
  toast(msg, kind = '', code = '') {
    const t = document.createElement('div'); t.className = `toast ${kind}`;
    t.innerHTML = `<i></i><div>${this.escape(msg)}${code ? `<small>${this.escape(code)}</small>` : ''}</div>`;
    this.$('#toasts').appendChild(t);
    if (!this.RM) gsap.fromTo(t, { opacity: 0, y: 16, scale: 0.97 }, { opacity: 1, y: 0, scale: 1, duration: 0.35, ease: 'back.out(1.6)' });
    setTimeout(() => { if (this.RM) t.remove(); else gsap.to(t, { opacity: 0, y: 10, duration: 0.3, onComplete: () => t.remove() }); }, 4200);
  }

  /* ---------- dialogs: built on demand; they resolve once their submit work succeeds ---------- */
  dialog({ title, lead = '', fields = [], confirm = 'Confirm', danger = false, validate = null, submit, stamp = false }) {
    return new Promise((resolve) => {
      const host = this.$('#dialogs'), id = `dlg${Date.now()}`;
      const fieldHtml = fields.map((f) => {
        const fid = `${id}-${f.id}`;
        const attrs = `id="${this.escape(fid)}" name="${this.escape(f.id)}"${f.autocomplete ? ` autocomplete="${this.escape(f.autocomplete)}"` : ''}${f.maxlength ? ` maxlength="${this.escape(f.maxlength)}"` : ''}`;
        let input;
        if (f.type === 'select') input = `<select ${attrs}>${f.options.map((o) => `<option value="${this.escape(o[0])}"${o[0] === f.value ? ' selected' : ''}>${this.escape(o[1])}</option>`).join('')}</select>`;
        else if (f.type === 'checkbox') input = `<span style="display:flex;gap:10px;align-items:flex-start"><input type="checkbox" ${attrs} style="width:auto;min-height:0;margin-top:3px"><span style="margin:0;font-size:14px;color:var(--ink)">${this.escape(f.text)}</span></span>`;
        else input = `<input type="${this.escape(f.type || 'text')}" ${attrs} value="${this.escape(f.value || '')}" placeholder="${this.escape(f.placeholder || '')}"${f.min !== undefined ? ` min="${this.escape(f.min)}"` : ''}${f.max !== undefined ? ` max="${this.escape(f.max)}"` : ''}>`;
        return `<label class="field"><span>${f.labelHtml || this.escape(f.label)}</span>${input}${f.hint ? `<small class="hint">${this.escape(f.hint)}</small>` : ''}</label>`;
      }).join('');
      const wrap = document.createElement('div');
      wrap.className = 'dlg on'; wrap.id = id; wrap.setAttribute('role', 'dialog'); wrap.setAttribute('aria-modal', 'true'); wrap.setAttribute('aria-labelledby', `${id}-t`);
      wrap.innerHTML = `<div class="veil" data-close></div><form class="panel" novalidate>
        ${stamp ? '<svg class="seal-stamp" viewBox="0 0 100 100" aria-hidden="true"><circle cx="50" cy="50" r="44" fill="#7a1d2a"/><circle cx="50" cy="50" r="34" fill="none" stroke="#4a1019" stroke-width="3"/><path d="M36 36l28 28M64 36 36 64" stroke="#4a1019" stroke-width="6" stroke-linecap="round"/></svg>' : ''}
        <h4 id="${id}-t">${this.escape(title)}</h4>${lead ? `<p class="lead">${lead}</p>` : ''}${fieldHtml}
        <p class="err" role="alert"></p>
        <div class="row"><button class="btn quiet" type="button" data-close>Cancel</button><button class="btn ${danger ? 'danger' : 'primary'}" type="submit">${this.escape(confirm)}</button></div></form>`;
      host.appendChild(wrap);
      const form = this.$('form', wrap), errEl = this.$('.err', wrap), go = this.$('button[type=submit]', wrap);
      const opener = document.activeElement;
      const values = () => Object.fromEntries(fields.map((f) => { const el = wrap.querySelector(`[name="${f.id}"]`); return [f.id, f.type === 'checkbox' ? el.checked : el.value]; }));
      const refresh = () => { go.disabled = Boolean(validate && validate(values())); };
      const close = (ok) => {
        const done = () => { wrap.remove(); if (opener && opener.focus) opener.focus(); resolve(ok); };
        if (this.RM) { done(); return; }
        gsap.to(this.$('.panel', wrap), { opacity: 0, y: 10, scale: 0.98, duration: 0.2 });
        gsap.to(this.$('.veil', wrap), { opacity: 0, duration: 0.25, onComplete: done });
      };
      const ui = { error: (m) => { errEl.textContent = m; }, panel: this.$('.panel', wrap) };
      this.$$('[data-close]', wrap).forEach((b) => b.addEventListener('click', () => close(false)));
      wrap.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') close(false);
        if (e.key === 'Tab') {
          const f = this.$$('button, input, select', wrap).filter((x) => !x.disabled);
          if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); }
          else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
        }
      });
      form.addEventListener('input', refresh); form.addEventListener('change', refresh); refresh();
      form.addEventListener('submit', async (e) => {
        e.preventDefault(); if (go.disabled || go.classList.contains('busy')) return;
        errEl.textContent = ''; go.classList.add('busy');
        try { const ok = await submit(values(), ui); if (ok !== false) close(true); }
        catch (err) { errEl.textContent = err instanceof ApiError ? this.explain(err) : String((err && err.message) || err); }
        finally { go.classList.remove('busy'); refresh(); }
      });
      if (!this.RM) {
        gsap.fromTo(this.$('.veil', wrap), { opacity: 0 }, { opacity: 1, duration: 0.3 });
        gsap.fromTo(this.$('.panel', wrap), { opacity: 0, y: 18, scale: 0.97 }, { opacity: 1, y: 0, scale: 1, duration: 0.45, ease: 'expo.out' });
      }
      setTimeout(() => { (this.$('input, select', wrap) || go).focus(); }, 60);
    });
  }
  stampSeal(ui) {
    const s = this.$('.seal-stamp', ui.panel);
    if (this.RM || !s) return Promise.resolve();
    return new Promise((res) => gsap.timeline({ onComplete: () => setTimeout(res, 300) })
      .fromTo(s, { opacity: 0, scale: 2.2, rotate: -30 }, { opacity: 1, scale: 1, rotate: -12, duration: 0.45, ease: 'back.out(2)' })
      .to(ui.panel, { x: 4, duration: 0.05, yoyo: true, repeat: 3 }, 0.38));
  }

  /* ---------- boot ---------- */
  async boot() {
    this.bindAuth(); this.bindShell();
    window.addEventListener('popstate', () => { if (this.user) this.navigate(this.viewFromPath(), false); });
    const path = location.pathname;
    try {
      const s = await this.api('GET', '/api/auth/session');
      this.setUser(s);
      this.$('#landing').hidden = true;
      this.showApp(this.viewFromPath(), false);
    } catch (_) {
      this.target = this.viewFromPath(true);
      if (path === '/' || path === '') this.showLanding();
      else this.showAuth({ direct: true });
    }
  }
  viewFromPath(nullIfRoot) {
    const p = location.pathname.replace(/\/+$/, '');
    const v = Object.keys(this.ROUTES).find((k) => this.ROUTES[k] === p);
    return v || (nullIfRoot ? null : 'dashboard');
  }
  setUser(s) {
    this.user = { username: s.username, role: s.role };
    if (s.csrf_token) this.csrf = s.csrf_token;
  }
  showLanding() {
    // The landing page is built around its 3D scene; without WebGL go straight to the sign-in card.
    if (!KC3D.ok) { this.showAuth({ direct: true }); return; }
    this.$('#landing').hidden = false;
    if (window.KCLanding) window.KCLanding.start();
  }

  /* ---------- sign-in screen ---------- */
  bindAuth() {
    this.authMode = 'login';
    this.$('#toggle-setup').addEventListener('click', () => this.setAuthMode(this.authMode === 'login' ? 'setup' : 'login'));
    this.$('#auth-back').addEventListener('click', () => this.closeAuth());
    this.$('#form-login').addEventListener('submit', (e) => { e.preventDefault(); this.submitAuth(); });
    this.$('#login-password').addEventListener('input', (e) => e.target.classList.remove('bad'));
    this.$('#auth').addEventListener('keydown', (e) => { if (e.key === 'Escape' && !this.$('#auth-back').hidden) this.closeAuth(); });
    this.initAuthKey();
    // The button ships disabled so nothing can be submitted natively before this script has loaded.
    this.$('#auth-submit').disabled = false;
  }
  setAuthMode(mode) {
    this.authMode = mode;
    const setup = mode === 'setup';
    this.$('#login-fields').hidden = setup; this.$('#setup-fields').hidden = !setup;
    this.$('#auth-sub').textContent = setup ? 'Create the first administrator and the vault. This works once.' : 'Sign in to open the vault.';
    this.$('#auth-submit').textContent = setup ? 'Create administrator' : 'Sign in';
    this.$('#toggle-setup').textContent = setup ? 'Back to sign in' : 'First-time setup';
    this.$('#auth-error').innerHTML = '';
    if (!this.RM) gsap.fromTo(setup ? '#setup-fields' : '#login-fields', { opacity: 0, y: 8 }, { opacity: 1, y: 0, duration: 0.35 });
    (setup ? this.$('#setup-username') : this.$('#login-username')).focus();
  }
  showAuth({ direct = false, from = null, message = '' } = {}) {
    const auth = this.$('#auth');
    auth.hidden = false; document.body.classList.add('kc-lock');
    this.$('#auth-back').hidden = direct && this.$('#landing').hidden;
    this.setAuthMode('login');
    if (message) this.authMessage(message, '');
    this.startAuthFx();
    if (this.RM) { this.$('#login-username').focus(); return; }
    gsap.fromTo(auth, { opacity: 0 }, { opacity: 1, duration: 0.45 });
    gsap.fromTo(this.$$('.auth-card > *:not(#auth-key)'), { opacity: 0, y: 12 }, { opacity: 1, y: 0, duration: 0.6, stagger: 0.05, ease: 'power3.out', delay: 0.15 });
    gsap.fromTo(this.$('.auth-card'), { scale: 0.96 }, { scale: 1, duration: 0.6, ease: 'expo.out' });
    if (this.has3D && from && from.visible) requestAnimationFrame(() => this.flyKeyIn(from));
    // once the card covers the page, the landing scene can rest
    if (window.KCLanding && window.KCLanding.running) setTimeout(() => { if (!this.$('#auth').hidden) window.KCLanding.paused = true; }, 600);
    setTimeout(() => this.$('#login-username').focus(), 400);
  }
  openAuth({ from } = {}) { this.showAuth({ from }); }
  closeAuth() {
    if (this.authBusy) return;
    const auth = this.$('#auth');
    const done = () => {
      auth.hidden = true; gsap.set(auth, { clearProps: 'opacity' }); document.body.classList.remove('kc-lock'); this.stopAuthFx();
      if (this.has3D && this.akc.parentNode === document.body) this.dropKey();
      if (window.KCLanding) { window.KCLanding.keyHidden = false; window.KCLanding.paused = false; }
      if (this.$('#landing').hidden) { history.replaceState(null, '', '/'); this.showLanding(); }
    };
    if (window.KCLanding) window.KCLanding.paused = false;
    if (this.RM) { done(); return; }
    gsap.to(auth, { opacity: 0, duration: 0.35, onComplete: done });
  }
  authMessage(text, code) {
    const err = this.$('#auth-error');
    err.innerHTML = `${this.escape(text)}${code ? `<code>${this.escape(code)}</code>` : ''}`;
    if (!this.RM) gsap.fromTo(err, { height: 0, opacity: 0 }, { height: 'auto', opacity: 1, marginBottom: 8, duration: 0.35 });
  }
  async submitAuth() {
    if (this.authBusy) return;
    this.$('#auth-error').innerHTML = '';
    if (this.authMode === 'setup') { await this.submitSetup(); return; }
    const username = this.$('#login-username').value.trim(), password = this.$('#login-password').value;
    if (!username || !password) { this.authMessage('Enter your username and password.'); return; }
    this.authBusy = true; this.$('#auth-submit').classList.add('busy');
    try {
      const res = await this.api('POST', '/api/auth/login', { username, password });
      this.setUser(res);
      this.$('#login-password').value = '';
      await this.enterTransition();
    } catch (err) {
      if (!(err instanceof ApiError)) throw err;
      this.$('#auth-submit').classList.remove('busy');
      const M = {
        AUTH_FAILED: 'Wrong username or password. Attempts are limited and recorded.',
        TOO_MANY_ATTEMPTS: 'Too many failed attempts. This account is locked for a while.',
        RATE_LIMITED: 'Too many sign-in attempts from here. Wait a minute and try again.',
        INVALID_INPUT: 'That username isn’t valid. Use letters, numbers, dots, dashes or underscores.',
      };
      await this.denyTransition(M[err.code] || this.explain(err), err.code);
    } finally { this.authBusy = false; this.$('#auth-submit').classList.remove('busy'); }
  }
  async submitSetup() {
    const username = this.$('#setup-username').value.trim(), password = this.$('#setup-password').value;
    const pass = this.$('#setup-passphrase').value, pass2 = this.$('#setup-passphrase2').value;
    if (!/^[A-Za-z0-9_.-]{3,64}$/.test(username)) { this.authMessage('Choose a username of 3 to 64 letters, numbers, dots, dashes or underscores.'); return; }
    if (password.length < 12) { this.authMessage('The password needs 12 characters or more.'); return; }
    if (pass.length < 12) { this.authMessage('The vault passphrase needs 12 characters or more.'); return; }
    if (pass !== pass2) { this.authMessage('The two vault passphrases don’t match.'); return; }
    this.authBusy = true; this.$('#auth-submit').classList.add('busy');
    try {
      await this.api('POST', '/api/setup', { username, password, vault_passphrase: pass });
      this.$$('#setup-fields input').forEach((i) => { i.value = ''; });
      this.setAuthMode('login');
      this.$('#login-username').value = username; this.$('#login-password').focus();
      this.authMessage('Administrator created. Sign in with it, then unlock the vault.');
    } catch (err) {
      this.authMessage(err.code === 'SETUP_CLOSED' ? 'Setup has already been done. Sign in instead.' : (err.code === 'INVALID_INPUT' ? 'Check the username and the lengths of both secrets.' : this.explain(err)), err.code);
    } finally { this.authBusy = false; this.$('#auth-submit').classList.remove('busy'); }
  }

  /* ---------- the sign-in key: on the card's corner, and the star of both transitions ---------- */
  initAuthKey() {
    const T = THREE, akc = this.$('#auth-key');
    this.akc = akc;
    this.KT = { on: false };
    this.has3D = KC3D.ok;
    if (!this.has3D) { akc.hidden = true; return; }
    this.aRend = new T.WebGLRenderer({ canvas: akc, antialias: true, alpha: true });
    this.aRend.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.aRend.outputEncoding = T.sRGBEncoding; this.aRend.toneMapping = T.ACESFilmicToneMapping;
    this.aScene = new T.Scene(); this.aCam = new T.PerspectiveCamera(30, 1, 0.1, 50); this.aCam.position.set(0, 0, 12);
    this.aEnvReady = false;
    KC3D.addLights(this.aScene);
    this.tilt = new T.Group(); this.tilt.rotation.z = -35 * Math.PI / 180; this.aScene.add(this.tilt);
    this.aKey = KC3D.buildKey(KC3D.brass()); this.aKey.scale.setScalar(0.92); this.tilt.add(this.aKey);
    this.KEY_H = 2 * 12 * Math.tan(15 * Math.PI / 180);
    this.KT = { on: false, x: 0, y: 0, s: 0.92, tilt: -35 * Math.PI / 180, yaw: 0, spin: 0, twist: 0, push: 0 };
  }
  startAuthFx() {
    if (this.authFxOn) return;
    this.authFxOn = true;
    if (this.has3D && !this.aEnvReady) { this.aScene.environment = KC3D.makeEnv(this.aRend); this.aEnvReady = true; }
    const afx = this.$('#auth-fx'), ag = afx.getContext('2d');
    const motes = Array.from({ length: 46 }, () => ({ x: Math.random(), y: Math.random(), r: 0.6 + Math.random() * 1.8, v: 0.004 + Math.random() * 0.012, ph: Math.random() * 6.28 }));
    const draw = (t) => {
      const w = afx.clientWidth, h = afx.clientHeight; if (!w) return;
      const d = Math.min(devicePixelRatio, 1.5); if (afx.width !== Math.round(w * d)) { afx.width = Math.round(w * d); afx.height = Math.round(h * d); }
      ag.setTransform(d, 0, 0, d, 0, 0); ag.clearRect(0, 0, w, h);
      const cx = w / 2, cy = h / 2, R = Math.min(w, h) * 0.62;
      const glow = ag.createRadialGradient(cx, cy, 10, cx, cy, R * 1.1); glow.addColorStop(0, 'rgba(226,192,122,0.22)'); glow.addColorStop(1, 'rgba(226,192,122,0)');
      ag.fillStyle = glow; ag.fillRect(0, 0, w, h); ag.lineWidth = 0.8;
      [[0.5, 24, 1, 0.1], [0.68, 36, -1, 0.08], [0.86, 48, 1, 0.07], [1.04, 60, -1, 0.05]].forEach(([b, petals, dir, a], ri) => {
        ag.strokeStyle = `rgba(122,29,42,${a})`;
        for (let k = 0; k < 8; k++) {
          ag.beginPath();
          for (let s2 = 0; s2 <= 260; s2++) {
            const th = s2 / 260 * Math.PI * 2, rho = R * b + R * 0.03 * Math.sin(petals * th + k * 0.5 + t * 0.35 * dir) + R * 0.012 * Math.sin(6 * th + ri);
            const x = cx + rho * Math.cos(th + t * 0.04 * dir), y = cy + rho * Math.sin(th + t * 0.04 * dir);
            if (s2) ag.lineTo(x, y); else ag.moveTo(x, y);
          }
          ag.stroke();
        }
      });
      motes.forEach((m) => {
        const y = ((m.y - t * m.v) % 1 + 1) % 1, x = m.x + Math.sin(t * 0.6 + m.ph) * 0.012, tw = 0.35 + 0.35 * Math.sin(t * 2 + m.ph);
        ag.fillStyle = `rgba(176,138,62,${tw})`; ag.beginPath(); ag.arc(x * w, y * h, m.r, 0, Math.PI * 2); ag.fill();
      });
    };
    const loop = (now) => {
      if (!this.authFxOn) return;
      requestAnimationFrame(loop);
      if (document.hidden) return;
      const t = now / 1000;
      draw(this.RM ? 0 : t);
      if (!this.has3D) return;
      const akc = this.akc, w = akc.clientWidth, h = akc.clientHeight;
      if (w && akc.width !== Math.round(w * this.aRend.getPixelRatio())) this.aRend.setSize(w, h, false);
      if (this.KT.on) {
        const K = this.KT;
        this.tilt.position.set(K.x, K.y, -K.push); this.tilt.rotation.set(0, K.yaw, K.tilt);
        this.aKey.rotation.x = K.spin + K.twist; this.aKey.scale.setScalar(K.s);
      } else {
        this.aKey.rotation.x = this.RM ? 0.4 : t * 0.9;
        this.tilt.rotation.y = this.RM ? 0 : Math.sin(t * 0.7) * 0.25;
      }
      this.aRend.render(this.aScene, this.aCam);
    };
    requestAnimationFrame(loop);
  }
  stopAuthFx() { this.authFxOn = false; }
  // Move the key's canvas out of the card into a full-screen layer, keeping it where it was on screen.
  liftKey(start) {
    const akc = this.akc, rc = akc.getBoundingClientRect(), px = this.KEY_H / innerHeight;
    this.corner = { x: (rc.left + rc.width / 2 - innerWidth / 2) * px, y: -(rc.top + rc.height / 2 - innerHeight / 2) * px, s: 0.92 * rc.height / innerHeight };
    Object.assign(this.KT, this.corner, { on: true, tilt: -35 * Math.PI / 180, yaw: this.tilt.rotation.y, spin: this.aKey.rotation.x % (Math.PI * 2), twist: 0, push: 0 }, start || {});
    document.body.appendChild(akc);
    Object.assign(akc.style, { position: 'fixed', left: '0', top: '0', width: '100vw', height: '100vh', zIndex: 33, opacity: 1 });
    this.aRend.setSize(innerWidth, innerHeight, false); this.aCam.aspect = innerWidth / innerHeight; this.aCam.updateProjectionMatrix();
  }
  dropKey() {
    const akc = this.akc;
    this.$('.auth-card').prepend(akc); akc.removeAttribute('style');
    this.aCam.aspect = 1; this.aCam.updateProjectionMatrix();
    this.tilt.position.set(0, 0, 0); this.tilt.rotation.set(0, 0, -35 * Math.PI / 180); this.aKey.scale.setScalar(0.92);
    this.KT.on = false;
  }
  // From the landing page: the key leaves the story and lands on the card's corner.
  flyKeyIn(from) {
    if (window.KCLanding) window.KCLanding.keyHidden = true;
    const px = this.KEY_H / innerHeight;
    this.liftKey({ x: (from.x - innerWidth / 2) * px, y: -(from.y - innerHeight / 2) * px, s: from.s, tilt: from.rz || 0, yaw: from.ry || 0, spin: from.rx || 0 });
    gsap.to(this.KT, { x: this.corner.x, y: this.corner.y, s: this.corner.s, tilt: -35 * Math.PI / 180, yaw: 0, spin: Math.PI * 2, duration: 1.1, ease: 'power3.inOut', onComplete: () => this.dropKey() });
  }
  denyTransition(message, code) {
    const err = this.$('#auth-error'), pw = this.$('#login-password'), ring = this.$('#ring'), card = this.$('.auth-card');
    const show = () => {
      err.innerHTML = `${this.escape(message)}${code ? `<code>${this.escape(code)}</code>` : ''}`;
      pw.classList.add('bad'); pw.value = '';
      if (!this.RM) {
        gsap.fromTo(err, { height: 0, opacity: 0, marginBottom: 0 }, { height: 'auto', opacity: 1, marginBottom: 8, duration: 0.35 });
        gsap.fromTo(card, { x: 0 }, { keyframes: [{ x: -10, duration: 0.06 }, { x: 9, duration: 0.06 }, { x: -6, duration: 0.06 }, { x: 4, duration: 0.06 }, { x: 0, duration: 0.08 }] });
      }
      setTimeout(() => pw.focus(), 50);
    };
    if (this.RM || !this.has3D) { show(); return Promise.resolve(); }
    this.liftKey();
    const big = 0.42 * (this.KEY_H / 6.4), K = this.KT;
    return new Promise((resolve) => {
      gsap.timeline({ onComplete: () => { this.dropKey(); resolve(); } })
        .to(K, { x: 0, y: 0, s: big, tilt: 0, yaw: 0, spin: Math.round(K.spin / (Math.PI * 2)) * Math.PI * 2, duration: 0.7, ease: 'power3.inOut' }, 0)
        .fromTo(ring, { opacity: 0, scale: 0.4, rotate: 0 }, { opacity: 1, scale: 0.8, duration: 0.45, ease: 'back.out(1.8)' }, 0.35)
        .to(K, { yaw: Math.PI / 2, y: 0.1 * big, duration: 0.4, ease: 'power2.inOut' }, 0.7)
        .to(K, { push: 2.2 * big, duration: 0.3, ease: 'power2.in' }, 1.05)
        .to(K, { twist: 0.32, duration: 0.18, ease: 'power2.out' }, 1.4)
        .to(ring, { rotate: 14, duration: 0.18, ease: 'power2.out' }, 1.4)
        .add(() => ring.classList.add('deny'), 1.5)
        .to(K, { keyframes: [{ twist: 0.12, duration: 0.06 }, { twist: 0.3, duration: 0.06 }, { twist: 0.08, duration: 0.06 }, { twist: 0.22, duration: 0.06 }, { twist: 0, duration: 0.12 }] }, 1.58)
        .to(ring, { keyframes: [{ rotate: 4, x: -6, duration: 0.06 }, { rotate: 12, x: 6, duration: 0.06 }, { rotate: 2, x: -4, duration: 0.06 }, { rotate: 8, x: 3, duration: 0.06 }, { rotate: 0, x: 0, duration: 0.12 }] }, 1.58)
        .add(show, 1.7)
        .to(K, { push: 0, duration: 0.3, ease: 'power2.out' }, 2.0)
        .to(ring, { opacity: 0, scale: 0.5, duration: 0.35, ease: 'power2.in', onComplete: () => { ring.classList.remove('deny'); gsap.set(ring, { rotate: 0 }); } }, 2.1)
        .to(K, { yaw: 0, duration: 0.35, ease: 'power2.inOut' }, 2.25)
        .to(K, { x: () => this.corner.x, y: () => this.corner.y, s: () => this.corner.s, tilt: -35 * Math.PI / 180, duration: 0.8, ease: 'power3.inOut' }, 2.45);
    });
  }
  // Signed in: the key flies to a keyhole, goes in, turns a quarter, and the app opens out of the keyhole.
  enterTransition() {
    const app = this.$('#app'), ring = this.$('#ring'), card = this.$('.auth-card'), auth = this.$('#auth');
    const view = this.target && this.can(this.target) ? this.target : 'dashboard';
    const leaveLanding = () => { if (window.KCLanding) window.KCLanding.stop(); this.$('#landing').hidden = true; window.scrollTo(0, 0); };
    const finish = () => {
      auth.hidden = true; this.stopAuthFx(); document.body.classList.remove('kc-lock');
      if (this.has3D && this.akc.parentNode === document.body) this.dropKey();
      gsap.set([card, auth, '#auth-fx', this.akc], { clearProps: 'all' }); gsap.set(app, { clearProps: 'clipPath' });
      gsap.set(ring, { opacity: 0, rotate: 0, scale: 1 }); ring.classList.remove('lit');
    };
    if (this.RM || !this.has3D) { leaveLanding(); this.showApp(view, true); finish(); return Promise.resolve(); }
    const R = Math.hypot(innerWidth, innerHeight);
    this.liftKey(); gsap.set(ring, { rotate: 0, scale: 1 }); ring.classList.remove('deny');
    const big = 0.55 * (this.KEY_H / 6.4), K = this.KT;
    return new Promise((resolve) => {
      gsap.timeline({ onComplete: () => { finish(); resolve(); } })
        .to(card, { scale: 0.94, opacity: 0, filter: 'blur(6px)', duration: 0.5, ease: 'power2.in' }, 0)
        .to('#auth-fx', { opacity: 0, duration: 0.8 }, 0.1)
        .to(K, { x: 0, y: 0, s: big, tilt: 0, yaw: 0, spin: Math.round(K.spin / (Math.PI * 2)) * Math.PI * 2, duration: 1.0, ease: 'power3.inOut' }, 0.05)
        .fromTo(ring, { opacity: 0, scale: 0.4 }, { opacity: 1, scale: 1, duration: 0.6, ease: 'back.out(1.8)' }, 0.55)
        .to(K, { yaw: Math.PI / 2, x: -0.02, y: 0.1 * big, duration: 0.5, ease: 'power2.inOut' }, 1.0)
        .to(K, { push: 2.2 * big, duration: 0.35, ease: 'power2.in' }, 1.45)
        .to(K, { twist: Math.PI / 2, duration: 0.35, ease: 'power2.inOut' }, 1.85)
        .to(ring, { rotate: 90, duration: 0.35, ease: 'power2.inOut' }, 1.85)
        .add(() => ring.classList.add('lit'), 2.1)
        .add(() => { leaveLanding(); gsap.set(app, { clipPath: 'circle(0px at 50% 50%)' }); this.showApp(view, true); }, 2.15)
        .to(app, { clipPath: `circle(${R}px at 50% 50%)`, duration: 1.1, ease: 'expo.inOut' }, 2.2)
        .to(auth, { opacity: 0, duration: 0.6 }, 2.4)
        .to([ring, this.akc], { opacity: 0, scale: 1.6, duration: 0.7, ease: 'power2.in' }, 2.25);
    });
  }

  /* ---------- the shell ---------- */
  bindShell() {
    this.$$('.nav button').forEach((b) => b.addEventListener('click', () => this.navigate(b.dataset.view, true)));
    this.$('#btn-logout').addEventListener('click', () => this.logout());
    this.$('#btn-password').addEventListener('click', () => this.changePassword());
    this.$('#d-close').addEventListener('click', () => this.closeDrawer());
    this.$('#scrim').addEventListener('click', () => this.closeDrawer());
    this.$('#drawer').addEventListener('keydown', (e) => { if (e.key === 'Escape') this.closeDrawer(); });
    gsap.set('#drawer', { x: 0, xPercent: 104 });   // replaces the stylesheet's off-screen transform
    this.$('#main').addEventListener('click', (e) => {
      const go = e.target.closest('[data-go]'); if (go) { e.preventDefault(); this.navigate(go.dataset.go, true); }
    });
    this.reveal = new IntersectionObserver((entries) => {
      const fresh = entries.filter((e) => e.isIntersecting && !e.target.kcSeen).map((e) => e.target);
      fresh.forEach((el) => { el.kcSeen = true; this.reveal.unobserve(el); if (el.kcOnReveal) el.kcOnReveal(); });
      if (fresh.length) gsap.fromTo(fresh, { opacity: 0, y: 22 }, { opacity: 1, y: 0, duration: 0.7, stagger: 0.045, ease: 'power3.out' });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.12 });
  }
  armReveal(root) {
    const els = this.$$('.hero, .kpi, .card, .toolbar, .filters, .notice, .tl li, tr.k, .entries li, .ringk, .audit-head, .bk-list li, .settings li', root);
    if (this.RM) { els.forEach((el) => { if (el.kcOnReveal) el.kcOnReveal(); }); return; }
    els.forEach((el) => { if (el.kcSeen) return; gsap.set(el, { opacity: 0 }); this.reveal.observe(el); });
  }
  showApp(view, push) {
    const app = this.$('#app');
    app.hidden = false;
    const u = this.user;
    this.$('#me-name').textContent = u.username; this.$('#me-role').textContent = this.roleName(u.role);
    this.$('#me-initial').textContent = (u.username[0] || '?').toUpperCase();
    this.$$('[data-roles]').forEach((el) => { el.hidden = !el.dataset.roles.split(' ').includes(u.role); });
    this.startBackground();
    this.refreshVault();
    this.navigate(view, push);
  }
  navigate(view, push) {
    if (!this.can(view)) view = 'dashboard';
    if (push && this.ROUTES[view] !== location.pathname) history.pushState(null, '', this.ROUTES[view]);
    else if (!push && location.pathname !== this.ROUTES[view]) history.replaceState(null, '', this.ROUTES[view]);
    this.current = view;
    this.closeDrawer();
    this.$$('.nav button').forEach((b) => { b.classList.toggle('on', b.dataset.view === view); b.setAttribute('aria-current', b.dataset.view === view ? 'page' : 'false'); });
    this.$$('.view').forEach((v) => v.classList.toggle('on', v.id === `view-${view}`));
    this.$('#page-title').textContent = this.TITLES[view];
    document.title = `${this.TITLES[view]} · KeyCycle`;
    this.$('#top-actions').innerHTML = '';
    window.scrollTo(0, 0);
    if (!this.RM) gsap.fromTo('#page-title', { opacity: 0, x: -10, filter: 'blur(6px)' }, { opacity: 1, x: 0, filter: 'blur(0px)', duration: 0.6, ease: 'expo.out', clearProps: 'filter' });
    const render = { dashboard: 'renderDashboard', keys: 'renderKeys', crypto: 'renderCrypto', history: 'renderHistory', audit: 'renderAudit', backup: 'renderBackup', admin: 'renderAdmin' }[view];
    this[render]().catch((err) => { if (err instanceof ApiError && err.code !== 'SESSION_EXPIRED') this.viewError(view, err); else if (!(err instanceof ApiError)) console.error(err); });
  }
  viewError(view, err) {
    const el = this.$(`#view-${view}`);
    el.innerHTML = `<div class="card empty"><b>That didn’t load</b>${this.escape(this.explain(err))} <button class="linkbtn" type="button" data-go="${this.escape(view)}">Try again</button></div>`;
  }
  async logout() {
    try { await this.api('POST', '/api/auth/logout'); } catch (_) { /* the session may already be gone */ }
    location.href = '/';
  }
  sessionEnded() {
    if (this.ending) return;
    this.ending = true;
    this.user = null; this.csrf = null;
    this.closeDrawer();
    this.$('#app').hidden = true;
    this.target = this.current;
    this.showAuth({ direct: true, message: 'Your session ended. Sign in again to carry on.' });
    setTimeout(() => { this.ending = false; }, 500);
  }
  changePassword() {
    this.dialog({
      title: 'Change password', lead: 'Your other sessions will be signed out.', confirm: 'Change password',
      fields: [
        { id: 'current', label: 'Current password', type: 'password', autocomplete: 'current-password', maxlength: 256 },
        { id: 'next', label: 'New password', type: 'password', autocomplete: 'new-password', maxlength: 256, hint: '12 characters or more.' },
        { id: 'again', label: 'New password again', type: 'password', autocomplete: 'new-password', maxlength: 256 },
      ],
      validate: (v) => !v.current || v.next.length < 12 || v.next !== v.again,
      submit: async (v) => {
        const res = await this.api('POST', '/api/auth/password', { current_password: v.current, new_password: v.next });
        this.toast('Password changed', 'ok', res.other_sessions_ended ? `${res.other_sessions_ended} other session(s) ended` : '');
      },
    });
  }

  /* ---------- engraved background, very quiet ---------- */
  startBackground() {
    if (this.bgOn) return;
    this.bgOn = true;
    const bg = this.$('#bg'), g = bg.getContext('2d');
    const draw = (t) => {
      const d = Math.min(devicePixelRatio, 1.5), w = innerWidth, h = innerHeight;
      if (bg.width !== Math.round(w * d) || bg.height !== Math.round(h * d)) { bg.width = Math.round(w * d); bg.height = Math.round(h * d); }
      g.setTransform(d, 0, 0, d, 0, 0); g.clearRect(0, 0, w, h);
      const cx = w * 0.82, cy = h * 0.22, R = Math.min(w, h) * 0.55; g.lineWidth = 0.6;
      [[0.6, 30, 1], [0.85, 42, -1]].forEach(([b, petals, dir], ri) => {
        g.strokeStyle = 'rgba(122,29,42,0.05)';
        for (let k = 0; k < 10; k++) {
          g.beginPath();
          for (let s = 0; s <= 240; s++) {
            const th = s / 240 * Math.PI * 2, rho = R * b + R * 0.05 * Math.sin(petals * th + k * 0.45 + t * 0.15 * dir) + R * 0.02 * Math.sin(5 * th + ri);
            const x = cx + rho * Math.cos(th + t * 0.01 * dir), y = cy + rho * Math.sin(th + t * 0.01 * dir);
            if (s) g.lineTo(x, y); else g.moveTo(x, y);
          }
          g.stroke();
        }
      });
    };
    let last = 0;
    const loop = (now) => {
      requestAnimationFrame(loop);
      if (document.hidden || this.$('#app').hidden || now - last < 66) return;    // about 15 fps is plenty for this
      last = now; draw(this.RM ? 0 : now / 1000);
    };
    requestAnimationFrame(loop);
  }

  /* ---------- vault ---------- */
  async refreshVault() {
    try { const v = await this.api('GET', '/api/vault/status'); this.setVaultState(v.locked, false); } catch (_) { /* handled by the session check */ }
  }
  setVaultState(locked, animate) {
    this.vaultLocked = locked;
    const hero = this.$('#hero');
    if (hero) {
      hero.classList.toggle('open', !locked);
      this.$('#vault-headline').textContent = locked ? 'The vault is locked.' : 'The vault is open.';
      this.$('#vault-copy').textContent = locked ? 'Keys can’t be used until an administrator unlocks it with the vault passphrase.' : 'The master key is held in memory. Keys can be used, rotated and backed up.';
      const vb = this.$('#vault-btn'); if (vb) { vb.textContent = locked ? 'Unlock vault' : 'Lock vault'; vb.className = locked ? 'btn gold' : 'btn ghost'; }
    }
    if (this.dial) {
      const D = this.dial.state;
      if (!animate || this.RM) { D.open = locked ? 0 : 1; D.wheel = locked ? 0 : Math.PI * 1.5; }
      else if (!locked) gsap.timeline().to(D, { wheel: Math.PI * 1.5, duration: 1.0, ease: 'power2.inOut' }).to(D, { open: 1, duration: 1.1, ease: 'power3.inOut' }, 0.7);
      else gsap.timeline().to(D, { open: 0, duration: 0.8, ease: 'power3.inOut' }).to(D, { wheel: 0, duration: 0.8, ease: 'power2.inOut' }, 0.6);
    }
    this.$$('[data-needs-vault]').forEach((el) => { el.hidden = !locked; });
  }
  vaultAction() {
    if (!this.isAdmin()) { this.toast('Only an administrator can open or lock the vault', 'no', 'FORBIDDEN'); return; }
    if (!this.vaultLocked) {
      this.api('POST', '/api/vault/lock').then(() => { this.setVaultState(true, true); this.toast('Vault locked'); }).catch((e) => this.toast(this.explain(e), 'no', e.code));
      return;
    }
    this.dialog({
      title: 'Unlock the vault', lead: 'The master key is derived from the passphrase with Argon2id and kept in memory only.', confirm: 'Unlock vault',
      fields: [{ id: 'pass', label: 'Vault passphrase', type: 'password', autocomplete: 'off', maxlength: 256 }],
      validate: (v) => !v.pass,
      submit: async (v) => {
        try { await this.api('POST', '/api/vault/unlock', { passphrase: v.pass }); }
        catch (e) { if (e.code === 'PASSPHRASE_INVALID') throw new Error('That passphrase didn’t open the vault. Attempts are limited and recorded.'); throw e; }
        if (this.current !== 'dashboard') this.toast('Vault unlocked', 'ok', 'Argon2id, 64 MiB, 3 passes');
        setTimeout(() => { this.setVaultState(false, true); if (this.current === 'dashboard') this.toast('Vault unlocked', 'ok', 'Argon2id, 64 MiB, 3 passes'); }, 250);
        if (this.current === 'crypto' || this.current === 'backup') this.navigate(this.current, false);
      },
    });
  }
  vaultNotice() {
    return `<div class="notice" data-needs-vault ${this.vaultLocked ? '' : 'hidden'}><span><b>The vault is locked.</b> Keys can’t be used until it’s unlocked.</span>${this.isAdmin() ? '<button class="btn primary small" type="button" data-vault>Unlock vault</button>' : ''}</div>`;
  }
  bindVaultButtons(root) { this.$$('[data-vault]', root).forEach((b) => b.addEventListener('click', () => this.vaultAction())); }

  /* ---------- dashboard ---------- */
  async renderDashboard() {
    const el = this.$('#view-dashboard'), admin = this.isAdmin();
    const h = new Date().getHours(), hello = h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
    el.innerHTML = `
      <div class="grid">
        <div class="hero" id="hero">
          <canvas id="hero-gl" aria-hidden="true"></canvas>
          <div class="copy">
            <p class="hello">${this.escape(hello)}, ${this.escape(this.user.username)}</p>
            <h2 id="vault-headline">The vault is locked.</h2>
            <p id="vault-copy"></p>
            <div style="display:flex;gap:10px;flex-wrap:wrap">
              ${admin ? '<button class="btn gold" id="vault-btn" type="button">Unlock vault</button>' : ''}
              <button class="btn ${admin ? 'ghost' : 'gold'}" type="button" data-go="keys">${admin ? 'Manage keys' : 'See the keys'}</button>
            </div>
          </div>
          <div class="stage"><canvas id="dial" aria-hidden="true"></canvas></div>
        </div>
        <div class="kpis" id="kpis">
          <div class="kpi"><div class="n" data-count="0">0</div><div class="l"><i style="background:var(--patina)"></i>Active keys</div></div>
          <div class="kpi"><div class="n" data-count="0">0</div><div class="l"><i style="background:var(--oxide)"></i>Rotation due this week</div></div>
          <div class="kpi"><div class="n" data-count="0">0</div><div class="l"><i style="background:var(--ink-3)"></i>Expired, still decrypts history</div></div>
          <div class="kpi"><div class="n" data-count="0">0</div><div class="l"><i style="background:var(--maroon)"></i>Revoked, every use refused</div></div>
        </div>
        ${admin ? `<div class="card chain-panel" id="chain-panel">
          <div class="card-h"><h2>Audit chain</h2><span class="spacer"></span><button class="btn quiet small" id="verify-btn" type="button">Verify chain</button></div>
          <div class="links" aria-hidden="true"><canvas id="chain3d"></canvas></div>
          <dl class="meta"><dt>Entries</dt><dd id="chain-count">…</dd><dt>Head</dt><dd class="hash" id="chain-hash">…</dd><dt>Status</dt><dd id="chain-verdict">Not verified this session</dd></dl>
        </div>` : `<div class="card chain-panel">
          <div class="card-h"><h2>Your access</h2></div>
          <div class="form-pad"><p style="margin:10px 0 8px">You’re signed in as ${this.user.role === 'operator' ? 'an operator' : 'a viewer'}.</p>
          <p class="muted" style="margin:0">${this.user.role === 'operator' ? 'You can encrypt and decrypt with standard keys and see the outcome of your own requests. Administrators manage keys, users, backups and the audit chain.' : 'You can see key metadata and decision outcomes. You can’t encrypt, decrypt or change anything, and you never see plaintext or secrets.'}</p></div>
        </div>`}
        <div class="card rings-panel">
          <div class="card-h"><h2>Next rotations</h2><span class="spacer"></span><button class="linkbtn" data-go="keys" type="button">All keys</button></div>
          <div class="rings" id="rings"><p class="muted" style="grid-column:1/-1;margin:0">Loading…</p></div>
        </div>
        <div class="card timeline-panel">
          <div class="card-h"><h2>Recent decisions</h2><span class="spacer"></span><button class="linkbtn" data-go="history" type="button">Full history</button></div>
          <ul class="tl" id="recent"><li class="muted" style="display:block">Loading…</li></ul>
        </div>
      </div>`;
    const vb = this.$('#vault-btn'); if (vb) vb.addEventListener('click', () => this.vaultAction());
    this.mountDial();
    this.setVaultState(this.vaultLocked, false);
    if (admin) { this.mountChain(); this.$('#verify-btn').addEventListener('click', () => this.verifyChain('dash')); }
    this.armReveal(el);
    const [keys, results, audit] = await Promise.all([
      this.allKeys(),
      this.api('GET', '/api/results?limit=6'),
      admin ? this.api('GET', '/api/audit?limit=1') : Promise.resolve(null),
    ]);
    if (this.current !== 'dashboard') return;
    this.keys = keys;
    const active = keys.filter((k) => k.state === 'active');
    const due = active.filter((k) => this.daysUntil(k.next_rotation_due) <= 7);
    const counts = [active.length, due.length, keys.filter((k) => k.state === 'expired').length, keys.filter((k) => k.state === 'revoked').length];
    this.$$('#kpis .n').forEach((n, i) => { n.dataset.count = counts[i]; });
    this.countUp();
    if (audit) { const hd = audit.data.chain_head; this.$('#chain-count').textContent = hd.entry_count.toLocaleString(); this.$('#chain-hash').textContent = hd.hash; }
    this.renderRings(active);
    const items = results.data.items;
    this.$('#recent').innerHTML = items.length ? items.map((it) => this.tlItem(it)).join('') : '<li class="muted" style="display:block">No decisions yet. They appear here as keys are used.</li>';
    this.armReveal(el);
  }
  countUp() {
    this.$$('[data-count]').forEach((el) => {
      const n = Number(el.dataset.count);
      if (this.RM) { el.textContent = n; return; }
      const o = { v: 0 }; gsap.to(o, { v: n, duration: 1.1, ease: 'power2.out', onUpdate: () => { el.textContent = Math.round(o.v); } });
    });
  }
  tlItem(it) {
    const ok = it.outcome === 'success';
    const what = it.key_id ? `key #${it.key_id}${it.key_version ? ` v${it.key_version}` : ''}` : '';
    const who = it.user ? ` ${it.user}` : '';
    return `<li><span class="t">${this.escape(this.ago(it.time))}</span><span class="d ${ok ? 'ok' : 'no'}"></span><span class="w"><b>${this.escape(this.actionName(it.action))}</b> ${this.escape(what)}<small>${this.escape(who)}</small>${ok ? '' : ` <code>${this.escape(it.reason_code || it.outcome)}</code>`}${it.test ? ' <small>test key</small>' : ''}</span><span class="ms">${it.duration_ms !== undefined && it.duration_ms !== null ? `${this.escape(it.duration_ms)} ms` : ''}</span></li>`;
  }
  actionName(a) {
    return ({ encrypt: 'Encrypt', decrypt: 'Decrypt', key_create: 'Create', key_rotate: 'Rotate', key_revoke: 'Revoke', confirmation_issue: 'Confirmation', key_read: 'Read', key_list: 'List' })[a] || a;
  }

  /* dashboard vault: the 3D door in the hero, with gold engraving behind it */
  mountDial() {
    if (this.dial) { this.dial.stage.dispose(); this.dial = null; }
    if (!KC3D.ok) return;
    const stage = new KC3D.Stage(this.$('#dial'), { fov: 30, z: 15 });
    stage.camera.position.x = 0.6;
    const v = KC3D.buildVault(); v.group.rotation.set(0.12, -0.42, 0); stage.scene.add(v.group);
    const state = { open: 0, wheel: 0 };
    const hc = this.$('#hero-gl'), hg = hc.getContext('2d');
    stage.onFrame = (t) => {
      if (!this.RM) v.group.rotation.y = -0.42 + Math.sin(t / 3.2) * 0.06;
      v.pivot.rotation.y = state.open * 1.4; v.wheel.rotation.z = state.wheel; v.glow.opacity = state.open * 0.9;
      const w = hc.clientWidth, h = hc.clientHeight; if (!w) return;
      const d = Math.min(devicePixelRatio, 1.5); if (hc.width !== Math.round(w * d)) { hc.width = Math.round(w * d); hc.height = Math.round(h * d); }
      hg.setTransform(d, 0, 0, d, 0, 0); hg.clearRect(0, 0, w, h);
      const cx = w * 0.74, cy = h * 0.5, R = h * 0.95, tt = this.RM ? 0 : t; hg.lineWidth = 0.7;
      [[0.42, 28, 1], [0.62, 40, -1], [0.82, 52, 1]].forEach(([b, petals, dir], ri) => {
        hg.strokeStyle = 'rgba(226,192,122,0.16)';
        for (let k = 0; k < 9; k++) {
          hg.beginPath();
          for (let s = 0; s <= 220; s++) {
            const th = s / 220 * Math.PI * 2, rho = R * b + R * 0.035 * Math.sin(petals * th + k * 0.5 + tt * 0.2 * dir) + R * 0.015 * Math.sin(5 * th + ri);
            const x = cx + rho * Math.cos(th + tt * 0.012 * dir), y = cy + rho * Math.sin(th + tt * 0.012 * dir);
            if (s) hg.lineTo(x, y); else hg.moveTo(x, y);
          }
          hg.stroke();
        }
      });
    };
    this.dial = { stage, state };
  }
  mountChain() {
    if (this.chain) { this.chain.stage.dispose(); this.chain = null; }
    if (!KC3D.ok) return;
    const stage = new KC3D.Stage(this.$('#chain3d'), { fov: 26, z: 4.6 });
    stage.camera.position.y = 0.15;
    const c = KC3D.buildChain(7); c.group.rotation.set(0.25, -0.22, 0); stage.scene.add(c.group);
    const GOLD = new THREE.Color(0xc9a35b), PAT = KC3D.lin(0x2d6a5c), BAD = KC3D.lin(0xc2451e);
    const state = { v: 0, bad: -1 };
    stage.onFrame = (t) => {
      if (!this.RM) c.group.rotation.y = -0.22 + Math.sin(t / 2.6) * 0.08;
      c.links.forEach((m, i) => {
        const done = Math.max(0, Math.min(1, state.v - i)), head = Math.max(0, 1 - Math.abs(state.v - i - 0.5) * 1.6) * (state.v < c.links.length ? 1 : 0);
        m.material.color.copy(GOLD).lerp(state.bad >= 0 && i >= state.bad ? BAD : PAT, done);
        m.material.emissive.setRGB(0.25 * head, 0.4 * head, 0.3 * head);
        m.position.y = (this.RM ? 0 : Math.sin(t * 1.1 + i * 0.7) * 0.03) + head * 0.08;
      });
    };
    this.chain = { stage, state, n: c.links.length };
  }

  /* next rotations: Material-style wavy rings */
  renderRings(active) {
    const ks = active.filter((k) => k.next_rotation_due).sort((a, b) => Date.parse(a.next_rotation_due) - Date.parse(b.next_rotation_due)).slice(0, 4);
    const host = this.$('#rings');
    if (!ks.length) { host.innerHTML = '<p class="muted" style="grid-column:1/-1;margin:0">No active keys yet.</p>'; return; }
    host.innerHTML = ks.map((k) => {
      const left = this.daysUntil(k.next_rotation_due), hot = left <= 7 ? 'hot' : '';
      return `<div class="ringk" data-left="${this.escape(left)}" data-period="${this.escape(k.rotation_days)}"><div class="rw"><svg viewBox="0 0 64 64" aria-hidden="true"><path class="tr ${hot}"/><path class="pr ${hot}"/></svg><span class="days"><span class="dn">0</span><small>days</small></span></div><div><b>${this.escape(k.name)}</b><small>v${this.escape(k.current_version)}, every ${this.escape(k.rotation_days)} days</small></div></div>`;
    }).join('');
    const rings = this.$$('.ringk', host);
    rings.forEach((el, i) => {
      el.kcF = 0;
      el.kcOnReveal = () => {
        const left = Number(el.dataset.left), dn = this.$('.dn', el), o = { f: 0 };
        gsap.to(o, { f: 1, duration: this.RM ? 0 : 1.6, delay: this.RM ? 0 : i * 0.12, ease: 'power3.out', onUpdate: () => { el.kcF = o.f; dn.textContent = Math.round(left * o.f); } });
      };
    });
    if (!this.ringLoopOn) {
      this.ringLoopOn = true;
      const CX = 32, CY = 32, RR = 24, GAP = 0.24;
      const wavy = (a0, a1, amp, waves, phase) => {
        if (a1 - a0 < 0.02) return '';
        const n = Math.max(8, Math.ceil((a1 - a0) / 0.05)); let d = '';
        for (let i = 0; i <= n; i++) {
          const a = a0 + (a1 - a0) * i / n, env = Math.min(1, (a - a0) / 0.35, (a1 - a) / 0.35), r = RR + amp * env * Math.sin(waves * a + phase);
          d += `${i ? 'L' : 'M'}${(CX + r * Math.cos(a)).toFixed(2)} ${(CY + r * Math.sin(a)).toFixed(2)}`;
        }
        return d;
      };
      const plain = (a0, a1) => {
        if (a1 - a0 < 0.02) return '';
        const p = (a) => `${(CX + RR * Math.cos(a)).toFixed(2)} ${(CY + RR * Math.sin(a)).toFixed(2)}`;
        return `M${p(a0)} A${RR} ${RR} 0 ${a1 - a0 > Math.PI ? 1 : 0} 1 ${p(a1)}`;
      };
      const loop = (now) => {
        requestAnimationFrame(loop);
        if (document.hidden || this.current !== 'dashboard') return;
        this.$$('#rings .ringk').forEach((el) => {
          const frac = Math.min(1, Number(el.dataset.left) / Math.max(1, Number(el.dataset.period))) * (el.kcF || 0), s = -Math.PI / 2, e = s + frac * Math.PI * 2;
          this.$('.pr', el).setAttribute('d', wavy(s, e, 1.7, 12, this.RM ? 0 : -now / 1000 * 3.2));
          this.$('.tr', el).setAttribute('d', frac > 0.98 ? '' : plain(e + GAP, s + Math.PI * 2 - GAP));
        });
      };
      requestAnimationFrame(loop);
    }
  }

  /* audit verification, shared by the dashboard and the audit page */
  async verifyChain(where) {
    let body = {};
    try {
      const saved = JSON.parse(localStorage.getItem('kc_audit_anchor') || 'null');
      if (saved && saved.entry_count > 0 && typeof saved.hash === 'string') body = { anchor_count: saved.entry_count, anchor_hash: saved.hash };
    } catch (_) { /* storage unavailable: verify without a remembered head */ }
    const btn = where === 'dash' ? this.$('#verify-btn') : this.$('#audit-verify');
    if (btn) btn.classList.add('busy');
    if (where === 'dash') { if (this.chain) { gsap.killTweensOf(this.chain.state); this.chain.state.v = 0; this.chain.state.bad = -1; } this.$('#chain-verdict').textContent = 'Walking the chain…'; }
    try {
      const res = await this.api('POST', '/api/audit/verify', body);
      const head = res.result.verified_head;
      try { localStorage.setItem('kc_audit_anchor', JSON.stringify({ entry_count: head.entry_count, hash: head.hash })); } catch (_) { /* fine */ }
      const sources = (res.result.anchors_checked || []).map((a) => (a.source === 'client' ? 'this browser’s last check' : 'the newest backup'));
      const text = `Verified ${head.entry_count.toLocaleString()} entries${sources.length ? `, matching ${sources.join(' and ')}` : ''}.`;
      if (where === 'dash') {
        if (this.chain) await new Promise((r) => gsap.to(this.chain.state, { v: this.chain.n, duration: this.RM ? 0 : 1.4, ease: 'none', onComplete: r }));
        this.$('#chain-verdict').textContent = text; this.$('#chain-count').textContent = res.chain_head.entry_count.toLocaleString(); this.$('#chain-hash').textContent = res.chain_head.hash;
      }
      this.toast('Audit chain verified', 'ok', `${head.entry_count} entries`);
      return { ok: true, res };
    } catch (err) {
      if (err.code === 'TAMPER_DETECTED') {
        const r = (err.body && err.body.result) || {};
        if (where === 'dash') {
          if (this.chain) { this.chain.state.bad = 3; await new Promise((res2) => gsap.to(this.chain.state, { v: this.chain.n, duration: this.RM ? 0 : 1.0, ease: 'none', onComplete: res2 })); }
          this.$('#chain-verdict').textContent = `Failed: entry #${r.first_mismatch} no longer fits.`;
        }
        this.toast(`Tampering detected at entry #${r.first_mismatch}`, 'no', 'TAMPER_DETECTED');
        return { ok: false, tamper: r };
      }
      this.toast(this.explain(err), 'no', err.code);
      if (where === 'dash') this.$('#chain-verdict').textContent = 'Not verified';
      return { ok: false };
    } finally { if (btn) btn.classList.remove('busy'); }
  }

  /* ---------- keys ---------- */
  async renderKeys() {
    const el = this.$('#view-keys'), admin = this.isAdmin();
    this.keyFilter = this.keyFilter || { state: '', purpose: '', q: '' };
    const F = this.keyFilter;
    el.innerHTML = `
      <div class="toolbar">
        <div class="seg" role="group" aria-label="State" id="state-seg">${[['', 'All'], ['active', 'Active'], ['expired', 'Expired'], ['revoked', 'Revoked']].map(([v, l]) => `<button type="button" data-f="${v}" class="${F.state === v ? 'on' : ''}">${l}</button>`).join('')}</div>
        <div class="seg" role="group" aria-label="Use" id="purpose-seg">${[['', 'Any use'], ['standard', 'Standard'], ['test', 'Test']].map(([v, l]) => `<button type="button" data-f="${v}" class="${F.purpose === v ? 'on' : ''}">${l}</button>`).join('')}</div>
        <label class="search"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg><span class="sr">Search keys</span><input id="key-search" placeholder="Search by name" value="${this.escape(F.q)}" maxlength="64"></label>
        <span style="flex:1"></span>
        ${admin ? '<button class="btn primary" type="button" id="new-key"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>New key</button>' : ''}
      </div>
      <div class="table-wrap"><table>
        <thead><tr><th>Key</th><th>Use</th><th>State</th><th>Version</th><th class="hide-sm">Next rotation</th><th><span class="sr">Actions</span></th></tr></thead>
        <tbody id="keys-body"><tr><td colspan="6" class="muted">Loading…</td></tr></tbody>
      </table></div>`;
    const seg = (id, key) => this.$$(`#${id} button`).forEach((b) => b.addEventListener('click', () => {
      this.$$(`#${id} button`).forEach((x) => x.classList.toggle('on', x === b)); F[key] = b.dataset.f; this.drawKeyRows();
    }));
    seg('state-seg', 'state'); seg('purpose-seg', 'purpose');
    this.$('#key-search').addEventListener('input', (e) => { F.q = e.target.value.trim().toLowerCase(); this.drawKeyRows(); });
    if (admin) this.$('#new-key').addEventListener('click', () => this.createKey());
    this.$('#keys-body').addEventListener('click', (e) => {
      const rb = e.target.closest('[data-rotate]'); if (rb) { e.stopPropagation(); this.rotateKey(Number(rb.dataset.rotate)); return; }
      const tr = e.target.closest('tr.k'); if (tr) this.openDrawer(Number(tr.dataset.id));
    });
    this.$('#keys-body').addEventListener('keydown', (e) => { if (e.key === 'Enter') { const tr = e.target.closest('tr.k'); if (tr) this.openDrawer(Number(tr.dataset.id)); } });
    this.armReveal(el);
    this.keys = await this.allKeys();
    if (this.current === 'keys') this.drawKeyRows();
  }
  keyChip(k) {
    if (k.state === 'active') {
      const left = this.daysUntil(k.next_rotation_due);
      return left !== null && left <= 7 ? `<span class="chip warn"><i></i>Rotation due</span>` : `<span class="chip ok"><i></i>Active</span>`;
    }
    return k.state === 'expired' ? '<span class="chip dim"><i></i>Expired</span>' : '<span class="chip no"><i></i>Revoked</span>';
  }
  drawKeyRows() {
    const F = this.keyFilter, admin = this.isAdmin();
    const rows = this.keys.filter((k) => (!F.state || k.state === F.state) && (!F.purpose || k.purpose === F.purpose) && (!F.q || k.name.toLowerCase().includes(F.q)));
    const body = this.$('#keys-body');
    if (!this.keys.length) { body.innerHTML = `<tr><td colspan="6"><div class="empty"><b>No keys yet</b>${admin ? 'Create the first one with New key. The vault has to be unlocked.' : 'An administrator hasn’t created any keys yet.'}</div></td></tr>`; return; }
    if (!rows.length) { body.innerHTML = '<tr><td colspan="6" class="muted" style="text-align:center;padding:40px">No keys match. Clear the filters to see every key.</td></tr>'; return; }
    body.innerHTML = rows.map((k) => {
      const left = this.daysUntil(k.next_rotation_due), pct = k.state === 'active' && left !== null ? Math.round((1 - Math.min(1, left / Math.max(1, k.rotation_days))) * 100) : 0;
      return `<tr class="k" data-id="${this.escape(k.id)}" tabindex="0">
        <td class="kname"><b>${this.escape(k.name)}</b><small>#${this.escape(k.id)}</small></td>
        <td>${k.purpose === 'test' ? '<span style="color:var(--gold);font-weight:500">Test</span>' : '<span class="muted">Standard</span>'}</td>
        <td>${this.keyChip(k)}</td>
        <td class="ver">v${this.escape(k.current_version)}</td>
        <td class="due hide-sm">${k.state === 'active' ? `<div class="bar"><b class="${left <= 7 ? 'hot' : ''}" style="width:${this.escape(pct)}%"></b></div><small>in ${this.escape(left)} days, every ${this.escape(k.rotation_days)} days</small>` : '<span class="muted">—</span>'}</td>
        <td class="act">${admin && k.state === 'active' ? `<button class="btn quiet small" type="button" data-rotate="${this.escape(k.id)}">Rotate</button>` : ''}</td>
      </tr>`;
    }).join('');
    this.armReveal(body);
  }
  createKey() {
    if (this.vaultLocked) { this.toast('Unlock the vault before creating keys', 'no', 'VAULT_LOCKED'); return; }
    this.dialog({
      title: 'New key', lead: 'An AES-256-GCM key. Version 1 is generated and wrapped by the vault.', confirm: 'Create key',
      fields: [
        { id: 'name', label: 'Name', maxlength: 64, placeholder: 'for example, payroll-2027' },
        { id: 'purpose', label: 'Use', type: 'select', value: 'standard', options: [['standard', 'Standard, for operators'], ['test', 'Test, for administrators']] },
        { id: 'days', label: 'Rotate every (days)', type: 'number', value: '90', min: 1, max: 365 },
        { id: 'expires', label: 'Expires on (optional)', type: 'date', hint: 'After this date every use is refused.' },
      ],
      validate: (v) => !v.name.trim() || v.name !== v.name.trim() || !(Number(v.days) >= 1 && Number(v.days) <= 365),
      submit: async (v) => {
        const body = { name: v.name, purpose: v.purpose, rotation_days: Number(v.days) };
        if (v.expires) body.expires_at = v.expires + 'T23:59:59Z';
        try { await this.api('POST', '/api/keys', body); }
        catch (e) { if (e.code === 'INVALID_INPUT') throw new Error('Check the name: it must be unique, and the expiry must be in the future.'); throw e; }
        this.toast(v.name + ' created', 'ok', 'KEY_CREATED');
        this.renderKeys();
      },
    });
  }
  async confirmation(action, keyId) {
    const res = await this.api('POST', '/api/confirmations', { action, key_id: keyId });
    return res.data.confirmation_token;
  }
  rotateKey(id) {
    const k = this.keys.find((x) => x.id === id) || (this.openKey && this.openKey.id === id ? this.openKey : null);
    if (!k) return;
    if (this.vaultLocked) { this.toast('Unlock the vault before rotating', 'no', 'VAULT_LOCKED'); return; }
    this.dialog({
      title: 'Rotate ' + k.name, lead: 'A new version becomes current. Older versions stay available, so existing ciphertext still decrypts.', confirm: 'Rotate',
      submit: async () => {
        const token = await this.confirmation('rotate', id);
        const res = await this.api('POST', `/api/keys/${id}/rotate`, { confirmation_token: token });
        const ver = res.data && res.data.current_version;
        this.toast(k.name + ' rotated' + (ver ? ' to v' + ver : ''), 'ok', (res.result && res.result.reason && res.result.reason.code) || 'ROTATE_OK');
        this.keys = await this.allKeys(); if (this.current === 'keys') this.drawKeyRows();
        const row = this.$(`tr.k[data-id="${id}"]`); if (row && !this.RM) gsap.fromTo(row, { backgroundColor: 'rgba(176,138,62,0.25)' }, { backgroundColor: 'rgba(176,138,62,0)', duration: 1.4 });
        if (this.openKey && this.openKey.id === id) { await this.openDrawer(id, true); if (this.keyStage && !this.RM) gsap.fromTo(this.keyStage.state, { spin: 0 }, { spin: 1, duration: 1.2, ease: 'power3.inOut' }); }
      },
    });
  }
  revokeKey(id) {
    const k = this.openKey && this.openKey.id === id ? this.openKey : this.keys.find((x) => x.id === id);
    if (!k) return;
    this.dialog({
      title: 'Revoke key', stamp: true, danger: true, confirm: 'Revoke key',
      lead: `This is permanent. Every later use of <b>${this.escape(k.name)}</b> will be refused and recorded.`,
      fields: [
        { id: 'reason', label: 'Reason', maxlength: 200, placeholder: 'for example, vendor contract ended' },
        { id: 'confirm', labelHtml: `Type <span class="typed-match">${this.escape(k.name)}</span> to confirm`, maxlength: 64, autocomplete: 'off' },
      ],
      validate: (v) => !v.reason.trim() || v.reason !== v.reason.trim() || v.confirm !== k.name,
      submit: async (v, ui) => {
        const token = await this.confirmation('revoke', id);
        const res = await this.api('POST', `/api/keys/${id}/revoke`, { confirmation_token: token, reason: v.reason, confirm_name: v.confirm });
        await this.stampSeal(ui);
        this.toast(k.name + ' revoked', 'no', (res.result && res.result.reason && res.result.reason.code) || 'REVOKE_OK');
        this.keys = await this.allKeys(); if (this.current === 'keys') this.drawKeyRows();
        if (this.openKey && this.openKey.id === id) await this.openDrawer(id, true);
      },
    });
  }

  /* key drawer, with the key itself turning at the top */
  async openDrawer(id, refresh) {
    const res = await this.api('GET', `/api/keys/${id}`);
    const k = res.data; this.openKey = k;
    const admin = this.isAdmin(), drawer = this.$('#drawer');
    this.$('#d-name').textContent = k.name;
    this.$('#d-chips').innerHTML = `${this.keyChip(k)} <span class="chip dim"><i></i>${k.purpose === 'test' ? 'Test' : 'Standard'}</span>`;
    const left = this.daysUntil(k.next_rotation_due);
    const last = k.state === 'revoked' ? ['Revoked', this.day(k.revoked_at)] : k.state === 'expired' ? ['Expired', this.day(k.expires_at)] : ['Next rotation', left === null ? '—' : `in ${left} days`];
    this.$('#d-body').innerHTML = `
      ${admin && k.state === 'active' ? `<div class="actions"><button class="btn primary small" type="button" data-rotate-d="${this.escape(k.id)}">Rotate now</button></div>` : ''}
      <dl class="facts">
        <div><dt>Algorithm</dt><dd>${this.escape(k.algorithm)}</dd></div>
        <div><dt>Current version</dt><dd class="mono">v${this.escape(k.current_version)}</dd></div>
        <div><dt>Rotation period</dt><dd>Every ${this.escape(k.rotation_days)} days</dd></div>
        <div><dt>${this.escape(last[0])}</dt><dd>${this.escape(last[1])}</dd></div>
        <div><dt>Created</dt><dd>${this.escape(this.day(k.created_at))}</dd></div>
        <div><dt>${k.created_by ? 'Created by' : 'Key id'}</dt><dd>${k.created_by ? this.escape(k.created_by) : `#${this.escape(k.id)}`}</dd></div>
        ${k.expires_at && k.state !== 'expired' ? `<div><dt>Expires</dt><dd>${this.escape(this.day(k.expires_at))}</dd></div>` : ''}
      </dl>
      <div class="sect">Versions</div>
      <ol class="timeline">${(k.versions || []).slice().reverse().map((v) => `<li class="${v.status === 'current' ? 'cur' : ''}"><span class="dot"></span><div><b>v${this.escape(v.version)}</b> <small>${v.status === 'current' ? 'current' : 'retired, still decrypts'}</small></div><small>${this.escape(this.day(v.created_at))}</small></li>`).join('')}</ol>
      ${k.state === 'revoked' ? `<div class="revoked-note"><b>Revoked ${this.escape(this.day(k.revoked_at))}.</b> ${k.revoke_reason ? `${this.escape(k.revoke_reason)}. ` : ''}Every use is refused and recorded.</div>`
        : admin ? '<div class="danger-zone"><p><b>Revoke this key</b>Permanent. Every later use is refused.</p><button class="btn danger small" type="button" data-revoke-d>Revoke</button></div>' : ''}`;
    const rb = this.$('[data-rotate-d]', drawer); if (rb) rb.addEventListener('click', () => this.rotateKey(k.id));
    const vb = this.$('[data-revoke-d]', drawer); if (vb) vb.addEventListener('click', () => this.revokeKey(k.id));
    this.$$('tr.k').forEach((r) => r.classList.toggle('sel', Number(r.dataset.id) === k.id));
    this.mountKeyStage(k);
    if (refresh) return;
    this.$('#scrim').classList.add('on'); drawer.setAttribute('aria-hidden', 'false');
    gsap.to(drawer, { xPercent: 0, duration: this.RM ? 0 : 0.55, ease: 'expo.out' });
    if (!this.RM) gsap.fromTo(this.$$('#d-body > *'), { opacity: 0, y: 10 }, { opacity: 1, y: 0, duration: 0.45, stagger: 0.05, delay: 0.12 });
    setTimeout(() => this.$('#d-close').focus(), 50);
  }
  mountKeyStage(k) {
    if (!KC3D.ok) { this.$('#keygl').hidden = true; return; }
    if (!this.keyStage) {
      const stage = new KC3D.Stage(this.$('#keygl'), { fov: 28, z: 8.2 });
      const mat = KC3D.brass(), key = KC3D.buildKey(mat); stage.scene.add(key);
      const state = { spin: 0 };
      stage.onFrame = (t) => {
        key.rotation.set(0.15, (this.RM ? 0.3 : Math.sin(t / 1.8) * 0.6) + state.spin * Math.PI * 2, -0.18);
        key.position.y = this.RM ? 0 : Math.sin(t / 1.1) * 0.08;
      };
      this.keyStage = { stage, mat, state };
    }
    const m = this.keyStage.mat;
    m.color.set(0xc9a35b);
    if (k.state === 'expired') m.color.lerp(KC3D.lin(0x8f8a82), 0.85);
    if (k.state === 'revoked') m.color.lerp(KC3D.lin(0x8a2a24), 0.7);
    m.roughness = k.state === 'expired' ? 0.6 : 0.27;
  }
  closeDrawer() {
    if (!this.openKey) return;
    this.openKey = null;
    this.$('#scrim').classList.remove('on'); this.$('#drawer').setAttribute('aria-hidden', 'true');
    this.$$('tr.k').forEach((r) => r.classList.remove('sel'));
    gsap.to('#drawer', { xPercent: 104, duration: this.RM ? 0 : 0.4, ease: 'power3.in' });
  }

  /* ---------- encrypt and decrypt ---------- */
  async renderCrypto() {
    const el = this.$('#view-crypto');
    el.innerHTML = `${this.vaultNotice()}
      <div class="two">
        <div class="card panel-pad">
          <h2>Seal</h2>
          <div class="field"><span id="kp-label">Key</span>
            <div class="picker" id="picker">
              <input type="hidden" id="enc-key">
              <button type="button" class="pick-btn" id="pick-btn" aria-haspopup="listbox" aria-expanded="false" aria-labelledby="kp-label pick-btn"></button>
              <ul class="pick-list" id="pick-list" role="listbox" tabindex="-1" aria-labelledby="kp-label"></ul>
            </div>
          </div>
          <label class="field"><span>Data to protect</span><textarea id="enc-data" maxlength="140000" placeholder="Type or paste the text to encrypt"></textarea></label>
          <div style="display:flex;justify-content:space-between;align-items:center;gap:10px"><small class="muted" id="enc-bytes"></small><button class="btn primary" id="enc-go" type="button">Encrypt</button></div>
          <div id="enc-out" aria-live="polite"></div>
        </div>
        <div class="card panel-pad">
          <h2>Open</h2>
          <label class="field"><span>Ciphertext package</span><textarea id="dec-pkg" maxlength="200000" placeholder="Paste a kc1 package"></textarea></label>
          <div style="display:flex;justify-content:space-between;align-items:center;gap:10px"><button class="linkbtn" id="dec-tamper" type="button">Change one character</button><button class="btn primary" id="dec-go" type="button">Decrypt</button></div>
          <div id="dec-out" aria-live="polite"></div>
        </div>
      </div>`;
    this.bindVaultButtons(el);
    this.armReveal(el);
    this.keys = await this.allKeys();
    if (this.current !== 'crypto') return;
    const purpose = this.isAdmin() ? 'test' : 'standard';
    this.pickerKeys = this.keys.filter((k) => k.state === 'active' && k.purpose === purpose);
    this.bindPicker();
    this.pickKey(this.pickerKeys.length ? this.pickerKeys[0].id : null);
    const data = this.$('#enc-data');
    const count = () => { this.$('#enc-bytes').textContent = `${new TextEncoder().encode(data.value).length.toLocaleString()} bytes, up to 64 KiB by default`; };
    data.addEventListener('input', count); count();
    this.$('#enc-out').innerHTML = this.isAdmin() ? '<p class="decision muted">Administrators may only use test keys. Operators use standard keys.</p>' : '';
    this.$('#enc-go').addEventListener('click', () => this.doEncrypt());
    this.$('#dec-go').addEventListener('click', () => this.doDecrypt());
    this.$('#dec-tamper').addEventListener('click', () => {
      const t = this.$('#dec-pkg'), v = t.value.trim(); if (!v) return;
      const i = Math.max(0, v.length - 6), c = v[i] === 'A' ? 'B' : 'A'; t.value = v.slice(0, i) + c + v.slice(i + 1);
      this.toast('One character changed in the ciphertext');
    });
  }
  bindPicker() {
    const btn = this.$('#pick-btn'), list = this.$('#pick-list');
    this.pickActive = 0;
    btn.addEventListener('click', () => (list.classList.contains('on') ? this.closePick() : this.openPick()));
    btn.addEventListener('keydown', (e) => { if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); this.openPick(); } });
    list.addEventListener('click', (e) => { const li = e.target.closest('li[data-id]'); if (!li) return; this.pickKey(Number(li.dataset.id)); this.closePick(); });
    list.addEventListener('mousemove', (e) => { const li = e.target.closest('li[data-id]'); if (!li) return; const i = this.pickerKeys.findIndex((k) => k.id === Number(li.dataset.id)); if (i !== this.pickActive) { this.pickActive = i; this.renderPickList(); } });
    list.addEventListener('keydown', (e) => {
      const n = this.pickerKeys.length;
      if (e.key === 'ArrowDown') { e.preventDefault(); this.pickActive = Math.min(n - 1, this.pickActive + 1); this.renderPickList(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); this.pickActive = Math.max(0, this.pickActive - 1); this.renderPickList(); }
      else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (this.pickerKeys[this.pickActive]) this.pickKey(this.pickerKeys[this.pickActive].id); this.closePick(); }
      else if (e.key === 'Escape' || e.key === 'Tab') this.closePick(e.key === 'Escape');
    });
    if (!this.pickDocBound) { this.pickDocBound = true; document.addEventListener('click', (e) => { const l = this.$('#pick-list'); if (l && l.classList.contains('on') && !e.target.closest('#picker')) this.closePick(false); }); }
  }
  pickSub(k) {
    const left = this.daysUntil(k.next_rotation_due);
    return `v${this.escape(k.current_version)} · ${k.purpose === 'test' ? 'test' : 'standard'} · <span class="${left !== null && left <= 7 ? 'due' : ''}">rotates in ${this.escape(left)} days</span>`;
  }
  pickKey(id) {
    const KEY_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="8" cy="12" r="4"/><path d="M12 12h9M18 12v3M21 12v2"/></svg>';
    const CHEV = '<svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';
    const k = this.pickerKeys.find((x) => x.id === id), btn = this.$('#pick-btn');
    this.$('#enc-key').value = k ? k.id : '';
    btn.disabled = !k; this.$('#enc-go').disabled = !k;
    btn.innerHTML = k ? `<span class="kglyph ${k.purpose === 'test' ? 'test' : ''}">${KEY_ICON}</span><span><b>${this.escape(k.name)}</b><small>${this.pickSub(k)}</small></span>${CHEV}`
      : `<span class="kglyph">${KEY_ICON}</span><span><b>No key you may use</b><small>${this.isAdmin() ? 'Create an active test key first' : 'Ask an administrator for an active standard key'}</small></span>${CHEV}`;
  }
  renderPickList() {
    const KEY_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="8" cy="12" r="4"/><path d="M12 12h9M18 12v3M21 12v2"/></svg>';
    const TICK = '<svg class="tick" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true"><path d="m5 12 5 5 9-10"/></svg>';
    const cur = Number(this.$('#enc-key').value), list = this.$('#pick-list');
    list.innerHTML = this.pickerKeys.map((k, i) => `<li role="option" id="opt-${this.escape(k.id)}" data-id="${this.escape(k.id)}" aria-selected="${this.escape(k.id === cur)}" class="${i === this.pickActive ? 'act' : ''}"><span class="kglyph ${k.purpose === 'test' ? 'test' : ''}">${KEY_ICON}</span><span><b>${this.escape(k.name)}</b><small>${this.pickSub(k)}</small></span>${TICK}</li>`).join('');
    if (this.pickerKeys[this.pickActive]) list.setAttribute('aria-activedescendant', `opt-${this.pickerKeys[this.pickActive].id}`);
  }
  openPick() {
    const list = this.$('#pick-list');
    this.pickActive = Math.max(0, this.pickerKeys.findIndex((k) => k.id === Number(this.$('#enc-key').value)));
    this.renderPickList(); list.classList.add('on'); this.$('#pick-btn').setAttribute('aria-expanded', 'true'); list.focus();
    if (!this.RM) { gsap.fromTo(list, { opacity: 0, y: -6, scaleY: 0.96 }, { opacity: 1, y: 0, scaleY: 1, duration: 0.25, ease: 'power3.out' }); gsap.fromTo(this.$$('li', list), { opacity: 0, x: -6 }, { opacity: 1, x: 0, duration: 0.25, stagger: 0.03 }); }
  }
  closePick(focusBtn = true) {
    const list = this.$('#pick-list'); if (!list) return;
    list.classList.remove('on'); this.$('#pick-btn').setAttribute('aria-expanded', 'false'); if (focusBtn) this.$('#pick-btn').focus();
  }
  decisionLine(result) {
    if (!result) return '';
    const ok = result.decision === 'allowed', code = result.reason && result.reason.code, rule = result.rule && result.rule.name ? `${result.rule.name} v${result.rule.version}` : '';
    return `<p class="decision">${ok ? '<span class="chip ok"><i></i>Allowed</span>' : `<span class="chip no"><i></i>Refused</span> <code>${this.escape(code)}</code>`}<span class="muted">${this.escape(rule)}</span>${result.duration_ms !== undefined && result.duration_ms !== null ? `<span class="ms">${this.escape(result.duration_ms)} ms</span>` : ''}${result.audit_entry ? `<span class="ms">audit #${this.escape(result.audit_entry)}</span>` : ''}</p>${!ok && result.reason && result.reason.message ? `<p class="muted" style="font-size:13px;margin:4px 0 0">${this.escape(result.reason.message)}</p>` : ''}`;
  }
  pkgHTML(p) {
    const parts = String(p).split('.');
    if (parts.length !== 5) return this.escape(p);
    return `<span class="a">${this.escape(parts[0])}</span>.<span class="k">${this.escape(parts[1])}</span>.<span class="k">${this.escape(parts[2])}</span>.<span class="n">${this.escape(parts[3])}</span>.<span class="c">${this.escape(parts[4])}</span>`;
  }
  async doEncrypt() {
    const id = Number(this.$('#enc-key').value), data = this.$('#enc-data').value, out = this.$('#enc-out'), go = this.$('#enc-go');
    if (!id || !data) { out.innerHTML = '<p class="decision muted">Pick a key and type something to encrypt.</p>'; return; }
    go.classList.add('busy');
    try {
      const res = await this.api('POST', '/api/crypto/encrypt', { key_id: id, data });
      const pkg = res.data.package;
      out.innerHTML = `<div class="pkg">${this.pkgHTML(pkg)}</div><div class="legend"><span><i style="background:var(--ink-3)"></i>format</span><span><i style="background:var(--gold)"></i>key id and version, bound in</span><span><i style="background:var(--patina)"></i>nonce</span><span><i style="background:var(--ink)"></i>ciphertext and tag</span></div>${this.decisionLine(res.result)}<div style="display:flex;gap:14px;margin-top:6px"><button class="linkbtn" type="button" id="send-open">Open it on the right</button><button class="linkbtn" type="button" id="copy-pkg">Copy</button></div>`;
      if (!this.RM) gsap.from(this.$$('#enc-out .pkg span'), { opacity: 0, y: 6, stagger: 0.08, duration: 0.4 });
      this.$('#send-open').addEventListener('click', () => { this.$('#dec-pkg').value = pkg; if (!this.RM) gsap.fromTo('#dec-pkg', { backgroundColor: 'rgba(176,138,62,.3)' }, { backgroundColor: 'rgba(238,228,207,1)', duration: 1, clearProps: 'backgroundColor' }); });
      this.$('#copy-pkg').addEventListener('click', () => { if (navigator.clipboard) navigator.clipboard.writeText(pkg).then(() => this.toast('Package copied')); });
    } catch (err) {
      out.innerHTML = (err.body && err.body.result ? this.decisionLine(err.body.result) : `<p class="decision"><span class="chip no"><i></i>Refused</span> <code>${this.escape(err.code)}</code></p>`) + `<p class="muted" style="font-size:13px;margin:4px 0 0">${this.escape(this.explain(err))}</p>`;
    } finally { go.classList.remove('busy'); }
  }
  async doDecrypt() {
    const pkg = this.$('#dec-pkg').value.trim(), out = this.$('#dec-out'), go = this.$('#dec-go');
    if (!pkg) { out.innerHTML = '<p class="decision muted">Paste a package first.</p>'; return; }
    go.classList.add('busy');
    try {
      const res = await this.api('POST', '/api/crypto/decrypt', { package: pkg });
      out.innerHTML = `<div class="pkg" style="color:var(--ink);white-space:pre-wrap">${this.escape(res.data.plaintext)}</div>${this.decisionLine(res.result)}`;
    } catch (err) {
      out.innerHTML = err.body && err.body.result ? this.decisionLine(err.body.result) : `<p class="decision"><span class="chip no"><i></i>Refused</span> <code>${this.escape(err.code)}</code></p><p class="muted" style="font-size:13px;margin:4px 0 0">${this.escape(this.explain(err))}</p>`;
      if (!this.RM) gsap.fromTo('#dec-pkg', { x: -6 }, { x: 0, duration: 0.4, ease: 'elastic.out(1, 0.3)' });
    } finally { go.classList.remove('busy'); }
  }

  /* ---------- decision history ---------- */
  async renderHistory() {
    const el = this.$('#view-history');
    this.histFilter = '';
    el.innerHTML = `
      <div class="filters">
        <div class="seg" id="hist-seg" role="group" aria-label="Outcome"><button type="button" class="on" data-f="">All</button><button type="button" data-f="ok">Allowed</button><button type="button" data-f="no">Refused</button></div>
        <span class="muted" style="font-size:13px">${this.user.role === 'operator' ? 'Your own encrypt and decrypt requests.' : 'Every key decision.'}</span>
        <div class="exports"><a class="btn quiet small" href="/api/reports/export?format=csv" download>Export CSV</a><a class="btn quiet small" href="/api/reports/export?format=json" download>Export JSON</a></div>
      </div>
      <div class="card"><ul class="tl" id="history-list"><li class="muted" style="display:block">Loading…</li></ul><div class="more" id="hist-more" hidden><button class="btn quiet small" type="button">Load more</button></div></div>`;
    this.histItems = []; this.histCursor = null;
    this.$$('#hist-seg button').forEach((b) => b.addEventListener('click', () => { this.$$('#hist-seg button').forEach((x) => x.classList.toggle('on', x === b)); this.histFilter = b.dataset.f; this.drawHistory(); }));
    this.$('#hist-more button').addEventListener('click', () => this.loadHistory());
    this.armReveal(el);
    await this.loadHistory();
  }
  async loadHistory() {
    const q = this.histCursor ? `&before_entry=${encodeURIComponent(this.histCursor)}` : '';
    const res = await this.api('GET', `/api/results?limit=50${q}`);
    this.histItems.push(...res.data.items); this.histCursor = res.data.next_cursor;
    if (this.current === 'history') this.drawHistory();
  }
  drawHistory() {
    const f = this.histFilter, items = this.histItems.filter((it) => !f || (f === 'ok') === (it.outcome === 'success'));
    this.$('#history-list').innerHTML = items.length ? items.map((it) => this.tlItem(it)).join('') : '<li class="muted" style="display:block">Nothing here yet.</li>';
    this.$('#hist-more').hidden = !this.histCursor;
    this.armReveal(this.$('#history-list'));
  }

  /* ---------- audit chain ---------- */
  async renderAudit() {
    const el = this.$('#view-audit');
    this.auditFilter = this.auditFilter || { outcome: '', severity: '', user: '' };
    const A = this.auditFilter;
    el.innerHTML = `
      <div class="audit-head">
        <div class="hash" style="flex:1;min-width:240px"><div class="muted" style="font-size:12px" id="head-label">Chain head</div><span id="head-hash">…</span></div>
        <button class="btn primary" id="audit-verify" type="button">Verify chain</button>
      </div>
      <div id="tamper"></div>
      <div class="filters">
        <select id="f-outcome" aria-label="Outcome">${[['', 'Any outcome'], ['success', 'Success'], ['failure', 'Failure'], ['denied', 'Denied']].map(([v, l]) => `<option value="${v}"${A.outcome === v ? ' selected' : ''}>${l}</option>`).join('')}</select>
        <select id="f-severity" aria-label="Severity">${[['', 'Any severity'], ['info', 'Info'], ['warning', 'Warning'], ['critical', 'Critical']].map(([v, l]) => `<option value="${v}"${A.severity === v ? ' selected' : ''}>${l}</option>`).join('')}</select>
        <input id="f-user" placeholder="User" maxlength="64" value="${this.escape(A.user)}" aria-label="User">
      </div>
      <div class="card" style="padding:4px 14px"><ul class="entries" id="entries"><li class="muted" style="display:block">Loading…</li></ul><div class="more" id="audit-more" hidden><button class="btn quiet small" type="button">Load more</button></div></div>`;
    const reload = () => { A.outcome = this.$('#f-outcome').value; A.severity = this.$('#f-severity').value; A.user = this.$('#f-user').value.trim(); this.auditItems = []; this.auditCursor = null; this.loadAudit(); };
    this.$('#f-outcome').addEventListener('change', reload); this.$('#f-severity').addEventListener('change', reload);
    let tmr; this.$('#f-user').addEventListener('input', () => { clearTimeout(tmr); tmr = setTimeout(reload, 350); });
    this.$('#audit-more button').addEventListener('click', () => this.loadAudit());
    this.$('#audit-verify').addEventListener('click', () => this.verifyAuditPage());
    this.armReveal(el);
    this.auditItems = []; this.auditCursor = null;
    await this.loadAudit();
  }
  async loadAudit() {
    const A = this.auditFilter, qs = new URLSearchParams({ limit: '50' });
    if (A.outcome) qs.set('outcome', A.outcome); if (A.severity) qs.set('severity', A.severity); if (A.user) qs.set('user', A.user);
    if (this.auditCursor) qs.set('before_entry', String(this.auditCursor));
    const res = await this.api('GET', `/api/audit?${qs.toString()}`);
    if (this.current !== 'audit') return;
    this.auditItems.push(...res.data.items); this.auditCursor = res.data.next_cursor;
    const hd = res.data.chain_head;
    this.$('#head-label').textContent = `Chain head, entry ${hd.entry_count.toLocaleString()}`; this.$('#head-hash').textContent = hd.hash;
    const ul = this.$('#entries');
    ul.innerHTML = '<span class="rail"></span>' + (this.auditItems.length ? this.auditItems.map((ev) => {
      const ok = ev.outcome === 'success';
      return `<li data-entry="${this.escape(ev.entry_no)}"><span class="lnk"></span><span class="no">#${this.escape(ev.entry_no)}</span><span><b>${this.escape(ev.action)}</b> <small>${ev.user ? `by ${this.escape(ev.user)}` : ''}${ev.target ? ` · ${this.escape(ev.target)}` : ''}</small></span><span class="h">${this.escape(String(ev.hash || '').slice(0, 10))}…</span><span class="muted" style="font-size:12.5px">${this.escape(this.ago(ev.time))}</span><span>${ok ? '<span class="chip ok"><i></i>success</span>' : `<span class="chip ${ev.outcome === 'denied' ? 'no' : 'warn'}"><i></i>${this.escape(ev.reason || ev.outcome)}</span>`}</span></li>`;
    }).join('') : '<li class="muted" style="display:block">No entries match.</li>');
    this.$('#audit-more').hidden = !this.auditCursor;
    this.armReveal(ul);
  }
  async verifyAuditPage() {
    this.$('#tamper').innerHTML = '';
    const out = await this.verifyChain('page');
    // the check itself is recorded, so reload the newest entries first and then walk them
    if (out.ok) { this.auditItems = []; this.auditCursor = null; await this.loadAudit(); }
    const ul = this.$('#entries'), rail = this.$('.rail', ul), lis = this.$$('li[data-entry]', ul).reverse();
    lis.forEach((l) => l.classList.remove('ok', 'bad'));
    if (!lis.length) return;
    const top = lis[lis.length - 1].offsetTop + lis[lis.length - 1].offsetHeight / 2, bottom = lis[0].offsetTop + lis[0].offsetHeight / 2;
    const bad = out.tamper ? Number(out.tamper.first_mismatch) : null;
    gsap.set(rail, { height: 0, bottom: ul.offsetHeight - bottom, background: 'var(--patina)' });
    const o = { p: 0 };
    gsap.to(o, { p: 1, duration: this.RM ? 0 : 1.6, ease: 'none', onUpdate: () => {
      rail.style.height = `${o.p * (bottom - top)}px`;
      lis.forEach((l, i) => {
        if (o.p * (lis.length - 1) >= i - 0.001 && !l.classList.contains('ok') && !l.classList.contains('bad')) {
          const broken = bad !== null && Number(l.dataset.entry) >= bad;
          l.classList.add(broken ? 'bad' : 'ok');
          if (!this.RM) gsap.fromTo(this.$('.lnk', l), { scale: 0.4 }, { scale: 1, duration: 0.4, ease: 'back.out(3)' });
        }
      });
    } });
    if (out.tamper) {
      const r = out.tamper;
      this.$('#tamper').innerHTML = `<div class="tamper" role="alert"><b>Verification failed. The first entry that no longer fits is #${this.escape(r.first_mismatch)}.</b><small>${this.escape(r.reason || '')} Everything from that entry on can’t be trusted. A restore from the newest good backup keeps a copy of this log as evidence.</small></div>`;
      gsap.set(rail, { background: 'var(--oxide)' });
    }
  }

  /* ---------- backups and recovery ---------- */
  async renderBackup() {
    const el = this.$('#view-backup');
    el.innerHTML = `${this.vaultNotice()}
      <div class="toolbar"><p class="muted" style="margin:0;flex:1">Backups are authenticated with HMAC and need the vault unlocked. The recovery drill restores one aside and proves a key still decrypts, without touching live data.</p><button class="btn primary" type="button" id="bk-create">Create backup</button></div>
      <div class="card" id="drill-card" hidden>
        <div class="card-h"><h2 id="drill-title">Recovery drill</h2></div>
        <ol class="drill" id="drill"><span class="fill"></span>
          <li><div class="num">1</div><h3>Authenticate</h3><p>The backup’s HMAC tag is checked.</p></li>
          <li><div class="num">2</div><h3>Verify the chain</h3><p>Its audit log is walked end to end.</p></li>
          <li><div class="num">3</div><h3>Restore aside</h3><p>Loaded into a temporary database.</p></li>
          <li><div class="num">4</div><h3>Prove it decrypts</h3><p>A restored key opens a proof.</p></li>
        </ol>
      </div>
      <div class="card" style="margin-top:18px"><div class="card-h"><h2>Backups</h2></div><ul class="bk-list" id="bk-list"><li class="muted">Loading…</li></ul></div>`;
    this.bindVaultButtons(el);
    this.$('#bk-create').addEventListener('click', () => this.createBackup());
    this.$('#bk-list').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-act]'); if (!b) return;
      const name = b.closest('li').dataset.name;
      ({ verify: () => this.verifyBackup(name, b), drill: () => this.drillBackup(name), restore: () => this.restoreBackup(name) })[b.dataset.act]();
    });
    this.armReveal(el);
    await this.loadBackups();
  }
  async loadBackups() {
    const res = await this.api('GET', '/api/backups');
    if (this.current !== 'backup') return;
    const items = res.data.items;
    this.$('#bk-list').innerHTML = items.length ? items.map((b) => `<li data-name="${this.escape(b.name)}"><div><b>${this.escape(b.name)}</b><small>${this.escape(this.ago(b.modified_at))}, ${this.escape(Math.round(b.size / 1024).toLocaleString())} KiB</small></div><span></span><div class="bk-actions"><button class="btn quiet small" type="button" data-act="verify">Verify</button><button class="btn quiet small" type="button" data-act="drill">Recovery drill</button><button class="btn danger small" type="button" data-act="restore">Restore</button></div></li>`).join('')
      : '<li><div class="empty" style="grid-column:1/-1"><b>No backups yet</b>Create one with the vault unlocked.</div></li>';
    this.armReveal(this.$('#bk-list'));
  }
  async targetToken(action, name) {
    const res = await this.api('POST', '/api/confirmations', name ? { action, backup_name: name } : { action });
    return res.data.confirmation_token;
  }
  createBackup() {
    this.dialog({
      title: 'Create a backup', lead: 'Keys go in still wrapped. The backup is authenticated, not encrypted, so store it as carefully as the database.', confirm: 'Create backup',
      submit: async () => {
        const token = await this.targetToken('backup');
        const res = await this.api('POST', '/api/backups', { confirmation_token: token });
        this.toast(`Backup created: ${res.data.name}`, 'ok', `${res.data.chain_head.entry_count} audit entries inside`);
        await this.loadBackups();
      },
    });
  }
  async verifyBackup(name, btn) {
    btn.classList.add('busy');
    try {
      const res = await this.api('POST', `/api/backups/${encodeURIComponent(name)}/verify`);
      this.toast('Backup authentic', 'ok', `${res.data.chain_head.entry_count} audit entries, HMAC valid`);
    } catch (err) { this.toast(err.code === 'BACKUP_INVALID' ? 'This backup failed authentication' : this.explain(err), 'no', err.code); }
    finally { btn.classList.remove('busy'); }
  }
  drillBackup(name) {
    this.dialog({
      title: 'Recovery drill', lead: `Restores <b>${this.escape(name)}</b> into a temporary database and proves it still decrypts. Live data isn’t touched.`, confirm: 'Run the drill',
      fields: [{ id: 'pass', label: 'Vault passphrase', type: 'password', autocomplete: 'off', maxlength: 256 }],
      validate: (v) => !v.pass,
      submit: async (v) => {
        const token = await this.targetToken('recovery_drill', name);
        const card = this.$('#drill-card'), steps = this.$$('#drill li'), fill = this.$('#drill .fill');
        card.hidden = false; this.$('#drill-title').textContent = `Recovery drill, ${name}`;
        steps.forEach((s) => s.classList.remove('on', 'fail')); gsap.set(fill, { scaleX: 0 });
        try {
          const res = await this.api('POST', '/api/recovery-drill', { confirmation_token: token, passphrase: v.pass, backup_name: name });
          const passed = res.data.steps.map((s) => s.passed);
          setTimeout(() => {
            if (!this.RM) gsap.to(fill, { scaleX: 1, duration: 2.2, ease: 'none' });
            steps.forEach((s, i) => setTimeout(() => s.classList.add(passed[i] ? 'on' : 'fail'), this.RM ? 0 : 550 * (i + 1)));
            setTimeout(() => this.toast('Recovery drill passed', 'ok', 'RECOVERY_DRILL_PASSED'), this.RM ? 0 : 2400);
          }, 200);
          card.scrollIntoView({ behavior: this.RM ? 'auto' : 'smooth', block: 'center' });
        } catch (err) {
          steps[0].classList.add('fail');
          throw new Error(err.code === 'BACKUP_INVALID' ? 'The drill failed: the backup or the passphrase didn’t check out.' : this.explain(err));
        }
      },
    });
  }
  restoreBackup(name) {
    this.dialog({
      title: 'Restore this backup', danger: true, confirm: 'Restore',
      lead: `Returns the system to <b>${this.escape(name)}</b>. Keys created since then are lost. Revocations and disabled users are never undone. The vault locks afterwards.`,
      fields: [
        { id: 'pass', label: 'Vault passphrase', type: 'password', autocomplete: 'off', maxlength: 256 },
        { id: 'sure', type: 'checkbox', label: 'Confirm', text: 'I understand this replaces the live data.' },
      ],
      validate: (v) => !v.pass || !v.sure,
      submit: async (v) => {
        const token = await this.targetToken('restore', name);
        await this.api('POST', `/api/backups/${encodeURIComponent(name)}/restore`, { confirmation_token: token, passphrase: v.pass });
        this.toast('Backup restored. The vault is locked.', 'ok', 'BACKUP_RESTORED');
        this.setVaultState(true, false);
        this.navigate('backup', false);
      },
    });
  }

  /* ---------- users and settings ---------- */
  async renderAdmin() {
    const el = this.$('#view-admin');
    el.innerHTML = `
      <div class="admin-grid">
        <div class="card"><div class="card-h"><h2>Users</h2></div><div class="table-wrap"><table class="users"><thead><tr><th>User</th><th>Role</th><th>Active</th><th class="hide-sm">Last sign-in</th></tr></thead><tbody id="users-body"><tr><td colspan="4" class="muted">Loading…</td></tr></tbody></table></div></div>
        <div class="card"><div class="card-h"><h2>Add a user</h2></div>
          <form class="form-pad" id="user-form" novalidate>
            <label class="field"><span>Username</span><input id="nu-name" maxlength="64" autocomplete="off"></label>
            <label class="field"><span>Password</span><input id="nu-pass" type="password" maxlength="256" autocomplete="new-password"><small class="hint">12 characters or more. Share it privately.</small></label>
            <label class="field"><span>Role</span><select id="nu-role"><option value="operator">Operator</option><option value="viewer">Viewer</option><option value="administrator">Administrator</option></select></label>
            <p class="auth-err" id="nu-err" role="alert" style="color:var(--oxide);font-size:13.5px;margin:0 0 8px"></p>
            <button class="btn primary" type="submit" id="nu-go">Add user</button>
          </form>
        </div>
      </div>
      <div class="card" style="margin-top:18px"><div class="card-h"><h2>Settings</h2><span class="spacer"></span><small class="muted">Every change is versioned and recorded.</small></div><ul class="settings" id="settings"><li class="muted">Loading…</li></ul></div>`;
    this.$('#user-form').addEventListener('submit', (e) => { e.preventDefault(); this.addUser(); });
    this.$('#users-body').addEventListener('change', (e) => { const s = e.target.closest('select[data-uid]'); if (s) this.patchUser(Number(s.dataset.uid), { role: s.value }, s); });
    this.$('#users-body').addEventListener('click', (e) => { const sw = e.target.closest('.switch[data-uid]'); if (sw) this.patchUser(Number(sw.dataset.uid), { disabled: sw.getAttribute('aria-checked') === 'true' }, sw); });
    this.$('#settings').addEventListener('input', (e) => {
      const li = e.target.closest('li[data-name]'); if (!li) return;
      const v = e.target.value; this.$$('input', li).forEach((i) => { if (i !== e.target) i.value = v; });
      this.$('button', li).disabled = Number(v) === Number(li.dataset.value);
    });
    this.$('#settings').addEventListener('click', (e) => { const b = e.target.closest('button[data-save]'); if (b) this.saveSetting(b.closest('li')); });
    this.armReveal(el);
    await Promise.all([this.loadUsers(), this.loadSettings()]);
  }
  async loadUsers() {
    const users = await this.api('GET', '/api/users');
    if (this.current !== 'admin') return;
    this.$('#users-body').innerHTML = users.map((u) => `<tr><td><b>${this.escape(u.username)}</b>${u.username === this.user.username ? ' <small class="muted">you</small>' : ''}</td>
      <td><select data-uid="${this.escape(u.id)}" aria-label="Role for ${this.escape(u.username)}">${['administrator', 'operator', 'viewer'].map((r) => `<option value="${r}"${u.role === r ? ' selected' : ''}>${this.roleName(r)}</option>`).join('')}</select></td>
      <td><button type="button" class="switch" role="switch" data-uid="${this.escape(u.id)}" aria-checked="${u.disabled ? 'false' : 'true'}" aria-label="${this.escape(u.username)} can sign in"></button></td>
      <td class="hide-sm muted">${u.last_login ? this.escape(this.ago(new Date(u.last_login * 1000).toISOString())) : 'never'}</td></tr>`).join('');
  }
  async patchUser(id, body, ctl) {
    try {
      await this.api('PATCH', `/api/users/${id}`, body);
      if (ctl.classList.contains('switch')) ctl.setAttribute('aria-checked', body.disabled ? 'false' : 'true');
      this.toast(body.role ? `Role changed to ${this.roleName(body.role)}` : (body.disabled ? 'User disabled, their sessions ended' : 'User enabled'), 'ok');
    } catch (err) {
      this.toast(err.code === 'INVALID_INPUT' ? 'The last administrator can’t be demoted or disabled' : this.explain(err), 'no', err.code);
      await this.loadUsers();
    }
  }
  async addUser() {
    const name = this.$('#nu-name').value.trim(), pass = this.$('#nu-pass').value, role = this.$('#nu-role').value, err = this.$('#nu-err'), go = this.$('#nu-go');
    err.textContent = '';
    if (!/^[A-Za-z0-9_.-]{3,64}$/.test(name)) { err.textContent = 'Use 3 to 64 letters, numbers, dots, dashes or underscores.'; return; }
    if (pass.length < 12) { err.textContent = 'The password needs 12 characters or more.'; return; }
    go.classList.add('busy');
    try {
      await this.api('POST', '/api/users', { username: name, password: pass, role });
      this.$('#nu-name').value = ''; this.$('#nu-pass').value = '';
      this.toast(`${name} added as ${this.roleName(role).toLowerCase()}`, 'ok');
      await this.loadUsers();
    } catch (e) { err.textContent = e.code === 'INVALID_INPUT' ? 'That username is taken or not valid.' : this.explain(e); }
    finally { go.classList.remove('busy'); }
  }
  async loadSettings() {
    const list = await this.api('GET', '/api/settings');
    if (this.current !== 'admin') return;
    this.$('#settings').innerHTML = list.map((s) => `<li data-name="${this.escape(s.name)}" data-value="${this.escape(s.value)}"><div><b>${this.escape(s.label)}</b><small>Allowed ${this.escape(s.minimum)} to ${this.escape(s.maximum)} · <span class="ver-tag">v${this.escape(s.version)}${s.changed_by ? `, by ${this.escape(s.changed_by)}` : ''}</span></small></div>
      <input type="range" min="${this.escape(s.minimum)}" max="${this.escape(s.maximum)}" value="${this.escape(s.value)}" aria-label="${this.escape(s.label)}">
      <input type="number" min="${this.escape(s.minimum)}" max="${this.escape(s.maximum)}" value="${this.escape(s.value)}" aria-label="${this.escape(s.label)} value">
      <button class="btn quiet small" type="button" data-save disabled>Save</button></li>`).join('');
    this.armReveal(this.$('#settings'));
  }
  async saveSetting(li) {
    const name = li.dataset.name, value = Number(this.$('input[type=number]', li).value), btn = this.$('button', li);
    btn.classList.add('busy');
    try {
      await this.api('PATCH', `/api/settings/${encodeURIComponent(name)}`, { value });
      this.toast('Setting saved', 'ok', `${name} = ${value}`);
      await this.loadSettings();
    } catch (err) { this.toast(err.code === 'SETTING_OUT_OF_RANGE' ? 'That value is outside the allowed range' : this.explain(err), 'no', err.code); btn.classList.remove('busy'); }
  }
}

window.KCApp = new KeyCycleApp();
window.KCApp.boot();
