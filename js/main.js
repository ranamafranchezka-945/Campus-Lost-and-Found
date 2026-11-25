const THEME_STORAGE_KEY = 'cspc_theme';

// Fallback for browsers without the Cross-Document View Transitions API (the
// `@view-transition` rule in css/styles.css animates Chrome/Edge natively): this file
// runs synchronously in <head>, before <body> is parsed, so adding the class here - not
// in a DOMContentLoaded handler - lets the entrance animation cover the very first paint
// instead of a flash of the fully-visible page first.
const supportsNativePageTransition = 'onpageswap' in window;
if (!supportsNativePageTransition) {
  document.documentElement.classList.add('page-entering');
}

// Shared by every password field that sits in a .password-wrap (login, registration,
// password reset, and the change-password modal): toggles type="password"/"text" and
// swaps the eye icon. Lives here, not in js/login.js, because both login.html and
// index.html load this file.
function togglePasswordVisibility(inputId, btn) {
  const input = document.getElementById(inputId);
  if (!input) return;
  const showPassword = input.type === 'password';
  input.type = showPassword ? 'text' : 'password';
  btn.setAttribute('aria-pressed', String(showPassword));
  btn.setAttribute('aria-label', showPassword ? 'Hide password' : 'Show password');
  btn.setAttribute('title', showPassword ? 'Hide password' : 'Show password');
  btn.innerHTML = showPassword
    ? '<svg class="password-toggle-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m3 3 18 18M10.6 10.6a2 2 0 0 0 2.8 2.8" /><path d="M9.9 5.2A10.8 10.8 0 0 1 12 5c6.4 0 10 7 10 7a15.8 15.8 0 0 1-3.1 3.8M6.2 6.2C3.5 8.1 2 12 2 12s3.6 7 10 7a10.8 10.8 0 0 0 4.1-.8" /></svg>'
    : '<svg class="password-toggle-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7Z" /><circle cx="12" cy="12" r="3" /></svg>';
}

// Intro screen shared by the landing and portal pages: shown once per browser session.
// This file loads in <head>, so a repeat visit hides it before anything is drawn.
const SPLASH_SEEN_KEY = 'back2you.splashSeen';
(function setupSplash() {
  let seen = false;
  try {
    seen = sessionStorage.getItem(SPLASH_SEEN_KEY) === '1';
  } catch {
    /* storage blocked: show it */
  }
  if (seen) {
    document.documentElement.classList.add('skip-splash');
    return;
  }
  document.addEventListener('DOMContentLoaded', () => {
    const splash = document.getElementById('appSplash');
    if (!splash) return;
    try {
      sessionStorage.setItem(SPLASH_SEEN_KEY, '1');
    } catch {
      /* ignore */
    }

    if (
      splash.querySelector('[data-cspc-logo-scene]') &&
      !window.THREE &&
      !document.querySelector('script[src^="/js/cspc-3d-logo.js"]')
    ) {
      const threeScript = document.createElement('script');
      threeScript.src = '/vendor/three.min.js';
      threeScript.addEventListener(
        'load',
        () => {
          const logoScript = document.createElement('script');
          logoScript.src = '/js/cspc-3d-logo.js';
          logoScript.addEventListener(
            'error',
            () => {
              console.error('The intro logo animation script could not be loaded.');
            },
            { once: true }
          );
          document.head.appendChild(logoScript);
        },
        { once: true }
      );
      threeScript.addEventListener(
        'error',
        () => {
          console.error('Three.js could not be loaded for the intro logo animation.');
        },
        { once: true }
      );
      document.head.appendChild(threeScript);
    }

    const leave = () => splash.classList.add('is-leaving');
    splash.addEventListener('click', leave);
    document.addEventListener('keydown', leave, { once: true });
    // Remove it once its own fade-out ends (letters fire animationend too).
    splash.addEventListener('animationend', (event) => {
      if (event.target === splash && event.animationName === 'splash-out') splash.remove();
    });
  });
})();

let dashboardBackPrompted = false;
let dashboardBackGuardInstalled = false;

