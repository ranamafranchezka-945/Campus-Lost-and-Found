// Shared UI wiring used instead of inline on* attributes (keeps the pages CSP-compatible).
//
// Event delegation:
//   data-action="fnName"   click  -> window.fnName(...args)
//   data-submit="fnName"   submit -> window.fnName(event)
//   data-change="fnName"   change -> window.fnName(...args)
//   data-input="fnName"    input  -> window.fnName(...args)
//   data-args='["a", 1]'   optional JSON argument list; the tokens "$el", "$event",
//                          "$checked" and "$value" are replaced with the element,
//                          the event, element.checked and element.value.
//   data-activate          also fire the click action on Enter / Space (role="button" elements)
//
// Dialogs: shared overlays use the same focus and page-scroll management.
//   data-close="fnName"    function that closes it (backdrop click and Escape call it)
(function () {
  function resolveArgs(el, event) {
    let args = [];
    if (el.dataset.args) {
      try {
        args = JSON.parse(el.dataset.args);
      } catch (error) {
        console.error('Invalid data-args on', el, error);
        return null;
      }
    }
    return args.map((arg) => {
      if (arg === '$el') return el;
      if (arg === '$event') return event;
      if (arg === '$checked') return el.checked;
      if (arg === '$value') return el.value;
      return arg;
    });
  }

  function invoke(name, el, event, defaultArgs) {
    const fn = window[name];
    if (typeof fn !== 'function') {
      console.error(`UI action "${name}" is not defined.`);
      return;
    }
    const args = el.dataset.args ? resolveArgs(el, event) : defaultArgs;
    if (args) fn.apply(el, args);
  }

  document.addEventListener('click', (event) => {
    const el = event.target.closest('[data-action]');
    if (!el || el.disabled) return;
    invoke(el.dataset.action, el, event, []);
  });

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const el = event.target.closest('[data-activate][data-action]');
    if (!el || el !== event.target) return;
    event.preventDefault();
    invoke(el.dataset.action, el, event, []);
  });

  document.addEventListener('submit', (event) => {
    const form = event.target.closest('[data-submit]');
    if (!form) return;
    invoke(form.dataset.submit, form, event, [event]);
  });

  document.addEventListener('change', (event) => {
    const el = event.target.closest('[data-change]');
    if (!el) return;
    invoke(el.dataset.change, el, event, []);
  });

  document.addEventListener('input', (event) => {
    const el = event.target.closest('[data-input]');
    if (!el) return;
    invoke(el.dataset.input, el, event, []);
  });

  // ── Dialogs ────────────────────────────────────────────────────────────────
  const OVERLAY = '.slip-overlay, .del-modal-backdrop, .activity-modal-backdrop, .modal-backdrop';
  const FOCUSABLE =
    'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
  const openStack = [];
  const returnFocus = new WeakMap();
  const overlayObservers = new WeakMap();
  let labelCounter = 0;
  let pageScrollSnapshot = null;
  // Last control used outside any dialog: openers often move focus themselves before
  // the dialog is observed as open, so document.activeElement is not reliable then.
  let lastOutsideControl = null;

  function getInlineProperty(element, property) {
    return {
      value: element.style.getPropertyValue(property),
      priority: element.style.getPropertyPriority(property),
    };
  }

  function restoreInlineProperty(element, property, snapshot) {
    if (snapshot.value) element.style.setProperty(property, snapshot.value, snapshot.priority);
    else element.style.removeProperty(property);
  }

  function setPageScrollLocked(locked) {
    const root = document.documentElement;
    const body = document.body;
    if (locked === Boolean(pageScrollSnapshot)) return;

    if (locked) {
      const scrollX = window.scrollX;
      const scrollY = window.scrollY;
      const scrollbarWidth = Math.max(0, window.innerWidth - root.clientWidth);
      const bodyPadding = parseFloat(getComputedStyle(body).paddingRight) || 0;
      const adminContent = document.querySelector('.admin-content');
      const adminPadding = adminContent ? parseFloat(getComputedStyle(adminContent).paddingRight) || 0 : 0;
      const adminScrollbarWidth = adminContent ? Math.max(0, adminContent.offsetWidth - adminContent.clientWidth) : 0;

      pageScrollSnapshot = {
        scrollX,
        scrollY,
        hadRootLock: root.classList.contains('page-scroll-locked'),
        hadBodyLock: body.classList.contains('page-scroll-locked'),
        bodyLeft: getInlineProperty(body, '--page-scroll-lock-left'),
        bodyTop: getInlineProperty(body, '--page-scroll-lock-top'),
        bodyPadding: getInlineProperty(body, '--page-scroll-lock-padding'),
        adminPadding: getInlineProperty(body, '--page-scroll-lock-admin-padding'),
        scrollBehavior: getInlineProperty(root, 'scroll-behavior'),
      };

      body.style.setProperty('--page-scroll-lock-left', `${-scrollX}px`);
      body.style.setProperty('--page-scroll-lock-top', `${-scrollY}px`);
      body.style.setProperty('--page-scroll-lock-padding', `${bodyPadding + scrollbarWidth}px`);
      if (adminContent) {
        body.style.setProperty('--page-scroll-lock-admin-padding', `${adminPadding + adminScrollbarWidth}px`);
      }
      root.classList.add('page-scroll-locked');
      body.classList.add('page-scroll-locked');
      return;
    }

    const snapshot = pageScrollSnapshot;
    pageScrollSnapshot = null;
    root.style.setProperty('scroll-behavior', 'auto', 'important');
    if (!snapshot.hadRootLock) root.classList.remove('page-scroll-locked');
    if (!snapshot.hadBodyLock) body.classList.remove('page-scroll-locked');
    restoreInlineProperty(body, '--page-scroll-lock-left', snapshot.bodyLeft);
    restoreInlineProperty(body, '--page-scroll-lock-top', snapshot.bodyTop);
    restoreInlineProperty(body, '--page-scroll-lock-padding', snapshot.bodyPadding);
    restoreInlineProperty(body, '--page-scroll-lock-admin-padding', snapshot.adminPadding);
    window.scrollTo(snapshot.scrollX, snapshot.scrollY);
    restoreInlineProperty(root, 'scroll-behavior', snapshot.scrollBehavior);
  }

  function syncPageScrollLock() {
    const drawerOpen =
      document.body.classList.contains('mobile-drawer-open') ||
      Boolean(
        document.querySelector(
          '.side-backdrop.open, .admin-sidebar.open, #sideBackdrop.open, #adminSidebar.open, .navbar.mobile-drawer-active .nav-links.open'
        )
      );
    const modalOpen =
      openStack.length > 0 ||
      Boolean(document.querySelector('dialog[open], .activity-modal-backdrop.open, .modal-backdrop.open'));
    setPageScrollLocked(drawerOpen || modalOpen);
  }

  function rememberOutside(event) {
    const control = event.target.closest?.(FOCUSABLE);
    if (control && !control.closest(OVERLAY)) lastOutsideControl = control;
  }
  document.addEventListener('focusin', rememberOutside, true);
  document.addEventListener('pointerdown', rememberOutside, true);
  document.addEventListener('click', rememberOutside, true);

  function isVisible(el) {
    return el.offsetParent !== null || el.getClientRects().length > 0;
  }

  function panelOf(overlay) {
    return overlay.querySelector('[role="dialog"]') || overlay.firstElementChild;
  }

  function prepare(overlay) {
    const panel = panelOf(overlay);
    if (!panel || panel.dataset.dialogReady) return;
    panel.dataset.dialogReady = 'true';
    panel.setAttribute('role', panel.getAttribute('role') || 'dialog');
    panel.setAttribute('aria-modal', 'true');
    if (!panel.hasAttribute('tabindex')) panel.setAttribute('tabindex', '-1');
    if (!panel.hasAttribute('aria-labelledby') && !panel.hasAttribute('aria-label')) {
      const heading = panel.querySelector('h1, h2, h3');
      if (heading) {
        if (!heading.id) heading.id = `dialog-title-${++labelCounter}`;
        panel.setAttribute('aria-labelledby', heading.id);
      }
    }
  }

  function closeOverlay(overlay) {
    const closeName = overlay.dataset.close;
    if (closeName && typeof window[closeName] === 'function') window[closeName]();
    else overlay.classList.remove('open');
  }

  function handleOpened(overlay) {
    if (openStack.includes(overlay)) return;
    prepare(overlay);
    const active = document.activeElement;
    const activeIsOutside = active && active !== document.body && !active.closest(OVERLAY);
    returnFocus.set(overlay, activeIsOutside ? active : lastOutsideControl);
    openStack.push(overlay);
    syncPageScrollLock();
    // Wait a frame so content filled in by the opener is in place before focusing.
    requestAnimationFrame(() => {
      if (!overlay.classList.contains('open')) return;
      const panel = panelOf(overlay);
      const field = [
        ...panel.querySelectorAll('input:not([type="hidden"]):not([type="checkbox"]), select, textarea'),
      ].find((el) => !el.disabled && isVisible(el));
      if (!panel.contains(document.activeElement)) (field || panel).focus({ preventScroll: true });
    });
  }

  function handleClosed(overlay) {
    const index = openStack.indexOf(overlay);
    if (index === -1) return;
    openStack.splice(index, 1);
    syncPageScrollLock();
    const previous = returnFocus.get(overlay);
    returnFocus.delete(overlay);
    if (previous && previous.isConnected && isVisible(previous) && !openStack.length) {
      previous.focus({ preventScroll: true });
    }
  }

  function watch(overlay) {
    if (overlayObservers.has(overlay)) return;
    overlay.dataset.dialogWatched = 'true';
    prepare(overlay);
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) closeOverlay(overlay);
    });
    const observer = new MutationObserver(() => {
      if (overlay.classList.contains('open')) handleOpened(overlay);
      else handleClosed(overlay);
    });
    overlayObservers.set(overlay, observer);
    observer.observe(overlay, { attributes: true, attributeFilter: ['class'] });
    if (overlay.classList.contains('open')) handleOpened(overlay);
  }

  function unwatch(overlay) {
    const observer = overlayObservers.get(overlay);
    if (observer) observer.disconnect();
    overlayObservers.delete(overlay);
    delete overlay.dataset.dialogWatched;
    handleClosed(overlay);
  }

  document.addEventListener('keydown', (event) => {
    const top = openStack[openStack.length - 1];
    if (!top) return;
    if (event.key === 'Escape' && !event.defaultPrevented) {
      event.preventDefault();
      closeOverlay(top);
      return;
    }
    if (event.key !== 'Tab') return;
    // Keep keyboard focus inside the open dialog.
    const panel = panelOf(top);
    const focusable = [...panel.querySelectorAll(FOCUSABLE)].filter(isVisible);
    if (!focusable.length) {
      event.preventDefault();
      panel.focus();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && (document.activeElement === first || document.activeElement === panel)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    } else if (!panel.contains(document.activeElement)) {
      event.preventDefault();
      first.focus();
    }
  });

  function init() {
    document.querySelectorAll(OVERLAY).forEach(watch);
    new MutationObserver((records) => {
      records.forEach((record) => {
        record.addedNodes.forEach((node) => {
          if (node.nodeType !== Node.ELEMENT_NODE) return;
          if (node.matches(OVERLAY)) watch(node);
          node.querySelectorAll(OVERLAY).forEach(watch);
        });
        record.removedNodes.forEach((node) => {
          if (node.nodeType !== Node.ELEMENT_NODE) return;
          if (node.matches(OVERLAY)) unwatch(node);
          node.querySelectorAll(OVERLAY).forEach(unwatch);
        });
      });
      syncPageScrollLock();
    }).observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['class', 'open'],
    });
    window.addEventListener('pagehide', () => setPageScrollLocked(false));
    window.addEventListener('pageshow', () => {
      document.querySelectorAll(OVERLAY).forEach(watch);
      syncPageScrollLock();
    });
    syncPageScrollLock();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  // Escape a value list for use inside a data-args="..." attribute in HTML templates.
  window.actionArgs = (...args) =>
    JSON.stringify(args)
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
})();
