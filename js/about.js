// Account menu actions (js/ui.js dispatches data-action="..." to these by name, so they
// must be on window, not nested inside the DOMContentLoaded closure below). The bell and
// "Settings" open modals that only exist on index.html's markup, so from here they deep
// link there with a query param index.html's own DOMContentLoaded handler opens on
// arrival - the same pattern "Register Belonging" already uses.
window.goToNotifications = () => {
  window.location.href = '/?action=view-notifications';
};

window.goToChangePassword = () => {
  window.location.href = '/?action=change-password';
};

window.goToKeyboardShortcuts = () => {
  window.location.href = '/index.html?action=keyboard-shortcuts';
};

window.toggleUserProfileMenu = () => {
  const button = document.getElementById('userProfileBtn');
  const menu = document.getElementById('userProfileMenu');
  if (!button || !menu) return;
  const isOpen = button.getAttribute('aria-expanded') === 'true';
  button.setAttribute('aria-expanded', String(!isOpen));
  menu.hidden = isOpen;
};

window.closeUserProfileMenu = () => {
  const button = document.getElementById('userProfileBtn');
  const menu = document.getElementById('userProfileMenu');
  if (!button || !menu) return;
  button.setAttribute('aria-expanded', 'false');
  menu.hidden = true;
};

document.addEventListener('click', (event) => {
  const accountMenu = document.querySelector('.user-account-wrap');
  if (accountMenu && !accountMenu.contains(event.target)) window.closeUserProfileMenu();
});

document.addEventListener('keydown', (event) => {
  const button = document.getElementById('userProfileBtn');
  if (event.key !== 'Escape' || !button || button.getAttribute('aria-expanded') !== 'true') return;
  window.closeUserProfileMenu();
  button.focus();
});

document.addEventListener('keydown', (event) => {
  if (event.key !== '?' || event.defaultPrevented || event.repeat || event.altKey || event.ctrlKey || event.metaKey)
    return;
  const target = event.target instanceof Element ? event.target : null;
  if (target && target.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]')) return;
  event.preventDefault();
  window.goToKeyboardShortcuts();
});

document.addEventListener('DOMContentLoaded', () => {
  const userNavSlot = document.getElementById('userNavSlot');
  if (!userNavSlot) {
    console.error('The About page account navigation is unavailable.');
    return;
  }

  const renderGuestNavigation = () => {
    const signInLink = document.createElement('a');
    signInLink.href = '/login';
    signInLink.className = 'btn btn-primary nav-signin-btn about-navbar-signin';
    signInLink.textContent = 'Sign In';
    userNavSlot.replaceChildren(signInLink);
  };

  // Same markup/classes as js/home-page.js's renderAuthenticatedHeader (index.html), so
  // the header looks identical on both pages - the bell/Settings actions are the only
  // difference (see the window.goTo* functions above).
  const renderAuthenticatedNavigation = (user) => {
    const isAdmin = user.role === 'admin';
    const roleLabel = isAdmin ? 'Administrator' : user.role === 'employee' ? 'Employee' : 'Student';
    const displayName = isAdmin ? 'Admin' : user.fullName || 'Account';
    const initials = displayName
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((part) => part[0])
      .join('')
      .toUpperCase();

    userNavSlot.innerHTML = `
      <button type="button" id="notifBellBtn" class="notif-bell-btn" data-action="goToNotifications" title="View your notifications">
        <svg class="notif-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
          <path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9" />
          <path d="M10 21h4" />
        </svg>
      </button>
      <div class="user-account-wrap">
        <button type="button" class="user-account-trigger" id="userProfileBtn" data-action="toggleUserProfileMenu" aria-haspopup="menu" aria-expanded="false" aria-controls="userProfileMenu">
          <span class="user-account-avatar" aria-hidden="true"></span>
          <span class="user-account-name"></span>
          <svg class="user-account-chevron" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>
        </button>
        <div class="user-account-menu" id="userProfileMenu" role="menu" aria-label="Account" hidden>
          <div class="user-account-menu-head">
            <strong></strong>
            <small></small>
          </div>
          <button type="button" class="user-account-menu-item" role="menuitem" data-action="goToKeyboardShortcuts">
            Keyboard shortcuts
          </button>
          <button type="button" class="user-account-menu-item" role="menuitem" data-action="goToChangePassword">
            <svg class="ico" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 21v-7m0-4V3m8 18v-9m0-4V3m8 18v-5m0-4V3"/><path d="M2 14h4m4-6h4m4 8h4"/></svg>
            Settings
          </button>
          <button type="button" class="user-account-menu-item user-account-menu-item--danger" role="menuitem" data-action="handleLogout">
            <svg class="ico" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M10 17l5-5-5-5m5 5H3"/><path d="M12 3h6a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-6"/></svg>
            Sign out
          </button>
        </div>
      </div>
    `;
    // Set through textContent/attributes, not string interpolation, so the user's own
    // name/email can never be read back as markup.
    userNavSlot.querySelector('.user-account-wrap').dataset.role = roleLabel;
    userNavSlot.querySelector('.user-account-avatar').textContent = initials;
    userNavSlot.querySelector('.user-account-name').textContent = displayName;
    userNavSlot.querySelector('.user-account-trigger').setAttribute('aria-label', `Account menu for ${displayName}`);
    userNavSlot.querySelector('.user-account-menu-head strong').textContent = displayName;
    userNavSlot.querySelector('.user-account-menu-head small').textContent = user.email || '';
  };

  window.handleLogout = async function handleLogout() {
    try {
      const response = await fetch('/api/auth/logout', {
        method: 'POST',
        credentials: 'same-origin',
      });
      if (!response.ok) throw new Error(`Logout request failed (${response.status}).`);
      renderGuestNavigation();
    } catch (error) {
      console.error('Unable to sign out from the About page:', error);
      showStatusMessage('Unable to sign out. Please try again.', true);
    }
  };

  // Render the cached session immediately, before the /api/auth/me round-trip, so a
  // returning student's nav is already in place on first paint instead of flashing from
  // the static "Sign In" markup to the authenticated one a moment later - the same cache
  // js/home-page.js keeps in sync on index.html.
  let cachedUser = null;
  try {
    const stored = JSON.parse(sessionStorage.getItem('currentUser') || 'null');
    if (
      stored &&
      ['admin', 'student', 'employee'].includes(stored.role) &&
      sessionStorage.getItem('userRole') === stored.role
    ) {
      cachedUser = stored;
      renderAuthenticatedNavigation(cachedUser);
    }
  } catch (storageError) {
    // Ignore unreadable cached state; the live check below still runs.
  }

  async function loadAccountNavigation() {
    try {
      const response = await fetch('/api/auth/me', {
        cache: 'no-store',
        credentials: 'same-origin',
      });
      if (!response.ok) throw new Error(`Session check failed (${response.status}).`);
      const data = await response.json();

      if (data.authenticated && data.user && ['admin', 'student', 'employee'].includes(data.user.role)) {
        const matchesCache = cachedUser && cachedUser.email === data.user.email && cachedUser.role === data.user.role;
        if (!matchesCache) renderAuthenticatedNavigation(data.user);
      } else {
        renderGuestNavigation();
      }
    } catch (error) {
      console.error('Unable to verify the About page account session:', error);
    }
  }

  loadAccountNavigation();
});
