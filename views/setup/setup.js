// First-run wizard: create the writer's account, then make them keep the
// recovery code.
//
// It used to open on "paste a MongoDB connection string", which is a question
// about somebody else's job, and it is gone along with the database server. The
// second step is new and is the more important one: the account's password
// encrypts the data folder, so the recovery code is the only way back in if it
// is forgotten. That is worth an extra screen, a download and a checkbox.

const FIELD_ERRORS = [
  'setup__username__err',
  'setup__email__err',
  'setup__password__err',
  'setup__confirm__err'
];

export function init() {
  const steps = {
    admin: document.querySelector('[data-step="admin"]'),
    recovery: document.querySelector('[data-step="recovery"]')
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
    for (const [key, node] of Object.entries(steps)) {
      node.classList.toggle('is-active', key === name);
    }

    document.querySelectorAll('[data-step-indicator]').forEach(node => {
      const step = node.dataset.stepIndicator;
      node.classList.toggle('is-active', step === name);
      node.classList.toggle('is-complete', step === 'admin' && name === 'recovery');
    });

    const firstInput = steps[name].querySelector('input');
    if (firstInput) firstInput.focus();
  };

  // --- Step 1: the account ---
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

    setNote('adminNote', 'Creating your account…');
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

      setNote('adminNote', '');
      showRecoveryCode(data.recoveryCode);
    } catch (err) {
      showModal('Could not reach the server. Is it still running?');
      setNote('adminNote', '');
      adminSubmit.disabled = false;
    }
  });

  // --- Step 2: the recovery code ---
  const codeNode = document.getElementById('recoveryCode');
  const downloadButton = document.getElementById('recoveryDownload');
  const copyButton = document.getElementById('recoveryCopy');
  const confirmBox = document.getElementById('recoveryConfirm');
  const continueButton = document.getElementById('recoveryContinue');

  let recoveryCode = '';

  function showRecoveryCode(code) {
    // A missing code would mean the account was made but the wizard cannot show
    // the one thing this step exists for. Say so rather than showing a blank
    // box the writer would tick past.
    if (!code) {
      showModal('Your account was created, but the recovery code could not be displayed. ' +
                'Sign in and generate a new one from Settings before you rely on it.');
      window.location.href = '/login';
      return;
    }

    recoveryCode = code;
    codeNode.textContent = code;
    showStep('recovery');
    codeNode.focus();
  }

  /**
   * Written client-side rather than served, so the code never travels back over
   * the wire to be downloaded — it is already on this page and nowhere else.
   */
  downloadButton.addEventListener('click', () => {
    const when = new Date().toISOString().slice(0, 10);
    const contents = [
      'PROSE ENGINE — RECOVERY CODE',
      '',
      recoveryCode,
      '',
      `Created ${when}`,
      '',
      'What this is:',
      '  The only way back into your Prose Engine settings if you forget your',
      '  password. Keep it somewhere that is not this computer — a password',
      '  manager, a printout, a note in a drawer.',
      '',
      'What it is NOT:',
      '  It is not needed to open your writing. Your chapters are ordinary',
      '  files in the story folder you chose, and nothing locks them.',
      '',
      'To use it: open Prose Engine, and on the sign-in page choose to reset',
      'your password with this code.',
      ''
    ].join('\r\n'); // CRLF so it opens tidily in Notepad

    const blob = new Blob([contents], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');

    link.href = url;
    link.download = `prose-engine-recovery-code-${when}.txt`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);

    setNote('recoveryNote', 'Saved to your downloads folder.');
    confirmBox.checked = true;
    continueButton.disabled = false;
  });

  copyButton.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(recoveryCode);
      setNote('recoveryNote', 'Copied. Paste it somewhere safe before you continue.');
    } catch {
      // Clipboard access can be refused; the code is on screen either way.
      setNote('recoveryNote', 'Could not copy automatically — select the code above and copy it.', true);
    }
  });

  confirmBox.addEventListener('change', () => {
    continueButton.disabled = !confirmBox.checked;
  });

  continueButton.addEventListener('click', () => {
    window.location.href = '/login';
  });

  // --- Resume wherever setup got to ---
  //
  // Only the account step is resumable. Once it succeeds the recovery code
  // exists and has been shown; a refresh at that point cannot bring it back,
  // which is why the wizard never reloads its way into step 2.
  (async () => {
    try {
      const res = await fetch('/setup/status');
      const status = await res.json();

      if (status.complete) {
        window.location.href = '/login';
        return;
      }

      if (!status.storeReady) {
        showModal(`Prose Engine cannot write to its data folder (${status.storeDirectory}). ` +
                  'Setup will not be able to save your account until that folder is writable.');
      }

      showStep('admin');
    } catch (err) {
      showStep('admin');
    }
  })();
}
