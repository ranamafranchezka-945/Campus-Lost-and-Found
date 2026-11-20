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

  const renderAuthenticatedNavigation = user => {
    const userPill = document.createElement('div');
    userPill.className = 'user-pill';

    const userName = document.createElement('span');
    userName.className = 'user-name';
    userName.textContent = user.role === 'admin' ? 'Admin' : user.fullName;
    userPill.append(userName);

    if (user.role === 'student' || user.role === 'employee') {
      const roleBadge = document.createElement('span');
      roleBadge.className = 'role-badge';
      roleBadge.textContent = user.role === 'employee' ? 'Employee' : 'Student';
      userPill.append(roleBadge);
    }

    const logoutButton = document.createElement('button');
    logoutButton.type = 'button';
    logoutButton.className = 'user-pill-logout';
    logoutButton.title = 'Sign out of account';
    logoutButton.textContent = 'Logout';
    logoutButton.addEventListener('click', logout);
    userPill.append(logoutButton);
    userNavSlot.replaceChildren(userPill);
  };

  async function logout() {
    try {
      const response = await fetch('/api/auth/logout', {
        method: 'POST',
        credentials: 'same-origin'
      });
      if (!response.ok) throw new Error(`Logout request failed (${response.status}).`);
      renderGuestNavigation();
    } catch (error) {
      console.error('Unable to sign out from the About page:', error);
      showStatusMessage('Unable to sign out. Please try again.', true);
    }
  }

  // Render the cached session immediately, before the /api/auth/me round-trip, so a
  // returning student's nav is already in place on first paint instead of flashing from
  // the static "Sign In" markup to the authenticated one a moment later - the same cache
  // js/home-page.js keeps in sync on index.html.
  let cachedUser = null;
  try {
    const stored = JSON.parse(sessionStorage.getItem('currentUser') || 'null');
    if (stored && ['admin', 'student', 'employee'].includes(stored.role)
      && sessionStorage.getItem('userRole') === stored.role) {
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
        credentials: 'same-origin'
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
