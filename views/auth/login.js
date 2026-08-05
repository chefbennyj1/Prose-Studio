// Login page: sign in, or file an account request for an admin to approve.
//
// The request form used to carry its own inline <script> inside login.html.
// It lives here now, so both forms share one modal and one error convention.

export function init() {
  const loginForm = document.getElementById('loginForm');
  const requestForm = document.getElementById('requestForm');
  const heading = document.getElementById('authHeading');
  const altText = document.querySelector('[data-alt-text]');
  const signUpButton = document.querySelector('.sign--up');
  const signInButton = document.querySelector('.sign--in');

  // --- Error dialog ---
  const errorModal = document.getElementById('errorModal');
  const modalMessage = document.getElementById('modalMessage');
  const closeModalBtn = document.querySelector('.close-modal-btn');

  const showErrorModal = (message) => {
    modalMessage.textContent = message;
    errorModal.hidden = false;
  };

  closeModalBtn.addEventListener('click', () => { errorModal.hidden = true; });
  errorModal.addEventListener('click', (e) => {
    if (e.target === errorModal) errorModal.hidden = true;
  });

  // --- Form switching ---
  const showForm = (which) => {
    const signingIn = which === 'login';

    loginForm.classList.toggle('is-active', signingIn);
    requestForm.classList.toggle('is-active', !signingIn);

    heading.textContent = signingIn ? 'Welcome back' : 'Request access';
    altText.textContent = signingIn ? 'New here?' : 'Already have access?';
    signUpButton.hidden = !signingIn;
    signInButton.hidden = signingIn;

    const firstInput = (signingIn ? loginForm : requestForm).querySelector('input');
    if (firstInput) firstInput.focus();
  };

  signUpButton.addEventListener('click', () => showForm('request'));
  signInButton.addEventListener('click', () => showForm('login'));

  // --- Sign in ---
  const loginSubmit = document.getElementById('loginSubmit');

  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();

    const data = Object.fromEntries(new FormData(loginForm).entries());

    // Session-expiry redirects arrive as /login?returnTo=<working page>;
    // send it along so a successful login lands back there
    const returnTo = new URLSearchParams(window.location.search).get('returnTo');
    if (returnTo) data.returnTo = returnTo;

    loginSubmit.disabled = true;

    try {
      const response = await fetch(loginForm.action, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify(data)
      });

      const result = await response.json();

      if (response.ok && result.redirect) {
        window.location.href = result.redirect;
        return;
      }

      showErrorModal(result.message || 'Login failed.');
    } catch (err) {
      console.error('Fetch error:', err);
      showErrorModal('An unexpected error occurred.');
    } finally {
      loginSubmit.disabled = false;
    }
  });

  // --- Request access ---
  const requestSubmit = document.getElementById('requestSubmit');
  const requestNote = document.getElementById('requestNote');
  const requestErrorIds = ['req__username__err', 'req__email__err', 'req__password__err', 'req__confirm__err'];

  requestForm.addEventListener('submit', async (e) => {
    e.preventDefault();

    for (const id of requestErrorIds) {
      const el = document.getElementById(id);
      el.textContent = '';
      el.hidden = true;
    }

    const payload = {
      username: document.getElementById('req__username').value,
      email: document.getElementById('req__email').value,
      password: document.getElementById('req__password').value,
      confirmPassword: document.getElementById('req__confirm').value
    };

    if (payload.password !== payload.confirmPassword) {
      const el = document.getElementById('req__confirm__err');
      el.textContent = 'Passwords do not match.';
      el.hidden = false;
      return;
    }

    requestSubmit.disabled = true;

    try {
      const res = await fetch('/accounts/request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await res.json();

      if (data.ok) {
        requestForm.querySelectorAll('.auth-field, .auth-form__actions, .auth-form__lede')
          .forEach(node => { node.hidden = true; });
        requestNote.textContent = data.message;
        requestNote.hidden = false;
        return;
      }

      showErrorModal(data.message);
    } catch (err) {
      showErrorModal('Network error. Please try again.');
    } finally {
      requestSubmit.disabled = false;
    }
  });
}