// Brief on-page message; uses the page's own toast when it has one.
function showStatusMessage(message, isError = false) {
  if (typeof window.showToast === 'function') {
    window.showToast(message, isError);
    return;
  }
  document.querySelector('.toast')?.remove();
  const toast = document.createElement('div');
  toast.className = `toast${isError ? ' toast-error' : ''}`;
  toast.setAttribute('role', isError ? 'alert' : 'status');
  toast.textContent = message;
  document.body.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('show'));
  setTimeout(() => toast.remove(), 3200);
}

function installDashboardBackGuard() {
  if (dashboardBackGuardInstalled) return;
  dashboardBackGuardInstalled = true;

  const restoreDashboardEntry = () => window.history.pushState({ dashboardBackGuard: true }, '', window.location.href);
  restoreDashboardEntry();
  restoreDashboardEntry();
  window.addEventListener('popstate', () => {
    const logoutModal = document.getElementById('adminLogoutModal') || document.getElementById('logoutConfirmModal');
    if (logoutModal?.classList.contains('open')) {
      restoreDashboardEntry();
      return;
    }

    if (!dashboardBackPrompted) {
      dashboardBackPrompted = true;
      showStatusMessage('Press back again to exit or sign out.');
      restoreDashboardEntry();
      return;
    }

    dashboardBackPrompted = false;
    restoreDashboardEntry();
    if (!logoutModal) {
      console.error('The sign-out confirmation modal is unavailable.');
      return;
    }
    logoutModal.classList.add('open');
  });
}

// The theme follows the device's light / dark setting. The toggle button is a manual
// override: it is remembered together with the device setting at that moment and
// dropped as soon as the device setting changes (or when it matches the device).
const THEME_DEVICE_KEY = 'cspc_theme_device';
const deviceDarkQuery = window.matchMedia('(prefers-color-scheme: dark)');

function deviceTheme() {
  return deviceDarkQuery.matches ? 'dark' : 'light';
}

function clearThemeOverride() {
  localStorage.removeItem(THEME_STORAGE_KEY);
  localStorage.removeItem(THEME_DEVICE_KEY);
}

// The theme to show now: a still-valid manual choice, otherwise the device's.
function resolveTheme() {
  const device = deviceTheme();
  let saved = null;
  let savedDevice = null;
  try {
    saved = localStorage.getItem(THEME_STORAGE_KEY);
    savedDevice = localStorage.getItem(THEME_DEVICE_KEY);
    if ((saved === 'light' || saved === 'dark') && saved !== device && savedDevice === device) return saved;
    clearThemeOverride();
  } catch {
    /* storage blocked: just follow the device */
  }
  return device;
}

function loadTheme() {
  document.documentElement.setAttribute('data-theme', resolveTheme());
  updateThemeIcon();
}

// The device switched between light and dark: follow it, with the same cross-fade.
deviceDarkQuery.addEventListener('change', () => {
  try {
    clearThemeOverride();
  } catch {
    /* ignore */
  }
  applyTheme(deviceTheme());
});

function toggleTheme() {
  const currentTheme = document.documentElement.getAttribute('data-theme') || 'dark';
  switchTheme(currentTheme === 'light' ? 'dark' : 'light');
}

// Changes the theme with a smooth cross-fade of the whole page (css/styles.css sets
// the timing). Browsers without view transitions fade the colours with CSS instead;
// with "reduce motion" on, the theme simply switches.
function switchTheme(nextTheme) {
  try {
    if (nextTheme === deviceTheme()) {
      clearThemeOverride(); // same as the device: back to automatic
    } else {
      localStorage.setItem(THEME_STORAGE_KEY, nextTheme);
      localStorage.setItem(THEME_DEVICE_KEY, deviceTheme());
    }
  } catch {
    /* storage blocked: the choice lasts for this page only */
  }
  applyTheme(nextTheme);
}

