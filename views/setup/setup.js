// First-run wizard: point the engine at a database, then create the admin.
//
// Both steps are re-entrant. /setup/status says which one you're on, so a
// refresh (or a browser closed halfway) resumes rather than starting over.

const FIELD_ERRORS = [
  'setup__uri__err',
  'setup__username__err',
  'setup__email__err',
  'setup__password__err',
  'setup__confirm__err'
];

export function init() {
  const steps = {
    database: document.querySelector('[data-step="database"]'),
    admin: document.querySelector('[data-step="admin"]')
  };

  const backdrop = document.getElementById('setupModalBackdrop');
  const modalMessage = document.getElementById('setupModalMessage');
  const closeModal = document.getElementById('setupModalClose');

  const showModal = (message) => {
    modalMessage.textContent = message;
    backdrop.hidden = false;
  };

  closeModal.addEventListener('click', () => { backdrop.hidden = true; });
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) backdrop.hidden = true;
  });

  const clearErrors = () => {
    for (const id of FIELD_ERRORS) {
      const el = document.getElementById(id);
      if (el) { el.textContent = ''; el.hidden = true; }
    }
  };

  const setNote = (id, message, isError) => {
    const note = document.getElementById(id);
    if (!note) return;
    note.textContent = message || '';
    note.hidden = !message;
    note.classList.toggle('auth-form__note--error', Boolean(isError));
  };

  const showStep = (name) => {
    for (const [key, form] of Object.entries(steps)) {
      form.classList.toggle('is-active', key === name);
    }

    document.querySelectorAll('[data-step-indicator]').forEach(node => {
      const step = node.dataset.stepIndicator;
      node.classList.toggle('is-active', step === name);
      node.classList.toggle('is-complete', step === 'database' && name === 'admin');
    });

    const firstInput = steps[name].querySelector('input');
    if (firstInput) firstInput.focus();
  };

  // --- Step 1: database ---
  const databaseForm = document.getElementById('databaseForm');
  const databaseSubmit = document.getElementById('databaseSubmit');
  const uriInput = document.getElementById('setup__uri');

  databaseForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearErrors();
    setNote('databaseNote', 'Testing the connection…');
    databaseSubmit.disabled = true;

    try {
      const res = await fetch('/setup/database', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uri: uriInput.value.trim() })
      });
      const data = await res.json();

      if (!data.ok) {
        const err = document.getElementById('setup__uri__err');
        err.textContent = data.message;
        err.hidden = false;
        uriInput.setAttribute('aria-invalid', 'true');
        setNote('databaseNote', '');
        return;
      }

      uriInput.removeAttribute('aria-invalid');
      setNote('databaseNote', data.message);

      // An existing database may already have accounts, which ends the wizard.
      if (data.hasUsers) {
        window.location.href = '/login';
        return;
      }
      showStep('admin');
    } catch (err) {
      showModal('Could not reach the server. Is it still running?');
      setNote('databaseNote', '');
    } finally {
      databaseSubmit.disabled = false;
    }
  });

  // --- Step 2: admin account ---
  const adminForm = document.getElementById('adminForm');
  const adminSubmit = document.getElementById('adminSubmit');

  adminForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearErrors();

    const payload = {
      username: document.getElementById('setup__username').value,
      email: document.getElementById('setup__email').value,
      password: document.getElementById('setup__password').value,
      confirmPassword: document.getElementById('setup__confirm').value
    };

    if (payload.password !== payload.confirmPassword) {
      const err = document.getElementById('setup__confirm__err');
      err.textContent = 'Passwords do not match.';
      err.hidden = false;
      return;
    }

    setNote('adminNote', 'Creating the account…');
    adminSubmit.disabled = true;

    try {
      const res = await fetch('/setup/admin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await res.json();

      if (!data.ok) {
        setNote('adminNote', data.message, true);
        adminSubmit.disabled = false;
        return;
      }

      setNote('adminNote', `${data.message} Taking you to the login…`);
      window.location.href = data.redirect || '/login';
    } catch (err) {
      showModal('Could not reach the server. Is it still running?');
      setNote('adminNote', '');
      adminSubmit.disabled = false;
    }
  });

  // --- Resume wherever setup got to ---
  (async () => {
    try {
      const res = await fetch('/setup/status');
      const status = await res.json();

      if (status.complete) {
        window.location.href = '/login';
        return;
      }

      uriInput.value = status.suggestedUri || '';

      if (status.dbConnected) {
        setNote('databaseNote', `Already connected to '${status.dbName}'.`);
        showStep('admin');
      } else {
        showStep('database');
      }
    } catch (err) {
      showStep('database');
    }
  })();
}
