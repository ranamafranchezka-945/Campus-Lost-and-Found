// togglePasswordVisibility() moved to js/main.js, which this page also loads, so it can
// be shared with the change-password modal on index.html.

    // Theme toggle
    function toggleTheme() {
      const current = document.documentElement.getAttribute('data-theme') || 'dark';
      switchTheme(current === 'light' ? 'dark' : 'light'); // js/main.js: smooth cross-fade
    }

    function updateThemeIcon() {
      const theme = document.documentElement.getAttribute('data-theme') || 'dark';
      document.querySelectorAll('.theme-toggle').forEach(btn => {
        btn.innerHTML = themeToggleIconHtml(theme);
        btn.setAttribute('title', theme === 'light' ? 'Switch to Dark Mode' : 'Switch to Light Mode');
        btn.setAttribute('aria-label', theme === 'light' ? 'Switch to Dark Mode' : 'Switch to Light Mode');
      });
    }

    function loadTheme() {
      document.documentElement.setAttribute('data-theme', resolveTheme()); // js/main.js: device setting or manual choice
      updateThemeIcon();
    }

    function getPostLoginUrl(user) {
      const requestedPath = new URLSearchParams(window.location.search).get('redirect');
      if (requestedPath) {
        const destination = new URL(requestedPath, window.location.origin);
        if (
          destination.origin === window.location.origin &&
          destination.pathname.startsWith('/') &&
          !(user.role !== 'admin' && destination.pathname === '/admin.html')
        ) {
          return `${destination.pathname}${destination.search}${destination.hash}`;
        }
      }
      return user.role === 'admin' ? '/admin.html' : '/';
    }

    async function redirectAuthenticatedUser() {
      document.body.classList.add('auth-checking');
      try {
        const response = await fetch('/api/auth/me', { cache: 'no-store', credentials: 'same-origin' });
        if (response.ok) {
          const data = await response.json();
          if (data.authenticated && data.user && ['admin', 'student', 'employee'].includes(data.user.role)) {
            window.location.replace(getPostLoginUrl(data.user));
            return;
          }
        }
      } catch (error) {
        // Leave the sign-in form available while session verification is unavailable.
      }
      document.body.classList.remove('auth-checking');
    }

    // Theme initialization and click handling are provided by the shared main.js.

    const AUTH_DEFAULT_TITLE = 'Welcome to Back2You';
    const AUTH_TITLES = {
      registerForm: 'Create an Account',
      createPasswordForm: 'Create Your Password'
      // Every other form keeps AUTH_DEFAULT_TITLE.
    };
    const AUTH_SUBTITLES = {
      loginForm: 'Sign in to your account',
      registerForm: 'Join the Back2You - CSPC Lost and Found Community',
      forgotForm: 'Reset your password',
      resetForm: 'Choose a new password',
      createPasswordForm: 'One more step to finish setting up your account'
      // otpForm has its own header (otp-title) instead of this one.
    };

    function showAuthForm(formId) {
      ['loginForm', 'registerForm', 'forgotForm', 'resetForm', 'otpForm', 'createPasswordForm'].forEach(id => {
        const form = document.getElementById(id);
        const isActive = id === formId;
        form.style.display = isActive ? 'block' : 'none';
        if (isActive) restartAnimation(form, 'auth-form-enter');
      });
      document.getElementById('authTitle').textContent = AUTH_TITLES[formId] || AUTH_DEFAULT_TITLE;
      const subtitle = document.getElementById('authSubtitle');
      if (AUTH_SUBTITLES[formId]) subtitle.textContent = AUTH_SUBTITLES[formId];
      hideError();
    }

    function switchTab(tab) {
      showAuthForm(tab === 'login' ? 'loginForm' : 'registerForm');
    }

    // Student vs employee self-registration: same form, different required email domain
    // (@my.cspc.edu.ph vs @cspc.edu.ph) and submitted account type.
    function setAccountType(type) {
      const isEmployee = type === 'employee';
      document.getElementById('regAccountType').value = isEmployee ? 'employee' : 'student';
      document.getElementById('tabAccountStudent').classList.toggle('active', !isEmployee);
      document.getElementById('tabAccountEmployee').classList.toggle('active', isEmployee);

      const email = document.getElementById('regEmail');
      email.placeholder = isEmployee ? 'e.g., juan.delacruz@cspc.edu.ph' : 'e.g., student@my.cspc.edu.ph';
      email.pattern = isEmployee ? '[A-Za-z0-9._%+\\-]+@cspc\\.edu\\.ph' : '[A-Za-z0-9._%+\\-]+@my\\.cspc\\.edu\\.ph';
      email.title = isEmployee
        ? 'Use your CSPC employee email address ending in @cspc.edu.ph'
        : 'Use your CSPC email address ending in @my.cspc.edu.ph';
      email.value = '';

      document.getElementById('registerSubmit').textContent = isEmployee ? 'Continue as Employee' : 'Continue as Student';
    }

    function showForgotPassword() {
      showAuthForm('forgotForm');
      document.getElementById('forgotEmail').value = document.getElementById('loginEmail').value.trim();
      document.getElementById('forgotEmail').focus();
    }

    async function handleForgotPassword(e) {
      e.preventDefault();
      hideError();
      const button = document.getElementById('forgotSubmit');
      button.disabled = true;
      try {
        const res = await fetch('/api/auth/forgot-password', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ email: document.getElementById('forgotEmail').value.trim() })
        });
        const data = await res.json();
        if (data.success) showNotice(data.message);
        else showError(data.message || 'Could not send the reset link.');
      } catch (err) {
        showError('Network error connecting to authentication service.');
      } finally {
        button.disabled = false;
      }
    }

    // The reset token is read once from the emailed link and kept out of the address bar.
    let passwordResetToken = null;

    function openResetFromLink() {
      const params = new URLSearchParams(window.location.search);
      const token = params.get('reset');
      if (!token) return false;
      passwordResetToken = token;
      params.delete('reset');
      const query = params.toString();
      window.history.replaceState(null, '', `${window.location.pathname}${query ? `?${query}` : ''}`);
      showAuthForm('resetForm');
      return true;
    }

    async function handleResetPassword(e) {
      e.preventDefault();
      hideError();
      const password = document.getElementById('resetPassword').value;
      if (password !== document.getElementById('resetPasswordConfirm').value) {
        showError('The two passwords do not match.');
        return;
      }
      const button = document.getElementById('resetSubmit');
      button.disabled = true;
      try {
        const res = await fetch('/api/auth/reset-password', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ token: passwordResetToken, password })
        });
        const data = await res.json();
        if (data.success) {
          passwordResetToken = null;
          document.getElementById('resetForm').reset();
          showAuthForm('loginForm');
          showNotice(data.message);
        } else if (data.code === 'RESET_LINK_INVALID') {
          showAuthForm('forgotForm');
          showError(data.message);
        } else {
          showError(data.message || 'Could not reset the password.');
        }
      } catch (err) {
        showError('Network error connecting to authentication service.');
      } finally {
        button.disabled = false;
      }
    }

    function showError(msg) {
      const box = document.getElementById('authError');
      box.innerText = msg;
      box.style.display = 'block';
    }

    function hideError() {
      document.getElementById('authError').style.display = 'none';
      document.getElementById('authNotice').style.display = 'none';
    }

    function showNotice(msg) {
      const box = document.getElementById('authNotice');
      box.innerText = msg;
      box.style.display = 'block';
    }

    // Result of opening the confirmation link from the verification email.
    function showVerificationResult() {
      const params = new URLSearchParams(window.location.search);
      const result = params.get('verified');
      if (!result) return;
      if (result === 'success') showNotice('Your email is confirmed. You can now sign in.');
      else if (result === 'expired') showError('That confirmation link has expired. Sign in with your email and password to get a verification code instead.');
      else showError('That confirmation link is invalid or was already used. Sign in to get a verification code if needed.');
      params.delete('verified');
      const query = params.toString();
      window.history.replaceState(null, '', `${window.location.pathname}${query ? `?${query}` : ''}`);
    }

    // Shared by registration and the reset-password form: live-checks a password
    // against the same rules middleware/validate.js's passwordStrengthErrors() enforces
    // server-side, and disables the submit button until they're all met - so a weak
    // password is caught here instead of only after a rejected request.
    function updatePasswordRequirementsIn(passwordInputId, listId, submitButtonId) {
      const password = document.getElementById(passwordInputId).value;
      const requirements = {
        length: password.length >= 8,
        uppercase: /[A-Z]/.test(password),
        lowercase: /[a-z]/.test(password),
        number: /[0-9]/.test(password),
        special: /[!@#$%?&*]/.test(password)
      };

      const list = document.getElementById(listId);
      Object.entries(requirements).forEach(([name, satisfied]) => {
        const item = list.querySelector(`[data-requirement="${name}"]`);
        item.classList.toggle('satisfied', satisfied);
        item.setAttribute('aria-label', `${satisfied ? 'Met' : 'Required'}: ${item.textContent}`);
      });

      const allMet = Object.values(requirements).every(Boolean);
      // Hidden until there's something to correct: empty (nothing typed yet) or already
      // fully valid both mean there's no unmet requirement to show.
      list.hidden = !password || allMet;
      document.getElementById(submitButtonId).disabled = !allMet;
    }

    function updateResetPasswordRequirements() {
      updatePasswordRequirementsIn('resetPassword', 'resetPasswordRequirements', 'resetSubmit');
    }

    // Sign-in and sign-up wait for the code email to be sent, which takes a few
    // seconds. The button shows that it is working and ignores repeat clicks, so a
    // second request cannot send a second code that replaces the first.
    let authRequestBusy = false;

    async function runWhileBusy(buttonId, busyLabel, request) {
      if (authRequestBusy) return;
      authRequestBusy = true;
      const button = document.getElementById(buttonId);
      const label = button.textContent;
      button.disabled = true;
      button.classList.add('is-busy');
      button.textContent = busyLabel;
      try {
        await request();
      } finally {
        authRequestBusy = false;
        button.classList.remove('is-busy');
        button.textContent = label;
        button.disabled = false;
      }
    }

    function handleLogin(e) {
      e.preventDefault();
      return runWhileBusy('loginSubmit', 'Signing in…', submitLogin);
    }

    async function submitLogin() {
      hideError();

      const email = document.getElementById('loginEmail').value.trim();
      const password = document.getElementById('loginPassword').value;

      try {
        const res = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ email, password })
        });

        const data = await res.json();
        // A correct password always leads to the emailed code (a sign-up code if the
        // email is not confirmed yet).
        if (data.otpRequired) {
          showOtpStep(data, 'loginForm');
          document.getElementById('loginPassword').value = '';
        } else if (data.success && data.user) {
          finishSignIn(data.user);
        } else {
          showError(data.message || 'Login failed. Please check your credentials.');
        }
      } catch (err) {
        showError('Network error connecting to authentication service.');
      }
    }

    function finishSignIn(user) {
      sessionStorage.setItem('currentUser', JSON.stringify(user));
      sessionStorage.setItem('userRole', user.role);
      window.location.replace(getPostLoginUrl(user));
    }

    // ── Email code step ─────────────────────────────────────────────────────
    let otpReturnForm = 'loginForm';
    let otpCountdownTimer = null;
    let otpVerifying = false;

    function otpBoxes() {
      return [...document.querySelectorAll('#otpBoxes .otp-box')];
    }

    function restartAnimation(element, className) {
      element.classList.remove(className);
      void element.offsetWidth; // reflow so the animation plays again
      element.classList.add(className);
    }

    function showOtpStep(data, returnForm) {
      otpReturnForm = returnForm;
      const form = document.getElementById('otpForm');
      const isSignup = data.purpose === 'signup';
      document.getElementById('otpTitle').textContent = isSignup ? 'Email Verification' : 'OTP Verification';
      document.getElementById('otpEmail').textContent = data.email || 'your CSPC email';
      document.querySelector('#otpForm .otp-back').setAttribute('aria-label', returnForm === 'registerForm' ? 'Back to registration' : 'Back to sign in');
      form.classList.remove('is-success');
      clearOtpBoxes();
      showAuthForm('otpForm');
      restartAnimation(form, 'is-entering');
      if (data.emailSent === false) showError(data.message);
      else if (isSignup && returnForm === 'loginForm') showNotice(data.message);
      startResendCountdown(data.resendAfter || 60);
      otpBoxes()[0].focus();
    }

    function leaveOtpStep() {
      clearInterval(otpCountdownTimer);
      showAuthForm(otpReturnForm);
    }

    function clearOtpBoxes() {
      otpBoxes().forEach(box => {
        box.value = '';
        box.classList.remove('is-filled', 'is-pop');
      });
      document.getElementById('otpBoxes').classList.remove('is-error');
    }

    function setOtpBox(box, digit) {
      box.value = digit;
      box.classList.toggle('is-filled', Boolean(digit));
      if (digit) restartAnimation(box, 'is-pop');
    }

    // Puts digits into the boxes from `index` on (typing, paste or phone autofill),
    // then submits once all six are in.
    function fillOtpFrom(index, digits) {
      const boxes = otpBoxes();
      for (const digit of digits) {
        if (index >= boxes.length) break;
        setOtpBox(boxes[index], digit);
        index += 1;
      }
      boxes[Math.min(index, boxes.length - 1)].focus();
      if (boxes.every(box => box.value)) {
        setTimeout(() => document.getElementById('otpForm').requestSubmit(), 180);
      }
    }

    function setupOtpBoxes() {
      const boxes = otpBoxes();
      boxes.forEach((box, index) => {
        box.addEventListener('input', () => {
          const digits = box.value.replace(/\D/g, '');
          document.getElementById('otpBoxes').classList.remove('is-error');
          if (!digits) {
            setOtpBox(box, '');
            return;
          }
          fillOtpFrom(index, digits);
        });
        box.addEventListener('keydown', event => {
          if (event.key === 'Backspace' && !box.value && index > 0) {
            event.preventDefault();
            setOtpBox(boxes[index - 1], '');
            boxes[index - 1].focus();
          } else if (event.key === 'ArrowLeft' && index > 0) {
            event.preventDefault();
            boxes[index - 1].focus();
          } else if (event.key === 'ArrowRight' && index < boxes.length - 1) {
            event.preventDefault();
            boxes[index + 1].focus();
          }
        });
        box.addEventListener('paste', event => {
          const digits = (event.clipboardData?.getData('text') || '').replace(/\D/g, '');
          if (!digits) return;
          event.preventDefault();
          fillOtpFrom(digits.length >= boxes.length ? 0 : index, digits);
        });
        box.addEventListener('focus', () => box.select());
      });
    }

    function showOtpError(message) {
      const row = document.getElementById('otpBoxes');
      restartAnimation(row, 'is-error');
      showError(message);
      setTimeout(() => {
        clearOtpBoxes();
        otpBoxes()[0].focus();
      }, 650);
    }

    async function handleVerifyCode(e) {
      e.preventDefault();
      if (otpVerifying) return;
      const code = otpBoxes().map(box => box.value).join('');
      if (!/^\d{6}$/.test(code)) {
        showOtpError('Enter all 6 digits of the code.');
        return;
      }
      hideError();
      otpVerifying = true;
      const button = document.getElementById('otpSubmit');
      button.classList.add('is-busy');
      button.textContent = 'Verifying…';
      try {
        const res = await fetch('/api/auth/verify-code', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ code })
        });
        const data = await res.json();
        if (data.success && data.passwordRequired) {
          clearInterval(otpCountdownTimer);
          document.activeElement?.blur();
          document.getElementById('otpForm').classList.add('is-success');
          button.textContent = 'Verified';
          setTimeout(() => showCreatePasswordStep(data), 1100);
          return;
        }
        if (data.success && data.user) {
          clearInterval(otpCountdownTimer);
          document.activeElement?.blur();
          document.getElementById('otpForm').classList.add('is-success');
          button.textContent = 'Verified';
          showNotice(data.message);
          setTimeout(() => finishSignIn(data.user), 1100);
          return;
        }
        showOtpError(data.message || 'That code did not work. Please try again.');
      } catch (err) {
        showOtpError('Network error while checking the code.');
      }
      otpVerifying = false;
      button.classList.remove('is-busy');
      button.textContent = 'Verify';
    }

    function startResendCountdown(seconds) {
      const button = document.getElementById('otpResend');
      clearInterval(otpCountdownTimer);
      let remaining = Math.max(0, Math.ceil(seconds));
      const render = () => {
        button.disabled = remaining > 0;
        button.textContent = remaining > 0
          ? `Resend in ${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, '0')}`
          : 'Resend code';
      };
      render();
      otpCountdownTimer = setInterval(() => {
        remaining -= 1;
        render();
        if (remaining <= 0) clearInterval(otpCountdownTimer);
      }, 1000);
    }

    async function resendCode() {
      hideError();
      const button = document.getElementById('otpResend');
      button.disabled = true;
      try {
        const res = await fetch('/api/auth/resend-code', { method: 'POST', credentials: 'same-origin' });
        const data = await res.json();
        if (data.success) {
          clearOtpBoxes();
          restartAnimation(document.querySelector('#otpForm .otp-mail'), 'is-resent');
          if (data.emailSent === false) showError(data.message);
          else showNotice(data.message);
          startResendCountdown(data.resendAfter || 60);
          otpBoxes()[0].focus();
        } else {
          showError(data.message || 'Could not send a new code.');
          startResendCountdown(data.retryAfter || 0);
        }
      } catch (err) {
        showError('Network error while sending a new code.');
        button.disabled = false;
      }
    }

    async function handleRegister(e) {
      e.preventDefault();
      if (authRequestBusy) return;
      hideError();
      await runWhileBusy('registerSubmit', 'Sending code…', submitRegistration);
    }

    async function submitRegistration() {
      const fullName = document.getElementById('regFullName').value.trim();
      const email = document.getElementById('regEmail').value.trim();
      const accountType = document.getElementById('regAccountType').value;

      try {
        const res = await fetch('/api/auth/register', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ fullName, email, accountType })
        });

        const data = await res.json();
        if (data.success) {
          // The email is confirmed with the code next, then the password is created.
          document.getElementById('registerForm').reset();
          setAccountType('student');
          document.getElementById('loginEmail').value = email;
          showOtpStep(data, 'registerForm');
        } else {
          showError(data.message || (data.errors ? data.errors.join(' ') : 'Registration failed.'));
        }
      } catch (err) {
        showError('Network error connecting to registration service.');
      }
    }

    // ── Create-password step (final step of sign-up, after the OTP above) ──────────
    function showCreatePasswordStep(data) {
      clearInterval(otpCountdownTimer);
      document.getElementById('createPasswordForm').reset();
      updateCreatePasswordRequirements();
      showAuthForm('createPasswordForm');
      if (data.message) showNotice(data.message);
      document.getElementById('createPassword').focus();
    }

    function updateCreatePasswordRequirements() {
      updatePasswordRequirementsIn('createPassword', 'createPasswordRequirements', 'createPasswordSubmit');
    }

    async function handleCompleteRegistration(e) {
      e.preventDefault();
      if (authRequestBusy) return;
      hideError();
      updateCreatePasswordRequirements();

      if (document.getElementById('createPasswordSubmit').disabled) {
        showError('Please meet all password requirements before continuing.');
        return;
      }
      if (document.getElementById('createPassword').value !== document.getElementById('createPasswordConfirm').value) {
        showError('The two passwords do not match.');
        return;
      }

      await runWhileBusy('createPasswordSubmit', 'Creating account…', submitCompleteRegistration);
      updateCreatePasswordRequirements();
    }

    async function submitCompleteRegistration() {
      const password = document.getElementById('createPassword').value;
      try {
        const res = await fetch('/api/auth/complete-registration', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ password })
        });
        const data = await res.json();
        if (data.success && data.user) {
          finishSignIn(data.user);
        } else if (data.code === 'PENDING_MISSING') {
          showAuthForm('registerForm');
          showError(data.message);
        } else {
          showError(data.message || (data.errors ? data.errors.join(' ') : 'Could not create your account.'));
        }
      } catch (err) {
        showError('Network error connecting to registration service.');
      }
    }

    // One real Google button per visible spot: Sign In (sign-in copy) and Register
    // Account (sign-up copy). Both call the same /api/auth/google, which signs in an
    // existing account or creates one on first use - "sign in" vs "sign up" here is
    // only which label/container is shown, not different behaviour.
    const GOOGLE_BUTTONS = [
      { containerId: 'googleSignInContainer', overlayId: 'googleSignInButton', text: 'signin_with' },
      { containerId: 'googleSignUpContainer', overlayId: 'googleSignUpButton', text: 'signup_with' }
    ];

    // Shows the Google buttons only when the server has GOOGLE_CLIENT_ID configured -
    // a deployment without it never shows a button that can't work.
    async function setupGoogleSignIn() {
      let clientId;
      try {
        const res = await fetch('/api/auth/google-client-id', { credentials: 'same-origin' });
        ({ clientId } = await res.json());
      } catch (error) {
        return;
      }
      if (!clientId) return;

      await new Promise(resolve => {
        const script = document.createElement('script');
        script.src = 'https://accounts.google.com/gsi/client';
        script.addEventListener('load', resolve, { once: true });
        script.addEventListener('error', resolve, { once: true });
        document.head.appendChild(script);
      });
      if (!window.google?.accounts?.id) return;

      google.accounts.id.initialize({ client_id: clientId, callback: handleGoogleCredential });
      renderGoogleButtons();
      GOOGLE_BUTTONS.forEach(({ containerId }) => { document.getElementById(containerId).hidden = false; });

      // Each button has a fixed pixel width (GIS does not reflow on its own), so it's
      // recomputed from its own custom button's width instead of a guessed constant -
      // otherwise it either clips on a narrow phone or leaves an odd gap on a wider card.
      let resizeTimer;
      window.addEventListener('resize', () => {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(renderGoogleButtons, 200);
      });
    }

    // Renders each real Google button invisibly, sized to match its own visible custom
    // button (css/login.css stretches its inner iframe to fill the overlay regardless,
    // as a safety net against any rounding mismatch).
    function renderGoogleButtons() {
      GOOGLE_BUTTONS.forEach(({ overlayId, text }) => {
        const overlay = document.getElementById(overlayId);
        const width = Math.min(400, overlay?.closest('.google-custom-btn')?.clientWidth || 320);
        google.accounts.id.renderButton(overlay, {
          theme: 'outline',
          size: 'large',
          shape: 'rectangular',
          width,
          text
        });
      });
    }

    async function handleGoogleCredential(response) {
      hideError();
      try {
        const res = await fetch('/api/auth/google', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ credential: response.credential })
        });
        const data = await res.json();
        if (data.success) {
          window.location.replace(getPostLoginUrl(data.user));
        } else {
          showError(data.message || 'Google sign-in failed.');
        }
      } catch (error) {
        showError('Network error during Google sign-in.');
      }
    }

    document.getElementById('resetPassword').addEventListener('input', updateResetPasswordRequirements);
    updateResetPasswordRequirements();
    document.getElementById('createPassword').addEventListener('input', updateCreatePasswordRequirements);
    updateCreatePasswordRequirements();
    setupGoogleSignIn();
    setupOtpBoxes();
    showVerificationResult();
    if (openResetFromLink()) document.body.classList.remove('auth-checking');
    else redirectAuthenticatedUser();
    window.addEventListener('pageshow', event => {
      if (event.persisted && !passwordResetToken) redirectAuthenticatedUser();
    });