function applyTheme(nextTheme) {
  const root = document.documentElement;
  if (root.getAttribute('data-theme') === nextTheme) return;
  const apply = () => {
    root.setAttribute('data-theme', nextTheme);
    updateThemeIcon();
  };

  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    apply();
  } else if (typeof document.startViewTransition === 'function') {
    document.startViewTransition(apply);
  } else {
    root.classList.add('theme-switching');
    apply();
    clearTimeout(switchTheme.timer);
    switchTheme.timer = setTimeout(() => root.classList.remove('theme-switching'), 450);
  }
}

// Sun is shown in light mode, moon in dark mode. Same markup and styling as the other .ui-icon SVGs.
const THEME_TOGGLE_ICON_PATHS = {
  light:
    '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M4.93 4.93l1.42 1.42m11.3 11.3 1.42 1.42M2 12h2m16 0h2M4.93 19.07l1.42-1.42m11.3-11.3 1.42-1.42"/>',
  dark: '<path d="M20.5 14A8.5 8.5 0 0 1 10 3.5 8.5 8.5 0 1 0 20.5 14z"/>',
};

function themeToggleIconHtml(theme) {
  const paths = THEME_TOGGLE_ICON_PATHS[theme === 'light' ? 'light' : 'dark'];
  return `<span class="theme-toggle-icon"><span class="ui-icon" aria-hidden="true"><svg viewBox="0 0 24 24" focusable="false">${paths}</svg></span></span>`;
}

function updateThemeIcon() {
  const theme = document.documentElement.getAttribute('data-theme') || 'dark';
  document.querySelectorAll('.theme-toggle').forEach((button) => {
    button.innerHTML = themeToggleIconHtml(theme);
    button.setAttribute('title', theme === 'light' ? 'Switch to Dark Mode' : 'Switch to Light Mode');
    button.setAttribute('aria-label', theme === 'light' ? 'Switch to Dark Mode' : 'Switch to Light Mode');
  });
}

function initNav() {
  updateThemeIcon();
  document.querySelectorAll('.theme-toggle').forEach((button) => {
    if (button.dataset.themeBound === 'true') return;
    button.dataset.themeBound = 'true';
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      toggleTheme();
    });
  });
  document.querySelectorAll('.navbar').forEach(initializeMobileDrawer);
}

function initializeMobileDrawer(navbar) {
  const links = navbar.querySelector('.nav-links');
  if (!links) return;

  const container = navbar.querySelector('.navbar-container');
  const logo = container && container.querySelector('.nav-logo');
  const menuButton = navbar.querySelector('.menu-toggle');
  if (container && logo && menuButton && menuButton.parentElement !== container) {
    container.insertBefore(menuButton, logo);
  }

  let closeButton = links.querySelector('.mobile-drawer-close');
  if (!closeButton) {
    closeButton = document.createElement('button');
    closeButton.type = 'button';
    closeButton.className = 'mobile-drawer-close';
    closeButton.setAttribute('aria-label', 'Close navigation menu');
    closeButton.innerHTML =
      '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M15 3v18"/></svg>';
  }

  let drawerHeader = links.querySelector('.mobile-drawer-header');
  if (!drawerHeader) {
    drawerHeader = document.createElement('div');
    drawerHeader.className = 'mobile-drawer-header';
  }
  let brand = drawerHeader.querySelector('.mobile-drawer-brand');
  if (!brand && logo) {
    brand = document.createElement('div');
    brand.className = 'mobile-drawer-brand';
    const logoImage = logo.querySelector('img');
    const logoTitle = logo.querySelector('.nav-logo-full, .nav-logo-short');
    if (logoImage) brand.append(logoImage.cloneNode(true));
    brand.append(document.createTextNode(logoTitle ? logoTitle.textContent.trim() : 'Back2You'));
    drawerHeader.prepend(brand);
  } else if (brand && brand.tagName === 'A') {
    const staticBrand = document.createElement('div');
    staticBrand.className = 'mobile-drawer-brand';
    staticBrand.append(...brand.childNodes);
    brand.replaceWith(staticBrand);
  }
  drawerHeader.append(closeButton);
  links.prepend(drawerHeader);

  let profile = links.querySelector('.mobile-drawer-profile');
  if (!profile) {
    profile = document.createElement('div');
    profile.className = 'mobile-drawer-profile';
    profile.hidden = true;
  }
  drawerHeader.after(profile);

  let footer = links.querySelector('.mobile-drawer-footer');
  if (!footer) {
    footer = document.createElement('div');
    footer.className = 'mobile-drawer-footer';
    links.append(footer);
  }

  links.querySelectorAll('a, .nav-register-mobile').forEach((link) => {
    const label = link.textContent.trim().toLowerCase();
    link.dataset.mobileIcon = label.includes('report')
      ? 'report'
      : label.includes('register')
        ? 'register'
        : label.includes('item') || label.includes('browse')
          ? 'items'
          : label.includes('about')
            ? 'about'
            : label.includes('dashboard')
              ? 'dashboard'
              : '';
  });

  let backdrop = navbar.querySelector('.nav-drawer-backdrop');
  if (!backdrop) {
    backdrop = document.createElement('button');
    backdrop.type = 'button';
    backdrop.className = 'nav-drawer-backdrop';
    backdrop.setAttribute('aria-label', 'Close navigation menu');
    backdrop.hidden = true;
    navbar.append(backdrop);
  }

  if (menuButton) {
    menuButton.setAttribute('aria-controls', links.id || 'navLinks');
    menuButton.setAttribute('aria-expanded', String(links.classList.contains('open')));
  }

  syncMobileHeaderControls(navbar);
  syncMobileDrawerAccount(navbar);
  if (navbar.dataset.mobileDrawerReady !== 'true') {
    navbar.dataset.mobileDrawerReady = 'true';
    const accountSlot = navbar.querySelector('#userNavSlot');
    if (accountSlot) {
      new MutationObserver(() => {
        syncMobileHeaderControls(navbar);
        syncMobileDrawerAccount(navbar);
      }).observe(accountSlot, { childList: true, subtree: true });
    }
  }
}

