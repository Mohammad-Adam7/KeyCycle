/**
 * KeyCycle Frontend Controller
 * Strictly integrates with Part A (Auth/Vault), Part B (Key Lifecycle),
 * Part C (Audit/Backup), and Part D (Reports & UI).
 */

class KeyCycleApp {
  constructor() {
    this.user = null;
    this.vaultLocked = true;
    this.currentView = 'auth';
    this.revokingKey = null;

    this.initEventListeners();
    this.checkSession();
  }

  // API HTTP Helper
  async api(endpoint, method = 'GET', body = null) {
    const options = {
      method,
      headers: {
        'Accept': 'application/json',
      },
    };

    if (body !== null) {
      options.headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(body);
    }

    if (['POST', 'PATCH', 'PUT', 'DELETE'].includes(method) && this.user?.csrf_token) {
      options.headers['X-CSRF-Token'] = this.user.csrf_token;
    }

    const res = await fetch(endpoint, options);
    if (res.status === 401) {
      this.handleSessionExpired();
      throw new Error('SESSION_EXPIRED');
    }

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.message || data.code || 'REQUEST_FAILED');
      err.code = data.code;
      err.data = data;
      throw err;
    }
    return data;
  }

  // Session Management
  async checkSession() {
    try {
      const session = await this.api('/api/auth/session');
      this.setUser(session);
      await this.checkVault();
      this.showView('dashboard');
    } catch {
      this.showView('auth');
    }
  }

  setUser(session) {
    this.user = session;
    document.getElementById('main-nav').style.display = 'flex';
    document.getElementById('user-badge').style.display = 'block';
    document.getElementById('vault-pill').style.display = 'flex';
    document.getElementById('btn-signout').style.display = 'inline-flex';
    document.getElementById('btn-password').style.display = 'inline-flex';

    document.getElementById('user-name').textContent = session.username;
    document.getElementById('user-role').textContent = session.role;

    // Role-based navigation visibility
    const isAdmin = session.role === 'administrator';
    const isOp = session.role === 'operator';
    document.getElementById('nav-audit').style.display = isAdmin ? 'inline-block' : 'none';
    document.getElementById('nav-admin').style.display = isAdmin ? 'inline-block' : 'none';
    document.getElementById('nav-crypto').style.display = (isAdmin || isOp) ? 'inline-block' : 'none';
    document.getElementById('btn-create-key-modal').style.display = isAdmin ? 'inline-block' : 'none';
    document.getElementById('card-backups-admin').style.display = isAdmin ? 'block' : 'none';
    document.getElementById('card-drill-admin').style.display = isAdmin ? 'block' : 'none';
  }

  handleSessionExpired() {
    this.user = null;
    document.getElementById('main-nav').style.display = 'none';
    document.getElementById('user-badge').style.display = 'none';
    document.getElementById('vault-pill').style.display = 'none';
    document.getElementById('btn-signout').style.display = 'none';
    document.getElementById('btn-password').style.display = 'none';
    this.showView('auth');
  }

  // Vault Management
  async checkVault() {
    if (!this.user) return;
    try {
      const st = await this.api('/api/vault/status');
      this.vaultLocked = st.locked;
      const pill = document.getElementById('vault-pill');
      const text = document.getElementById('vault-text');
      const dashStatus = document.getElementById('dash-vault-status');

      if (st.locked) {
        pill.className = 'vault-pill locked';
        text.textContent = 'VAULT: LOCKED';
        dashStatus.className = 'badge state-revoked';
        dashStatus.textContent = 'LOCKED';
      } else {
        pill.className = 'vault-pill unlocked';
        text.textContent = 'VAULT: UNLOCKED';
        dashStatus.className = 'badge state-active';
        dashStatus.textContent = 'UNLOCKED';
      }
    } catch (e) {
      console.error(e);
    }
  }

  async toggleVault() {
    if (this.vaultLocked) {
      this.openModal('modal-unlock');
    } else {
      if (confirm('Lock master vault now? Active keys cannot be decrypted while locked.')) {
        await this.api('/api/vault/lock', 'POST');
        await this.checkVault();
      }
    }
  }

  // View Navigation
  showView(viewName) {
    this.currentView = viewName;
    document.querySelectorAll('.view-panel').forEach(p => p.classList.remove('active'));
    document.querySelectorAll('.nav-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.view === viewName);
    });

    const target = document.getElementById(`view-${viewName}`);
    if (target) target.classList.add('active');

    // Trigger view-specific data loads
    if (viewName === 'dashboard') this.loadDashboard();
    if (viewName === 'keys') this.loadKeys();
    if (viewName === 'crypto') this.loadCrypto();
    if (viewName === 'audit') this.loadAudit();
    if (viewName === 'backup') this.loadBackups();
    if (viewName === 'admin') this.loadAdmin();
  }

  // Dashboard Loader
  async loadDashboard() {
    await this.checkVault();
    try {
      const keys = await this.api('/api/keys?limit=100');
      const items = keys.data?.items || keys || [];
      let active = 0, expired = 0, revoked = 0;
      items.forEach(k => {
        if (k.state === 'active') active++;
        else if (k.state === 'expired') expired++;
        else if (k.state === 'revoked') revoked++;
      });
      document.getElementById('stat-active-keys').textContent = active;
      document.getElementById('stat-expired-keys').textContent = expired;
      document.getElementById('stat-revoked-keys').textContent = revoked;

      const results = await this.api('/api/results?limit=1').catch(() => null);
      if (results && results.data?.items?.length) {
        const r = results.data.items[0];
        document.getElementById('dash-chain-count').textContent = r.entry_no;
        document.getElementById('dash-chain-hash').textContent = r.hash;
      }
    } catch (e) {
      console.warn('Dashboard load warn:', e);
    }
  }

  // Key Management
  async loadKeys() {
    const tbody = document.querySelector('#table-keys tbody');
    tbody.innerHTML = '<tr><td colspan="8" style="text-align: center;">Loading keys...</td></tr>';

    const state = document.getElementById('keys-filter-state').value;
    const purpose = document.getElementById('keys-filter-purpose').value;
    let url = '/api/keys?limit=100';
    if (state) url += `&state=${encodeURIComponent(state)}`;
    if (purpose) url += `&purpose=${encodeURIComponent(purpose)}`;

    try {
      const res = await this.api(url);
      const keys = res.data?.items || res || [];
      if (!keys.length) {
        tbody.innerHTML = '<tr><td colspan="8" style="text-align: center; color: var(--text-dim);">No cryptographic keys found.</td></tr>';
        return;
      }

      const isAdmin = this.user?.role === 'administrator';
      tbody.innerHTML = keys.map(k => {
        const stateClass = `state-${this.escape(k.state)}`;
        const canRotate = isAdmin && k.state === 'active';
        const canRevoke = isAdmin && k.state !== 'revoked';

        return `
          <tr>
            <td class="mono">${this.escape(k.id)}</td>
            <td><strong>${this.escape(k.name)}</strong></td>
            <td><span class="badge ${k.purpose === 'test' ? 'sev-warning' : 'sev-info'}">${this.escape(k.purpose)}</span></td>
            <td><span class="badge ${stateClass}">${this.escape(k.state)}</span></td>
            <td class="mono">v${this.escape(k.current_version)}</td>
            <td>${this.escape(k.rotation_days)} days</td>
            <td class="mono" style="font-size: 0.75rem;">${this.escape(k.created_at || '-')}</td>
            <td>
              <div style="display: flex; gap: 0.35rem;">
                <button class="btn btn-secondary btn-sm" data-action="show-details" data-key-id="${this.escape(k.id)}">Details</button>
                ${canRotate ? `<button class="btn btn-primary btn-sm" data-action="rotate-key" data-key-id="${this.escape(k.id)}">Rotate</button>` : ''}
                ${canRevoke ? `<button class="btn btn-danger btn-sm" data-action="revoke-key" data-key-id="${this.escape(k.id)}" data-key-name="${this.escape(k.name)}">Revoke</button>` : ''}
              </div>
            </td>
          </tr>
        `;
      }).join('');
    } catch (e) {
      tbody.innerHTML = `<tr><td colspan="8" style="color: #ef4444;">Error loading keys: ${this.escape(e.message)}</td></tr>`;
    }
  }

  async showKeyDetails(keyId) {
    try {
      const res = await this.api(`/api/keys/${keyId}`);
      const k = res.data || res;
      document.getElementById('details-modal-title').textContent = `Key: ${this.escape(k.name)} (ID: ${this.escape(k.id)})`;
      const body = document.getElementById('details-modal-body');

      let versionsHtml = '<div style="color: var(--text-dim); margin-top: 0.5rem;">No historical versions recorded.</div>';
      if (k.versions?.length) {
        versionsHtml = `
          <div style="margin-top: 0.75rem; font-weight: 600; color: var(--cyan-primary);">Key Versions:</div>
          <table style="margin-top: 0.5rem; font-size: 0.8rem;">
            <thead>
              <tr><th>Version</th><th>Status</th><th>Created (UTC)</th></tr>
            </thead>
            <tbody>
              ${k.versions.map(v => `
                <tr>
                  <td class="mono">v${this.escape(v.version)}</td>
                  <td><span class="badge ${v.status === 'current' ? 'state-active' : 'state-expired'}">${this.escape(v.status)}</span></td>
                  <td class="mono">${this.escape(v.created_at || '-')}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        `;
      }

      body.innerHTML = `
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 0.5rem; margin-bottom: 0.75rem;">
          <div><span style="color: var(--text-dim);">Algorithm:</span> <strong>${this.escape(k.algorithm)}</strong></div>
          <div><span style="color: var(--text-dim);">Purpose:</span> <span class="badge ${k.purpose === 'test' ? 'sev-warning' : 'sev-info'}">${this.escape(k.purpose)}</span></div>
          <div><span style="color: var(--text-dim);">State:</span> <span class="badge state-${this.escape(k.state)}">${this.escape(k.state)}</span></div>
          <div><span style="color: var(--text-dim);">Current Version:</span> <strong class="mono">v${this.escape(k.current_version)}</strong></div>
          <div><span style="color: var(--text-dim);">Rotation Period:</span> ${this.escape(k.rotation_days)} days</div>
          <div><span style="color: var(--text-dim);">Next Due:</span> <span class="mono">${this.escape(k.next_rotation_due || 'N/A')}</span></div>
          <div><span style="color: var(--text-dim);">Created At:</span> <span class="mono">${this.escape(k.created_at || '-')}</span></div>
          ${k.revoked_at ? `<div><span style="color: #f43f5e;">Revoked At:</span> <span class="mono">${this.escape(k.revoked_at)}</span></div>` : ''}
          ${k.revoke_reason ? `<div style="grid-column: span 2;"><span style="color: #f43f5e;">Revoke Reason:</span> <em>${this.escape(k.revoke_reason)}</em></div>` : ''}
        </div>
        ${versionsHtml}
      `;
      this.openModal('modal-key-details');
    } catch (e) {
      alert(`Failed to load key details: ${e.message}`);
    }
  }

  async rotateKey(keyId) {
    if (!confirm(`Rotate key ID ${keyId}? This creates a new version while retiring prior versions.`)) return;
    try {
      const conf = await this.api('/api/confirmations', 'POST', { key_id: keyId, action: 'rotate' });
      const token = conf.data?.confirmation_token || conf.confirmation_token;
      await this.api(`/api/keys/${keyId}/rotate`, 'POST', { confirmation_token: token });
      alert(`Key ${keyId} rotated successfully!`);
      this.loadKeys();
    } catch (e) {
      alert(`Rotation failed: ${e.message}`);
    }
  }

  promptRevoke(keyId, keyName) {
    this.revokingKey = { id: keyId, name: keyName };
    document.getElementById('revoke-target-name').value = `${keyName} (ID: ${keyId})`;
    document.getElementById('revoke-reason').value = '';
    document.getElementById('revoke-confirm-input').value = '';
    this.openModal('modal-revoke');
  }

  async handleRevokeSubmit(e) {
    e.preventDefault();
    if (!this.revokingKey) return;

    const typedName = document.getElementById('revoke-confirm-input').value.trim();
    if (typedName !== this.revokingKey.name) {
      alert('Confirmation failed: typed key name does not match exactly.');
      return;
    }

    const reason = document.getElementById('revoke-reason').value.trim();
    try {
      const conf = await this.api('/api/confirmations', 'POST', { key_id: this.revokingKey.id, action: 'revoke' });
      const token = conf.data?.confirmation_token || conf.confirmation_token;
      await this.api(`/api/keys/${this.revokingKey.id}/revoke`, 'POST', {
        confirmation_token: token,
        reason: reason,
        confirm_name: typedName,
      });
      this.closeModal('modal-revoke');
      alert(`Key ${typedName} has been permanently revoked.`);
      this.loadKeys();
    } catch (err) {
      alert(`Revocation failed: ${err.message}`);
    }
  }

  // Crypto Operations
  async loadCrypto() {
    const sel = document.getElementById('encrypt-key-id');
    sel.innerHTML = '<option value="">Select a key...</option>';
    try {
      const res = await this.api('/api/keys?state=active&limit=100');
      const keys = res.data?.items || res || [];
      const purpose = this.user?.role === 'administrator' ? 'test' : 'standard';
      const available = keys.filter(k => k.purpose === purpose && k.state === 'active');

      if (!available.length) {
        sel.innerHTML = `<option value="">No active ${this.escape(purpose)} keys available</option>`;
      } else {
        available.forEach(k => {
          const opt = document.createElement('option');
          opt.value = k.id;
          opt.textContent = `${this.escape(k.name)} (v${this.escape(k.current_version)}) [${this.escape(k.purpose)}]`;
          sel.appendChild(opt);
        });
      }
    } catch (e) {
      console.warn(e);
    }
  }

  async handleEncrypt(e) {
    e.preventDefault();
    const keyId = parseInt(document.getElementById('encrypt-key-id').value);
    const plaintext = document.getElementById('encrypt-plaintext').value;

    try {
      const res = await this.api('/api/crypto/encrypt', 'POST', { key_id: keyId, data: plaintext });
      document.getElementById('encrypt-package').textContent = res.data?.package || res.package;
      document.getElementById('encrypt-result').style.display = 'block';

      this.renderDecisionBadge(res.result || {
        decision: 'allowed',
        rule: { name: 'input_validation', version: 1 },
        key: { id: keyId, version: 1 },
        duration_ms: 1,
        severity: 'info',
      });
    } catch (err) {
      alert(`Encryption failed: ${err.message}`);
      if (err.data?.result) {
        this.renderDecisionBadge(err.data.result);
      }
    }
  }

  async handleDecrypt(e) {
    e.preventDefault();
    const pkg = document.getElementById('decrypt-package-input').value.trim();

    try {
      const res = await this.api('/api/crypto/decrypt', 'POST', { package: pkg });
      document.getElementById('decrypt-plaintext').textContent = res.data?.plaintext || res.plaintext;
      document.getElementById('decrypt-result').style.display = 'block';

      this.renderDecisionBadge(res.result || {
        rule: 'data_decryption',
        outcome: 'SUCCESS',
        severity: 'info',
        duration_ms: res.result?.duration_ms || 1,
      });
    } catch (err) {
      alert(`Decryption failed: ${err.message}`);
      if (err.data?.result) {
        this.renderDecisionBadge(err.data.result);
      }
    }
  }

  renderDecisionBadge(res) {
    if (!res) return;
    const panel = document.getElementById('crypto-decision-panel');
    panel.style.display = 'block';

    // 1. Rule Name & Version (Handle object {name, version} or string)
    let ruleText = 'input_validation (v1)';
    if (res.rule) {
      if (typeof res.rule === 'object' && res.rule !== null) {
        ruleText = `${res.rule.name || 'input_validation'} (v${res.rule.version || 1})`;
      } else {
        ruleText = String(res.rule);
      }
    }
    document.getElementById('decision-rule').textContent = ruleText;

    // 2. Decision Outcome (ALLOWED in emerald vs DENIED in red/amber)
    const isAllowed = res.decision === 'allowed' || res.outcome === 'success' || res.outcome === 'SUCCESS' || res.allowed === true;
    const outcomeEl = document.getElementById('decision-outcome');
    if (isAllowed) {
      outcomeEl.textContent = 'ALLOWED';
      outcomeEl.style.color = '#10b981';
    } else {
      const code = res.reason?.code || (typeof res.reason === 'string' ? res.reason : res.outcome) || 'DENIED';
      outcomeEl.textContent = `DENIED (${code})`;
      outcomeEl.style.color = '#ef4444';
    }

    // 3. Key ID and Version (Handle nested {id, version} or top-level key_id)
    const keyId = res.key?.id ?? res.key_id;
    const keyVersion = res.key?.version ?? res.version;
    const keyText = keyId ? `${keyId} (v${keyVersion || 1})` : 'N/A';
    document.getElementById('decision-key').textContent = keyText;

    // 4. Duration
    document.getElementById('decision-duration').textContent = `${res.duration_ms || 0} ms`;

    // 5. Severity Badge
    const sev = document.getElementById('decision-severity');
    const s = res.severity || (isAllowed ? 'info' : 'warning');
    sev.className = `badge sev-${s}`;
    sev.textContent = s.toUpperCase();
  }

  // Audit Operations
  async loadAudit() {
    if (this.user?.role !== 'administrator') return;
    const tbody = document.querySelector('#table-audit tbody');
    tbody.innerHTML = '<tr><td colspan="9" style="text-align: center;">Loading audit chain...</td></tr>';

    const user = document.getElementById('audit-filter-user').value.trim();
    const action = document.getElementById('audit-filter-action').value.trim();
    const outcome = document.getElementById('audit-filter-outcome').value;
    const severity = document.getElementById('audit-filter-severity').value;

    let url = '/api/audit?limit=100';
    if (user) url += `&user=${encodeURIComponent(user)}`;
    if (action) url += `&action=${encodeURIComponent(action)}`;
    if (outcome) url += `&outcome=${encodeURIComponent(outcome)}`;
    if (severity) url += `&severity=${encodeURIComponent(severity)}`;

    try {
      const res = await this.api(url);
      const items = res.items || res.data?.items || [];
      if (!items.length) {
        tbody.innerHTML = '<tr><td colspan="9" style="text-align: center; color: var(--text-dim);">No audit events matching criteria.</td></tr>';
        return;
      }

      tbody.innerHTML = items.map(ev => `
        <tr>
          <td class="mono">${this.escape(ev.entry_no)}</td>
          <td class="mono" style="font-size: 0.75rem;">${this.escape(ev.time)}</td>
          <td><strong>${this.escape(ev.user)}</strong> <span style="font-size: 0.75rem; color: var(--text-dim);">(${this.escape(ev.role)})</span></td>
          <td><span class="mono">${this.escape(ev.action)}</span></td>
          <td class="truncate" title="${this.escape(ev.target)}">${this.escape(ev.target) || '-'}</td>
          <td><span class="badge outcome-${this.escape(ev.outcome)}">${this.escape(ev.outcome)}</span></td>
          <td><span class="badge sev-${this.escape(ev.severity)}">${this.escape(ev.severity)}</span></td>
          <td class="mono">${this.escape(ev.duration_ms)}ms</td>
          <td class="mono truncate" title="${this.escape(ev.hash)}">${this.escape(ev.hash ? ev.hash.substring(0, 10) + '...' : '-')}</td>
        </tr>
      `).join('');
    } catch (e) {
      tbody.innerHTML = `<tr><td colspan="9" style="color: #ef4444;">Error loading audit events: ${this.escape(e.message)}</td></tr>`;
    }
  }

  async verifyAuditChain() {
    const banner = document.getElementById('audit-tamper-banner');
    banner.style.display = 'none';

    try {
      let body = {};
      try {
        const saved = JSON.parse(localStorage.getItem('kc_audit_anchor') || 'null');
        if (saved && Number.isInteger(saved.entry_count) && /^[0-9a-f]{64}$/.test(saved.hash)) {
          body = { anchor_count: saved.entry_count, anchor_hash: saved.hash };
        }
      } catch (_) { /* storage unavailable: fall back to an unanchored check */ }
      const res = await this.api('/api/audit/verify', 'POST', body);
      const head = res.result?.verified_head || {};
      try {
        localStorage.setItem('kc_audit_anchor', JSON.stringify({ entry_count: head.entry_count, hash: head.hash }));
      } catch (_) { /* ignore */ }
      const badge = document.getElementById('dash-verify-badge');
      if (badge) {
        badge.className = 'badge state-active';
        badge.textContent = 'VERIFIED';
      }
      const sources = (res.result?.anchors_checked || []).map(a => a.source).join(', ') || 'none';
      alert(`Audit Chain Verified!\nTotal Entries: ${head.entry_count}\nChain Head: ${head.hash}\nChecked against: ${sources}`);
    } catch (err) {
      const badge = document.getElementById('dash-verify-badge');
      if (badge) {
        badge.className = 'badge state-revoked';
        badge.textContent = 'TAMPER DETECTED';
      }

      banner.style.display = 'flex';
      const detailText = err.data?.first_mismatch
        ? `First corrupted entry: #${err.data.first_mismatch} (Reason: ${err.data.reason || err.data.code})`
        : `Tampering detected: ${err.message}`;
      document.getElementById('audit-tamper-detail').textContent = detailText;
      alert(`AUDIT VERIFICATION FAILED!\n${detailText}`);
    }
  }

  // Backup & Recovery Operations
  async loadBackups() {
    if (this.user?.role !== 'administrator') return;
    const tbody = document.querySelector('#table-backups tbody');
    tbody.innerHTML = '<tr><td colspan="3" style="text-align: center;">Loading backups...</td></tr>';

    try {
      const res = await this.api('/api/backups');
      const backups = res.data?.items || res.data?.backups || res.items || res.backups || [];
      const sel = document.getElementById('drill-backup-select');
      sel.innerHTML = '';

      if (!backups.length) {
        tbody.innerHTML = '<tr><td colspan="3" style="text-align: center; color: var(--text-dim);">No backup files in server storage.</td></tr>';
        sel.innerHTML = '<option value="">No backups available</option>';
        return;
      }

      sel.innerHTML = '<option value="">Select a backup file...</option>';
      tbody.innerHTML = backups.map(b => {
        const sizeBytes = b.size ?? b.size_bytes ?? 0;
        const opt = document.createElement('option');
        opt.value = b.name;
        opt.textContent = `${this.escape(b.name)} (${sizeBytes} bytes)`;
        sel.appendChild(opt);

        return `
          <tr>
            <td class="mono"><strong>${this.escape(b.name)}</strong></td>
            <td class="mono">${this.escape(sizeBytes)}</td>
            <td>
              <div style="display: flex; gap: 0.5rem;">
                <button class="btn btn-secondary btn-sm" data-action="verify-backup" data-backup-name="${this.escape(b.name)}">Verify HMAC</button>
              </div>
            </td>
          </tr>
        `;
      }).join('');
    } catch (e) {
      tbody.innerHTML = `<tr><td colspan="3" style="color: #ef4444;">Error loading backups: ${this.escape(e.message)}</td></tr>`;
    }
  }

  async createBackup() {
    if (!confirm('Create a new authenticated database backup now?')) return;
    try {
      const conf = await this.api('/api/confirmations', 'POST', { action: 'backup' });
      const token = conf.data?.confirmation_token || conf.confirmation_token;
      const res = await this.api('/api/backups', 'POST', { confirmation_token: token });
      const name = res.data?.name || res.name || 'new-backup';
      alert(`Backup created successfully: ${name}`);
      await this.loadBackups();
    } catch (e) {
      alert(`Backup creation failed: ${e.message}`);
    }
  }

  async verifyBackup(name) {
    try {
      const res = await this.api(`/api/backups/${encodeURIComponent(name)}/verify`, 'POST');
      if (res.result?.valid) {
        alert(`Backup ${name} verified!\nHMAC: Valid\nAudit entries: ${res.result.chain_count}\nKey versions: ${res.result.key_versions_count}`);
      } else {
        alert(`Backup verification failed: ${res.result?.reason || 'Invalid backup'}`);
      }
    } catch (e) {
      alert(`Verification error: ${e.message}`);
    }
  }

  async executeRecoveryDrill(e) {
    e.preventDefault();
    const backupName = document.getElementById('drill-backup-select').value;
    if (!backupName) {
      alert('Please select a backup file from the list first.');
      return;
    }
    const passphrase = document.getElementById('drill-passphrase').value;
    const grid = document.getElementById('drill-results-grid');
    grid.style.display = 'none';

    try {
      const conf = await this.api('/api/confirmations', 'POST', { action: 'recovery_drill', backup_name: backupName });
      const token = conf.data?.confirmation_token || conf.confirmation_token;
      const res = await this.api('/api/recovery-drill', 'POST', {
        backup_name: backupName,
        confirmation_token: token,
        passphrase: passphrase,
      });

      const steps = res.data?.steps || [];
      grid.innerHTML = steps.map(s => `
        <div class="card" style="border-left: 3px solid ${s.passed ? 'var(--cyan-primary)' : '#ef4444'};">
          <div style="font-size: 0.75rem; color: var(--text-dim); text-transform: uppercase;">Step: ${this.escape(s.step)}</div>
          <div style="font-weight: 700; color: ${s.passed ? '#10b981' : '#ef4444'};">${s.passed ? 'PASSED' : 'FAILED'}</div>
          <div style="font-size: 0.8rem; color: var(--text-muted); margin-top: 0.25rem;">${this.escape(s.detail || '')}</div>
        </div>
      `).join('');
      grid.style.display = 'grid';
      alert('Recovery Drill Completed Successfully!');
    } catch (err) {
      alert(`Recovery drill failed: ${err.message}`);
    }
  }

  // Admin: Users & Settings
  async loadAdmin() {
    if (this.user?.role !== 'administrator') return;
    this.loadUsers();
    this.loadSettings();
  }

  async loadUsers() {
    const tbody = document.querySelector('#table-users tbody');
    tbody.innerHTML = '<tr><td colspan="5" style="text-align: center;">Loading users...</td></tr>';
    try {
      const users = await this.api('/api/users');
      tbody.innerHTML = users.map(u => `
        <tr>
          <td class="mono">${this.escape(u.id)}</td>
          <td><strong>${this.escape(u.username)}</strong></td>
          <td><span class="badge ${u.role === 'administrator' ? 'sev-warning' : 'sev-info'}">${this.escape(u.role)}</span></td>
          <td><span class="badge ${u.disabled ? 'state-revoked' : 'state-active'}">${u.disabled ? 'DISABLED' : 'ACTIVE'}</span></td>
          <td>
            <button class="btn btn-secondary btn-sm" data-action="toggle-user" data-user-id="${this.escape(u.id)}" data-disabled="${this.escape(u.disabled)}">
              ${u.disabled ? 'Enable' : 'Disable'}
            </button>
          </td>
        </tr>
      `).join('');
    } catch (e) {
      tbody.innerHTML = `<tr><td colspan="5" style="color: #ef4444;">Error: ${this.escape(e.message)}</td></tr>`;
    }
  }

  async toggleUserDisabled(userId, currentlyDisabled) {
    try {
      await this.api(`/api/users/${userId}`, 'PATCH', { disabled: !currentlyDisabled });
      this.loadUsers();
    } catch (e) {
      alert(`Failed to update user: ${e.message}`);
    }
  }

  async loadSettings() {
    const tbody = document.querySelector('#table-settings tbody');
    tbody.innerHTML = '<tr><td colspan="5" style="text-align: center;">Loading settings...</td></tr>';
    try {
      const settings = await this.api('/api/settings');
      tbody.innerHTML = settings.map(s => `
        <tr>
          <td>
            <strong>${this.escape(s.label || s.name)}</strong>
            <div class="mono hint">${this.escape(s.name)}</div>
          </td>
          <td class="mono" style="color: var(--cyan-primary); font-weight: 700;">${this.escape(s.value)}</td>
          <td class="mono hint">${this.escape(s.minimum)} – ${this.escape(s.maximum)}</td>
          <td class="mono">v${this.escape(s.version)}</td>
          <td>
            <button class="btn btn-secondary btn-sm" data-action="edit-setting" data-setting-name="${this.escape(s.name)}" data-setting-label="${this.escape(s.label || s.name)}" data-setting-value="${this.escape(s.value)}" data-setting-min="${this.escape(s.minimum)}" data-setting-max="${this.escape(s.maximum)}">
              Edit
            </button>
          </td>
        </tr>
      `).join('');
    } catch (e) {
      tbody.innerHTML = `<tr><td colspan="5" style="color: #ef4444;">Error: ${this.escape(e.message)}</td></tr>`;
    }
  }

  promptEditSetting(name, label, value, min, max) {
    document.getElementById('edit-setting-name').value = name;
    document.getElementById('edit-setting-label').textContent = `${label} (${name})`;
    const inp = document.getElementById('edit-setting-value');
    inp.value = value;
    inp.min = min;
    inp.max = max;
    document.getElementById('edit-setting-hint').textContent = `Permitted range: ${min} to ${max}`;
    this.openModal('modal-edit-setting');
  }

  async handleSettingEditSubmit(e) {
    e.preventDefault();
    const name = document.getElementById('edit-setting-name').value;
    const val = parseInt(document.getElementById('edit-setting-value').value);
    try {
      await this.api(`/api/settings/${encodeURIComponent(name)}`, 'PATCH', { value: val });
      this.closeModal('modal-edit-setting');
      this.loadSettings();
    } catch (err) {
      alert(`Setting update failed: ${err.message}`);
    }
  }

  // Modal Helpers
  openModal(id) {
    const m = document.getElementById(id);
    if (m) m.classList.add('active');
  }

  closeModal(id) {
    const m = document.getElementById(id);
    if (m) m.classList.remove('active');
  }

  escape(str) {
    if (str === null || str === undefined) return '';
    return String(str).replace(/[&<>"']/g, s => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[s]));
  }

  // Event Listeners Initialization
  initEventListeners() {
    // Global delegated click listener (CSP safe, avoids inline onclick)
    document.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      const action = btn.dataset.action;
      if (action === 'show-details') {
        this.showKeyDetails(parseInt(btn.dataset.keyId));
      } else if (action === 'rotate-key') {
        this.rotateKey(parseInt(btn.dataset.keyId));
      } else if (action === 'revoke-key') {
        this.promptRevoke(parseInt(btn.dataset.keyId), btn.dataset.keyName);
      } else if (action === 'close-modal') {
        this.closeModal(btn.dataset.modalId);
      } else if (action === 'show-view') {
        this.showView(btn.dataset.view);
      } else if (action === 'verify-backup') {
        this.verifyBackup(btn.dataset.backupName);
      } else if (action === 'toggle-user') {
        this.toggleUserDisabled(parseInt(btn.dataset.userId), btn.dataset.disabled === 'true' || btn.dataset.disabled === '1');
      } else if (action === 'edit-setting') {
        this.promptEditSetting(btn.dataset.settingName, btn.dataset.settingLabel, parseInt(btn.dataset.settingValue), parseInt(btn.dataset.settingMin), parseInt(btn.dataset.settingMax));
      }
    });

    // Navigation
    document.querySelectorAll('.nav-btn').forEach(btn => {
      btn.addEventListener('click', () => this.showView(btn.dataset.view));
    });

    document.getElementById('vault-pill').addEventListener('click', () => this.toggleVault());
    document.getElementById('btn-dash-vault').addEventListener('click', () => this.toggleVault());
    document.getElementById('btn-dash-verify').addEventListener('click', () => this.verifyAuditChain());
    document.getElementById('btn-verify-audit-full').addEventListener('click', () => this.verifyAuditChain());

    // Change own password
    document.getElementById('btn-password').addEventListener('click', () => {
      document.getElementById('form-password').reset();
      this.openModal('modal-password');
    });
    document.getElementById('form-password').addEventListener('submit', async (e) => {
      e.preventDefault();
      const current = document.getElementById('pw-current').value;
      const next = document.getElementById('pw-new').value;
      if (next !== document.getElementById('pw-confirm').value) {
        alert('The new password and its confirmation do not match.');
        return;
      }
      try {
        const res = await this.api('/api/auth/password', 'POST', { current_password: current, new_password: next });
        this.closeModal('modal-password');
        document.getElementById('form-password').reset();
        alert(`Password changed. Other sessions ended: ${res.other_sessions_ended}.`);
      } catch (err) {
        alert(`Password change failed: ${err.message}`);
      }
    });

    // Sign Out
    document.getElementById('btn-signout').addEventListener('click', async () => {
      await this.api('/api/auth/logout', 'POST').catch(() => null);
      this.handleSessionExpired();
    });

    // Login Form
    document.getElementById('form-login').addEventListener('submit', async (e) => {
      e.preventDefault();
      const errBox = document.getElementById('auth-error');
      errBox.style.display = 'none';

      try {
        const res = await this.api('/api/auth/login', 'POST', {
          username: document.getElementById('login-username').value.trim(),
          password: document.getElementById('login-password').value,
        });
        this.setUser(res);
        await this.checkVault();
        this.showView('dashboard');
      } catch (err) {
        errBox.textContent = 'Authentication failed. Please check your credentials.';
        errBox.style.display = 'block';
      }
    });

    // Setup Toggle & Form
    document.getElementById('toggle-setup').addEventListener('click', () => {
      const f = document.getElementById('form-setup');
      f.style.display = f.style.display === 'none' ? 'block' : 'none';
    });

    document.getElementById('form-setup').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        const u = document.getElementById('setup-username').value.trim();
        const p = document.getElementById('setup-password').value;
        const v = document.getElementById('setup-passphrase').value;

        await this.api('/api/setup', 'POST', {
          username: u,
          password: p,
          vault_passphrase: v,
        });

        // Auto-fill login credentials to prevent typos
        document.getElementById('login-username').value = u;
        document.getElementById('login-password').value = p;
        document.getElementById('form-setup').style.display = 'none';
        document.getElementById('toggle-setup').style.display = 'none';

        // Auto-sign in directly
        const res = await this.api('/api/auth/login', 'POST', {
          username: u,
          password: p,
        });
        this.setUser(res);
        await this.checkVault();
        this.showView('dashboard');
        alert('Setup complete! You are now signed in as Administrator.');
      } catch (err) {
        if (err.code === 'SETUP_CLOSED') {
          alert('Setup is already permanently closed because an Administrator account has already been initialized in the database. Please sign in with the existing credentials.');
          document.getElementById('form-setup').style.display = 'none';
        } else {
          alert(`Setup failed: ${err.message}`);
        }
      }
    });

    // Vault Unlock Form
    document.getElementById('form-unlock').addEventListener('submit', async (e) => {
      e.preventDefault();
      const pass = document.getElementById('unlock-passphrase').value;
      try {
        await this.api('/api/vault/unlock', 'POST', { passphrase: pass });
        this.closeModal('modal-unlock');
        await this.checkVault();
        alert('Vault unlocked successfully.');
      } catch (err) {
        alert(`Unlock failed: ${err.message}`);
      }
    });

    // Keys Modal & Creation
    document.getElementById('btn-create-key-modal').addEventListener('click', () => this.openModal('modal-create-key'));
    document.getElementById('form-create-key').addEventListener('submit', async (e) => {
      e.preventDefault();
      const payload = {
        name: document.getElementById('new-key-name').value.trim(),
        purpose: document.getElementById('new-key-purpose').value,
        rotation_days: parseInt(document.getElementById('new-key-rotation').value),
      };
      const exp = document.getElementById('new-key-expiry').value;
      if (exp) payload.expires_at = new Date(exp).toISOString().replace(/\.\d{3}/, '');

      try {
        await this.api('/api/keys', 'POST', payload);
        this.closeModal('modal-create-key');
        this.loadKeys();
      } catch (err) {
        alert(`Failed to create key: ${err.message}`);
      }
    });

    document.getElementById('btn-refresh-keys').addEventListener('click', () => this.loadKeys());
    document.getElementById('keys-filter-state').addEventListener('change', () => this.loadKeys());
    document.getElementById('keys-filter-purpose').addEventListener('change', () => this.loadKeys());

    // Revocation Submit
    document.getElementById('form-revoke').addEventListener('submit', (e) => this.handleRevokeSubmit(e));

    // Plaintext Size Counter
    document.getElementById('encrypt-plaintext').addEventListener('input', (e) => {
      const bytes = new TextEncoder().encode(e.target.value).length;
      const counter = document.getElementById('encrypt-size-counter');
      counter.textContent = `${bytes} / 65536 bytes`;
      counter.style.color = bytes > 65536 ? '#ef4444' : 'var(--text-dim)';
    });

    document.getElementById('form-encrypt').addEventListener('submit', (e) => this.handleEncrypt(e));
    document.getElementById('form-decrypt').addEventListener('submit', (e) => this.handleDecrypt(e));

    // Audit Filters & Refresh
    document.getElementById('btn-refresh-audit').addEventListener('click', () => this.loadAudit());
    ['audit-filter-user', 'audit-filter-action', 'audit-filter-outcome', 'audit-filter-severity'].forEach(id => {
      document.getElementById(id).addEventListener('change', () => this.loadAudit());
    });

    // Backup & Drill
    document.getElementById('btn-create-backup').addEventListener('click', () => this.createBackup());
    document.getElementById('form-drill').addEventListener('submit', (e) => this.executeRecoveryDrill(e));

    // Admin: Users & Settings
    document.getElementById('btn-add-user-modal').addEventListener('click', () => this.openModal('modal-add-user'));
    document.getElementById('form-add-user').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await this.api('/api/users', 'POST', {
          username: document.getElementById('add-username').value.trim(),
          password: document.getElementById('add-password').value,
          role: document.getElementById('add-role').value,
        });
        this.closeModal('modal-add-user');
        this.loadUsers();
      } catch (err) {
        alert(`Failed to create user: ${err.message}`);
      }
    });

    document.getElementById('form-edit-setting').addEventListener('submit', (e) => this.handleSettingEditSubmit(e));
  }
}

// Global App Instance
const app = new KeyCycleApp();
window.app = app;