function syncMobileHeaderControls(navbar) {
  const actions = navbar.querySelector('.nav-actions');
  if (!actions) return;

  const account = navbar.querySelector('.user-pill, .user-account-wrap');
  const authenticated = Boolean(account);
  const hasFinderNotifications = Boolean(navbar.querySelector('#finderNotificationsBtn'));
  navbar.classList.toggle('mobile-authenticated', authenticated);
  navbar.classList.toggle('mobile-finder-notifications', !authenticated && hasFinderNotifications);

  let signInButton = actions.querySelector('.mobile-header-signin');
  if (!authenticated && !navbar.classList.contains('admin-navbar')) {
    const source = navbar.querySelector('.nav-signin-btn');
    if (!signInButton) {
      signInButton = source ? source.cloneNode(true) : document.createElement('a');
      signInButton.className = 'mobile-header-signin';
      signInButton.removeAttribute('id');
      if (!source) {
        signInButton.href = '/login';
        signInButton.textContent = 'Sign In';
      }
      actions.append(signInButton);
    }
  } else {
    signInButton?.remove();
  }

  const notifications = [...navbar.querySelectorAll('.notif-bell-btn')];
  const directNotification = actions.querySelector('.notif-bell-btn:not(.mobile-header-notification)');
  const notification = directNotification || notifications[0];
  let mobileNotification = actions.querySelector('.mobile-header-notification');

  if ((authenticated || hasFinderNotifications) && notification && !navbar.classList.contains('admin-navbar')) {
    notification.classList.add('mobile-header-notification-source');
    if (mobileNotification) mobileNotification.remove();
    notifications.forEach((candidate) => {
      if (candidate !== notification) candidate.remove();
    });
  } else if (authenticated && notification && navbar.classList.contains('admin-navbar')) {
    if (!mobileNotification) {
      mobileNotification = notification.cloneNode(true);
      mobileNotification.classList.add('mobile-header-notification');
      mobileNotification.removeAttribute('id');
      mobileNotification.querySelectorAll('[id]').forEach((element) => element.removeAttribute('id'));
      actions.append(mobileNotification);
    }
  } else {
    mobileNotification?.remove();
  }
}

function syncMobileDrawerAccount(navbar) {
  const links = navbar.querySelector('.nav-links');
  const profile = links && links.querySelector('.mobile-drawer-profile');
  const footer = links && links.querySelector('.mobile-drawer-footer');
  if (!profile || !footer) return;

  const account = navbar.querySelector('.user-pill, .user-account-wrap');
  const name = account && account.querySelector('.user-name, .user-account-name')?.textContent.trim();
  const role =
    account?.querySelector('.role-badge')?.textContent.trim() ||
    account?.dataset.role ||
    (navbar.classList.contains('admin-navbar') ? 'Administrator' : '');

  profile.replaceChildren();
  profile.hidden = !name;
  if (name) {
    const avatar = document.createElement('span');
    avatar.className = 'mobile-drawer-avatar';
    avatar.setAttribute('aria-hidden', 'true');
    avatar.textContent = name
      .split(/\s+/)
      .slice(0, 2)
      .map((part) => part[0])
      .join('')
      .toUpperCase();

    const details = document.createElement('span');
    details.className = 'mobile-drawer-account-details';
    const userName = document.createElement('strong');
    userName.textContent = name;
    details.append(userName);
    if (role) {
      const userRole = document.createElement('span');
      userRole.className = 'mobile-drawer-role-badge';
      userRole.textContent = role;
      details.append(userRole);
    }
    profile.append(avatar, details);
  }

  footer.replaceChildren();
  const logout = account?.querySelector('.user-pill-logout, .user-account-menu-item[data-action="handleLogout"]');
  if (logout) {
    // Signed-in users still shouldn't see the "Sign In" link below, even
    // though the drawer footer no longer gets its own Logout button.
    return;
  }

  const signIn = navbar.querySelector('.mobile-header-signin, .nav-signin-btn');
  if (signIn) {
    const drawerSignIn = signIn.cloneNode(true);
    drawerSignIn.className = 'mobile-drawer-signin';
    footer.append(drawerSignIn);
  }
}

function syncButtonSelect(select) {
  const control = select && select.nextElementSibling;
  if (!control || !control.classList.contains('button-select')) return;

  const trigger = control.querySelector('.button-select-trigger');
  const menu = control.querySelector('.button-select-menu');
  const selectedOption = select.options[select.selectedIndex];
  trigger.textContent = selectedOption ? selectedOption.textContent.trim() : 'Select an option...';
  trigger.classList.toggle('has-value', Boolean(select.value));
  menu.querySelectorAll('[role="option"]').forEach((button) => {
    const selected = button.dataset.value === select.value;
    button.setAttribute('aria-selected', String(selected));
    button.classList.toggle('selected', selected);
  });

  const selectedButton = [...menu.querySelectorAll('[role="option"]')].find(
    (button) => button.dataset.value === select.value
  );
  if (selectedButton) selectedButton.scrollIntoView({ block: 'nearest' });
}

function closeButtonSelect(control, returnFocus = false) {
  if (!control) return;
  control.classList.remove('open');
  control.querySelector('.button-select-trigger').setAttribute('aria-expanded', 'false');
  if (returnFocus) control.querySelector('.button-select-trigger').focus();
}

function renderButtonSelectOptions(select, menu) {
  menu.replaceChildren();
  const addOption = (option) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'button-select-option';
    button.setAttribute('role', 'option');
    button.dataset.value = option.value;
    button.textContent = option.textContent.trim();
    button.disabled = option.disabled;
    button.setAttribute('aria-selected', String(option.value === select.value));
    button.classList.toggle('selected', option.value === select.value);
    button.addEventListener('click', () => {
      select.value = option.value;
      select.dispatchEvent(new Event('input', { bubbles: true }));
      select.dispatchEvent(new Event('change', { bubbles: true }));
      syncButtonSelect(select);
      closeButtonSelect(menu.closest('.button-select'), true);
    });
    menu.append(button);
  };

  [...select.children].forEach((child) => {
    if (child.tagName === 'OPTGROUP') {
      const group = document.createElement('div');
      group.className = 'button-select-group-label';
      group.textContent = child.label;
      menu.append(group);
      [...child.children].forEach(addOption);
    } else if (child.tagName === 'OPTION') {
      addOption(child);
    }
  });
}

function enhanceSelect(select) {
  if (select.dataset.buttonSelectReady === 'true' || !select.parentNode) return;

  select.dataset.buttonSelectReady = 'true';
  const wasRequired = select.required;
  select.required = false;
  select.classList.add('button-select-native');
  select.setAttribute('aria-hidden', 'true');
  select.tabIndex = -1;

  const control = document.createElement('div');
  control.className = 'button-select';
  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'button-select-trigger';
  trigger.setAttribute('role', 'combobox');
  trigger.setAttribute('aria-haspopup', 'listbox');
  trigger.setAttribute('aria-expanded', 'false');
  trigger.setAttribute('aria-required', String(wasRequired));
  trigger.setAttribute('aria-label', select.labels?.[0]?.textContent.trim() || 'Select an option');
  trigger.setAttribute('aria-controls', `${select.id || `button-select-${Date.now()}`}-options`);
  trigger.dataset.required = String(wasRequired);
  const menu = document.createElement('div');
  menu.id = trigger.getAttribute('aria-controls');
  menu.className = 'button-select-menu';
  menu.setAttribute('role', 'listbox');
  menu.setAttribute('aria-label', select.labels?.[0]?.textContent.trim() || 'Options');
  trigger.addEventListener('click', () => {
    syncButtonSelect(select);
    const opening = !control.classList.contains('open');
    document.querySelectorAll('.button-select.open').forEach((openSelect) => closeButtonSelect(openSelect));
    control.classList.toggle('open', opening);
    trigger.setAttribute('aria-expanded', String(opening));
  });
  trigger.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!control.classList.contains('open')) trigger.click();
      const options = [...menu.querySelectorAll('[role="option"]:not(:disabled)')];
      const selectedIndex = options.findIndex((option) => option.getAttribute('aria-selected') === 'true');
      options[Math.max(0, selectedIndex)].focus();
    } else if (event.key === 'Escape' && control.classList.contains('open')) {
      event.preventDefault();
      closeButtonSelect(control);
    }
  });
  menu.addEventListener('keydown', (event) => {
    const options = [...menu.querySelectorAll('[role="option"]:not(:disabled)')];
    const currentIndex = options.indexOf(document.activeElement);
    if (event.key === 'Escape') {
      event.preventDefault();
      closeButtonSelect(control, true);
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const direction = event.key === 'ArrowDown' ? 1 : -1;
      options[(currentIndex + direction + options.length) % options.length]?.focus();
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      options[event.key === 'Home' ? 0 : options.length - 1]?.focus();
    }
  });
  select.addEventListener('change', () => syncButtonSelect(select));

  select.after(control);
  control.append(trigger, menu);
  renderButtonSelectOptions(select, menu);
  syncButtonSelect(select);
}

function initButtonSelects() {
  document.querySelectorAll('select').forEach(enhanceSelect);
  const observer = new MutationObserver((records) => {
    records.forEach((record) => {
      if (record.type === 'childList') {
        record.addedNodes.forEach((node) => {
          if (node.nodeType !== Node.ELEMENT_NODE) return;
          if (node.matches('select')) enhanceSelect(node);
          node.querySelectorAll('select').forEach(enhanceSelect);
        });
        const select = record.target.closest('select');
        if (select?.dataset.buttonSelectReady === 'true') {
          renderButtonSelectOptions(select, select.nextElementSibling.querySelector('.button-select-menu'));
          syncButtonSelect(select);
        }
      }
    });
  });
  observer.observe(document.body, { childList: true, subtree: true });

  document.addEventListener('click', (event) => {
    if (event.target.closest('.button-select')) return;
    document.querySelectorAll('.button-select.open').forEach((control) => closeButtonSelect(control));
  });
  document.querySelectorAll('form').forEach((form) => {
    form.addEventListener('reset', () => {
      window.setTimeout(() => form.querySelectorAll('select').forEach(syncButtonSelect));
    });
  });
}

function toggleMobileNav(event) {
  const button = event.target.closest('.menu-toggle');
  const navbar = button && button.closest('.navbar');
  const links = navbar && navbar.querySelector('.nav-links');
  if (!links) return;
  initializeMobileDrawer(navbar);
  if (links.classList.contains('open')) {
    closeMobileNav(navbar, false);
    return;
  }

  links.classList.add('open');
  navbar.classList.add('mobile-drawer-active');
  navbar.querySelector('.nav-drawer-backdrop').hidden = false;
  button.setAttribute('aria-expanded', 'true');
  button.setAttribute('aria-label', 'Close navigation menu');
  button.classList.add('open');
  document.body.classList.add('mobile-drawer-open');
}

function closeMobileNav(navbar, returnFocus = false) {
  const links = navbar.querySelector('.nav-links');
  const button = navbar.querySelector('.menu-toggle');
  if (!links || !button) return;
  links.classList.remove('open');
  navbar.classList.remove('mobile-drawer-active');
  navbar.querySelector('.nav-drawer-backdrop').hidden = true;
  button.setAttribute('aria-expanded', 'false');
  button.setAttribute('aria-label', 'Open navigation menu');
  button.classList.remove('open');
  document.body.classList.remove('mobile-drawer-open');
  if (returnFocus) button.focus();
}

// Fades the page out with the same timing as css/styles.css's app-page-exit before a
// navbar link leaves the page, so About, Sign In, the logo, etc. all feel consistent
// no matter which browser renders them (see supportsNativePageTransition above).
function handleNavPageLeave(event) {
  if (supportsNativePageTransition) return false;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return false;
  const link = event.target.closest('.navbar a[href]');
  if (!link || link.target === '_blank' || link.hasAttribute('download')) return false;
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return false;
  let url;
  try {
    url = new URL(link.href, location.href);
  } catch {
    return false;
  }
  if (url.origin !== location.origin) return false;
  if (url.pathname === location.pathname && url.hash) return false; // same-page anchors (#items, #report) keep their own handling
  event.preventDefault();
  document.documentElement.classList.add('page-leaving');
  setTimeout(() => {
    location.href = url.href;
  }, 140);
  return true;
}

loadTheme();
document.addEventListener('DOMContentLoaded', () => {
  initNav();
  initButtonSelects();
});
document.addEventListener('click', (event) => {
  const itemsLink = event.target.closest('.navbar .nav-links a[href="#items"]');
  const itemsSection = document.getElementById('items');
  if (itemsLink && itemsSection) {
    event.preventDefault();
    dashboardBackPrompted = false;
    window.history.replaceState(window.history.state, '', itemsLink.hash);
    itemsSection.scrollIntoView();
  }

  const reportLink = event.target.closest('.navbar .nav-links a[href="#report"]');
  const reportSection = document.getElementById('report');
  if (reportLink && reportSection) {
    event.preventDefault();
    dashboardBackPrompted = false;
    window.history.replaceState(window.history.state, '', reportLink.hash);
    reportSection.scrollIntoView();
  }

  handleNavPageLeave(event);

  if (event.target.closest('.theme-toggle')) {
    if (event.target.closest('.theme-toggle').dataset.themeBound === 'true') return;
    toggleTheme();
    return;
  }

  if (event.target.closest('.menu-toggle')) {
    event.stopPropagation();
    toggleMobileNav(event);
    return;
  }

  if (event.target.closest('.mobile-drawer-close')) {
    const navbar = event.target.closest('.navbar');
    if (navbar) closeMobileNav(navbar, true);
    return;
  }

  if (event.target.closest('.nav-drawer-backdrop')) {
    const navbar = event.target.closest('.navbar');
    if (navbar) closeMobileNav(navbar, true);
    return;
  }

  document.querySelectorAll('.nav-links.open').forEach((links) => {
    const navbar = links.closest('.navbar');
    if (event.target.closest('.nav-links a, .nav-links button')) {
      closeMobileNav(navbar);
    }
  });
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    document.querySelectorAll('.nav-links.open').forEach((links) => closeMobileNav(links.closest('.navbar'), true));
  }
});
