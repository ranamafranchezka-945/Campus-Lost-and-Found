let deleteTargetId = null;
let restoreTarget = null;
let blockedEmails = [];
let allowedEmails = [];
    let activeTab = 'dashboard';
    let adminClaimsFilter = 'pending';
    let dashboardRange = 'all';
    let adminItems = [];
    let claimRequests = [];
    let adminClaimsSignature = null;
    let activeClaimReviewId = null;
    let adminRefreshInProgress = false;
    let adminItemsSignature = null;
    let actionConfirmResolver = null;
    let cachedServerItems = [];
    const selectedItemIds = new Set();
    let visibleAdminItems = [];
    let adminSort = { key: 'date', direction: 'desc' };
    let adminTypeFilter = '';
    const adminItemsPerPage = 10;
    let adminCurrentPage = 1;
    let adminUsers = [];
    let deleteUserTargetId = null;
    let studentBelongings = [];
    let studentBelongingsSignature = null;

    async function adminFetch(url, options = {}) {
      const response = await fetch(url, { ...options, credentials: 'same-origin' });
      if (response.status === 401 || response.status === 403) {
        window.location.replace('/login?redirect=%2Fadmin.html');
      }
      return response;
    }

    async function requireAdminSession() {
      try {
        const response = await adminFetch('/api/auth/me', { cache: 'no-store' });
        if (!response.ok) return response.status >= 500;
        const data = await response.json();
        if (response.ok && data.authenticated && data.user?.role === 'admin') {
          window.currentAdminUserId = data.user.id;
          renderAdminIdentity(data.user);
          installDashboardBackGuard();
          return true;
        }
      } catch (error) {
        return true;
      }
      window.location.replace('/login?redirect=%2Fadmin.html');
      return false;
    }

    document.addEventListener('DOMContentLoaded', async () => {
      initNav();
      if (!await requireAdminSession()) return;
      refreshAdminItems();
      refreshStudentBelongings();
      refreshAdminClaims();
      refreshAdminUsers();
      refreshBlockedEmails();
      refreshAllowedEmails();
      window.setInterval(() => {
        refreshAdminItems();
        refreshStudentBelongings();
        refreshAdminClaims();
      }, 5000);

      // Sidebar navigation (the items links carry the lost / found filter)
      document.querySelectorAll('.side-link[data-view]').forEach(link => {
        link.addEventListener('click', () => {
          if (link.dataset.view === 'items') showAdminItems(link.dataset.adminFilter || '');
          else showAdminView(link.dataset.view);
          closeSidebar();
        });
      });
      document.getElementById('sidebarToggle').addEventListener('click', toggleSidebar);
      document.getElementById('sidebarCollapse').addEventListener('click', () => {
        setSidebarCollapsed(!document.getElementById('adminApp').classList.contains('is-collapsed'));
      });
      window.addEventListener('resize', syncMenuButton);
      setupHeaderMenus();
      setupThemePill();
      restoreSidebarState();
      document.getElementById('sidebarClose').addEventListener('click', closeSidebar);
      document.getElementById('sideBackdrop').addEventListener('click', closeSidebar);
      document.addEventListener('keydown', event => { if (event.key === 'Escape') closeSidebar(); });
      document.querySelectorAll('[data-claims-filter]').forEach(button => {
        button.addEventListener('click', () => setClaimsFilter(button.dataset.claimsFilter));
      });
      document.querySelectorAll('#dashRangeSeg [data-range]').forEach(button => {
        button.addEventListener('click', () => setDashboardRange(button.dataset.range));
      });
      // The top-bar search always searches items, so typing there leaves the dashboard.
      document.getElementById('adminSearch').addEventListener('input', () => {
        if (activeTab !== 'items') showAdminItems(adminTypeFilter);
      });
      bindTrendTooltip();
      // "/" or Ctrl/Cmd+K jumps to search; Escape clears it, then leaves it.
      document.addEventListener('keydown', event => {
        const search = document.getElementById('adminSearch');
        if (event.target === search && event.key === 'Escape') {
          if (search.value) {
            search.value = '';
            search.dispatchEvent(new Event('input', { bubbles: true }));
          } else {
            search.blur();
          }
          return;
        }
        const typing = event.target.closest && event.target.closest('input, textarea, select, [contenteditable="true"]');
        const slash = event.key === '/' && !typing && !event.ctrlKey && !event.metaKey && !event.altKey;
        const palette = (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k';
        if (!slash && !palette) return;
        if (document.querySelector('.slip-overlay.open, .del-modal-backdrop.open, .claim-review-backdrop.open')) return;
        event.preventDefault();
        search.focus();
        search.select();
      });
      window.addEventListener('hashchange', applyAdminHash);
      applyAdminHash();

      // Delete modal controls
      document.getElementById('cancelDelete').addEventListener('click',  closeDeleteModal);
      document.getElementById('confirmDelete').addEventListener('click', doDelete);
      document.getElementById('deleteModal').addEventListener('click', e => {
        if (e.target === document.getElementById('deleteModal')) closeDeleteModal();
      });
      document.getElementById('cancelRestore').addEventListener('click', closeRestoreModal);
      document.getElementById('confirmRestore').addEventListener('click', confirmRestore);
      document.getElementById('restoreModal').addEventListener('click', e => {
        if (e.target === document.getElementById('restoreModal')) closeRestoreModal();
      });

      document.getElementById('bulkClaimBtn').addEventListener('click', () => runBulkAction('claim'));
      document.getElementById('bulkArchiveBtn').addEventListener('click', () => runBulkAction('archive'));
      document.getElementById('bulkDeleteBtn').addEventListener('click', () => runBulkAction('delete'));
      document.getElementById('exportSelectedBtn').addEventListener('click', () => exportCSV([...selectedItemIds]));
      document.getElementById('sendBroadcastBtn').addEventListener('click', sendBroadcast);
      document.getElementById('cancelActionConfirm').addEventListener('click', closeActionConfirm);
      document.getElementById('actionConfirmModal').addEventListener('click', event => { if (event.target.id === 'actionConfirmModal') closeActionConfirm(); });
      document.getElementById('openCreateUserBtn').addEventListener('click', () => { document.getElementById('userFormPanel').hidden = false; });
      document.getElementById('cancelCreateUserBtn').addEventListener('click', closeCreateUserForm);
      document.getElementById('createUserForm').addEventListener('submit', createAdminUser);
      document.querySelector('#createUserForm [name="role"]').addEventListener('change', event => {
        const department = document.querySelector('#createUserForm [name="department"]');
        const departmentField = document.getElementById('createUserDepartmentField');
        if (event.target.value === 'admin') {
          department.value = 'Administration';
          department.required = true;
          departmentField.hidden = false;
        } else if (event.target.value === 'employee') {
          // Employees aren't in a college department; the backend accepts a blank one.
          department.value = '';
          department.required = false;
          departmentField.hidden = true;
        } else {
          if (department.value === 'Administration') department.value = '';
          department.required = true;
          departmentField.hidden = false;
        }
      });
      document.getElementById('confirmDeleteUser').addEventListener('click', deleteAdminUser);
      document.getElementById('cancelDeleteUser').addEventListener('click', closeDeleteUserModal);
      document.getElementById('deleteUserModal').addEventListener('click', event => { if (event.target.id === 'deleteUserModal') closeDeleteUserModal(); });
      document.getElementById('blockEmailForm').addEventListener('submit', blockEmail);
      document.getElementById('allowEmailForm').addEventListener('submit', allowEmail);
      document.getElementById('selectAllItems').addEventListener('change', toggleSelectAllVisible);
      document.getElementById('adminFilterDate').addEventListener('change', () => { adminCurrentPage = 1; renderItemsTable(); });
      document.querySelectorAll('.sort-button').forEach(button => button.addEventListener('click', () => {
        const key = button.dataset.sort;
        adminSort = adminSort.key === key
          ? { key, direction: adminSort.direction === 'asc' ? 'desc' : 'asc' }
          : { key, direction: 'asc' };
        renderItemsTable();
      }));

      // Reactive admin filters
      ['adminSearch','adminFilterStatus'].forEach(id => {
        document.getElementById(id).addEventListener('input', () => {
          adminCurrentPage = 1;
          renderItemsTable();
        });
      });
      updateBulkToolbar();
    });

    async function refreshAdminUsers() {
      try {
        const response = await adminFetch('/api/auth/users', { cache: 'no-store' });
        if (!response.ok) return;
        const data = await response.json();
        adminUsers = Array.isArray(data.users) ? data.users : [];
        renderAdminUsers();
      } catch (error) {
        showToast('Could not load users.', 'error');
      }
    }

    function renderAdminUsers() {
      const body = document.getElementById('adminUsersBody');
      const empty = document.getElementById('adminUsersEmptyState');
      if (!body) return;
      empty.hidden = adminUsers.length > 0;
      body.innerHTML = adminUsers.map(user => `
        <tr>
          <td>${escHtml(user.fullName || '—')}</td>
          <td>${escHtml(user.email || '—')}</td>
          <td><span class="badge ${user.role === 'admin' ? 'badge-role-admin' : user.role === 'employee' ? 'badge-role-employee' : 'badge-role-student'}">${escHtml(user.role === 'admin' ? 'Admin' : user.role === 'employee' ? 'Employee' : 'Student')}</span></td>
          <td>${escHtml(user.department || '—')}</td>
          <td>${escHtml(formatDate(user.createdAt))}</td>
          <td><button type="button" class="action-btn action-btn-delete user-delete-button" data-user-id="${escHtml(user.id)}" data-user-name="${escHtml(user.fullName || user.email)}"${user.id === window.currentAdminUserId ? ' disabled' : ''}>Delete</button></td>
        </tr>`).join('');
      body.querySelectorAll('.user-delete-button').forEach(button => button.addEventListener('click', () => openDeleteUserModal(button.dataset.userId, button.dataset.userName)));
    }

    async function refreshBlockedEmails() {
      try {
        const response = await adminFetch('/api/auth/blocked-emails', { cache: 'no-store' });
        if (!response.ok) return;
        const data = await response.json();
        blockedEmails = Array.isArray(data.blockedEmails) ? data.blockedEmails : [];
        renderBlockedEmails();
      } catch (error) {
        showToast('Could not load blocked emails.', 'error');
      }
    }

    function renderBlockedEmails() {
      const body = document.getElementById('blockedEmailsBody');
      const empty = document.getElementById('blockedEmailsEmptyState');
      const count = document.getElementById('blockedEmailsCount');
      if (!body) return;
      empty.hidden = blockedEmails.length > 0;
      count.hidden = blockedEmails.length === 0;
      count.textContent = blockedEmails.length;
      // Most recently blocked first, so a fresh block is immediately visible without scrolling.
      const sorted = [...blockedEmails].sort((a, b) => new Date(b.blockedAt) - new Date(a.blockedAt));
      body.innerHTML = sorted.map(entry => `
        <tr>
          <td>${escHtml(entry.email)}</td>
          <td>${escHtml(formatDate(entry.blockedAt))}</td>
          <td><button type="button" class="action-btn action-btn-restore unblock-email-button" data-email="${escHtml(entry.email)}">Unblock</button></td>
        </tr>`).join('');
      body.querySelectorAll('.unblock-email-button').forEach(button => button.addEventListener('click', () => unblockEmail(button.dataset.email)));
    }

    async function blockEmail(event) {
      event.preventDefault();
      const form = event.currentTarget;
      const submit = form.querySelector('button[type="submit"]');
      submit.disabled = true;
      try {
        const email = new FormData(form).get('email');
        const response = await adminFetch('/api/auth/blocked-emails', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }) });
        const data = await response.json();
        if (!response.ok) throw new Error(data.message || 'Could not block that email.');
        form.reset();
        form.querySelector('input[name="email"]').focus();
        blockedEmails = data.blockedEmails;
        renderBlockedEmails();
        showToast('Email blocked.');
      } catch (error) {
        showToast(error.message, 'error');
      } finally {
        submit.disabled = false;
      }
    }

    async function unblockEmail(email) {
      try {
        const response = await adminFetch(`/api/auth/blocked-emails/${encodeURIComponent(email)}`, { method: 'DELETE' });
        const data = await response.json();
        if (!response.ok) throw new Error(data.message || 'Could not unblock that email.');
        blockedEmails = data.blockedEmails;
        renderBlockedEmails();
        showToast('Email unblocked.');
      } catch (error) {
        showToast(error.message, 'error');
      }
    }

    async function refreshAllowedEmails() {
      try {
        const response = await adminFetch('/api/auth/allowed-emails', { cache: 'no-store' });
        if (!response.ok) return;
        const data = await response.json();
        allowedEmails = Array.isArray(data.allowedEmails) ? data.allowedEmails : [];
        renderAllowedEmails();
      } catch (error) {
        showToast('Could not load allowed emails.', 'error');
      }
    }

    function renderAllowedEmails() {
      const body = document.getElementById('allowedEmailsBody');
      const empty = document.getElementById('allowedEmailsEmptyState');
      const count = document.getElementById('allowedEmailsCount');
      const status = document.getElementById('allowlistStatus');
      if (!body) return;
      empty.hidden = allowedEmails.length > 0;
      count.hidden = allowedEmails.length === 0;
      count.textContent = allowedEmails.length;
      status.textContent = allowedEmails.length === 0
        ? 'Empty: every @my.cspc.edu.ph address may register and sign in. Add an email below to restrict access to only approved addresses (administrators can always sign in).'
        : `Restricted: only the ${allowedEmails.length} email(s) below (plus administrators) can register or sign in. Remove all of them to reopen access to everyone.`;
      const sorted = [...allowedEmails].sort((a, b) => new Date(b.addedAt) - new Date(a.addedAt));
      body.innerHTML = sorted.map(entry => `
        <tr>
          <td>${escHtml(entry.email)}</td>
          <td>${escHtml(formatDate(entry.addedAt))}</td>
          <td><button type="button" class="action-btn action-btn-delete remove-allowed-button" data-email="${escHtml(entry.email)}">Remove</button></td>
        </tr>`).join('');
      body.querySelectorAll('.remove-allowed-button').forEach(button => button.addEventListener('click', () => removeAllowedEmail(button.dataset.email)));
    }

    async function allowEmail(event) {
      event.preventDefault();
      const form = event.currentTarget;
      const submit = form.querySelector('button[type="submit"]');
      submit.disabled = true;
      try {
        const email = new FormData(form).get('email');
        const response = await adminFetch('/api/auth/allowed-emails', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }) });
        const data = await response.json();
        if (!response.ok) throw new Error(data.message || 'Could not add that email.');
        form.reset();
        form.querySelector('input[name="email"]').focus();
        allowedEmails = data.allowedEmails;
        renderAllowedEmails();
        showToast('Email allowed.');
      } catch (error) {
        showToast(error.message, 'error');
      } finally {
        submit.disabled = false;
      }
    }

    async function removeAllowedEmail(email) {
      try {
        const response = await adminFetch(`/api/auth/allowed-emails/${encodeURIComponent(email)}`, { method: 'DELETE' });
        const data = await response.json();
        if (!response.ok) throw new Error(data.message || 'Could not remove that email.');
        allowedEmails = data.allowedEmails;
        renderAllowedEmails();
        showToast('Email removed from the allowlist.');
      } catch (error) {
        showToast(error.message, 'error');
      }
    }

    function closeCreateUserForm() {
      const form = document.getElementById('createUserForm');
      form.reset();
      form.elements.studentId.value = 'N/A';
      form.elements.department.required = true;
      document.getElementById('createUserDepartmentField').hidden = false;
      document.getElementById('userFormPanel').hidden = true;
    }

    async function createAdminUser(event) {
      event.preventDefault();
      const form = event.currentTarget;
      const submit = form.querySelector('button[type="submit"]');
      submit.disabled = true;
      try {
        const response = await adminFetch('/api/auth/users', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.fromEntries(new FormData(form))) });
        const data = await response.json();
        if (!response.ok) throw new Error(data.errors?.join(' ') || data.message || 'Could not create user.');
        closeCreateUserForm();
        await refreshAdminUsers();
        showToast('User created successfully.');
      } catch (error) {
        showToast(error.message, 'error');
      } finally {
        submit.disabled = false;
      }
    }

    function openDeleteUserModal(id, name) {
      deleteUserTargetId = id;
      document.getElementById('deleteUserMsg').textContent = `Are you sure you want to permanently delete ${name}? This action cannot be undone.`;
      document.getElementById('deleteUserModal').classList.add('open');
    }

    function closeDeleteUserModal() {
      deleteUserTargetId = null;
      document.getElementById('deleteUserModal').classList.remove('open');
    }

    async function deleteAdminUser() {
      if (!deleteUserTargetId) return;
      const button = document.getElementById('confirmDeleteUser');
      button.disabled = true;
      try {
        const response = await adminFetch(`/api/auth/users/${encodeURIComponent(deleteUserTargetId)}`, { method: 'DELETE' });
        const data = await response.json();
        if (!response.ok) throw new Error(data.message || 'Could not delete user.');
        closeDeleteUserModal();
        await refreshAdminUsers();
        showToast('User deleted successfully.');
      } catch (error) {
        showToast(error.message, 'error');
      } finally {
        button.disabled = false;
      }
    }

    function normalizeAdminItem(item) {
      const normalized = { ...item };
      normalized.status = item.status || item.type || 'pending';
      normalized.desc = item.desc || item.description || '';
      normalized.description = item.description || item.desc || '';
      normalized.reporterName = item.reporterName || '';
      normalized.reporterContact = item.reporterContact || item.contact || item.reporterEmail || '';
      normalized.dateLost = item.dateLost || (item.type === 'lost' ? item.date || item.createdAt : '');
      normalized.dateFound = item.dateFound || (item.type === 'found' ? item.date || item.createdAt : '');
      return normalized;
    }

    async function refreshAdminItems() {
      if (adminRefreshInProgress) return;
      adminRefreshInProgress = true;
      try {
        let synced = false;
        try {
          const response = await adminFetch('/api/items', { cache: 'no-store' });
          if (response.ok) {
            const data = await response.json();
            if (data.success && Array.isArray(data.items)) {
              cachedServerItems = data.items
                .filter(item => item.type !== 'registered')
                .map(normalizeAdminItem);
              synced = true;
            }
          }
        } catch (error) {
          // Keep the last server snapshot when the API is temporarily unavailable.
        }
        setLiveStatus(synced);
        const nextItems = [...cachedServerItems];
        const nextSignature = JSON.stringify(nextItems);
        if (nextSignature !== adminItemsSignature) {
          adminItemsSignature = nextSignature;
          adminItems = nextItems;
          const existingItemIds = new Set(adminItems.map(item => String(item.id)));
          selectedItemIds.forEach(id => {
            if (!existingItemIds.has(id)) selectedItemIds.delete(id);
          });
          renderAdminPanel(adminItems);
        }
      } finally {
        adminRefreshInProgress = false;
      }
    }

    async function refreshStudentBelongings() {
      try {
        const response = await adminFetch('/api/items?type=registered', { cache: 'no-store' });
        if (!response.ok) return;
        const data = await response.json();
        if (!data.success || !Array.isArray(data.items)) return;
        const nextSignature = JSON.stringify(data.items);
        if (nextSignature === studentBelongingsSignature) return;
        studentBelongingsSignature = nextSignature;
        studentBelongings = data.items.map(normalizeAdminItem);
        renderStudentBelongings();
      } catch (error) {
        // Keep the last snapshot when the API is temporarily unavailable.
      }
    }

    function renderStudentBelongings() {
      const body = document.getElementById('adminBelongingsBody');
      const empty = document.getElementById('adminBelongingsEmptyState');
      if (!body || !empty) return;
      empty.hidden = studentBelongings.length > 0;
      body.innerHTML = studentBelongings.map(item => `
        <tr>
          <td class="td-title">${escHtml(item.title || 'Untitled belonging')}</td>
          <td>${escHtml(item.ownerName || item.reporterName || item.contact || 'Unknown student')}</td>
          <td>${escHtml(item.category || '—')}</td>
          <td>${escHtml(item.location || '—')}</td>
          <td>${escHtml(item.refCode || '—')}</td>
          <td>${escHtml(formatDate(item.createdAt || item.date))}</td>
          <td class="actions-cell"><button class="action-btn action-btn-delete" data-action="openDeleteModal" data-args="${actionArgs(item.id, item.title || 'this belonging', item.ownerName || 'the registered student')}">Delete</button></td>
        </tr>`).join('');
    }

    async function refreshAdminClaims() {
      try {
        const response = await adminFetch('/api/items/claims', { cache: 'no-store' });
        const data = await response.json();
        if (!response.ok || !data.success) return;
        const nextSignature = JSON.stringify(data.claims);
        if (nextSignature === adminClaimsSignature) return;
        adminClaimsSignature = nextSignature;
        claimRequests = data.claims;
        renderAdminPanel(adminItems);
        renderItemsTable();
      } catch (error) {
        // Keep the last claim snapshot when the API is temporarily unavailable.
      }
    }

    // ── Views, sidebar and identity ──────────────────────────────────────────
    const ADMIN_VIEWS = {
      dashboard: 'tabDashboard',
      items: 'tabItems',
      claims: 'tabClaimQueue',
      broadcast: 'tabBroadcast',
      belongings: 'tabBelongings',
      users: 'tabUsers'
    };
    const ITEM_HEADINGS = {
      '': ['All items', 'Every lost and found report. Update statuses, review claims or remove reports.'],
      lost: ['Lost items', 'Reports from people who have lost something.'],
      found: ['Found items', 'Reports of items that someone found and handed in.']
    };

    function showAdminView(name) {
      if (!ADMIN_VIEWS[name]) name = 'dashboard';
      activeTab = name;
      Object.entries(ADMIN_VIEWS).forEach(([key, id]) => { document.getElementById(id).hidden = key !== name; });
      syncSidebar();
      if (name === 'users') renderAdminUsers();
      // The address follows the view so a refresh or a shared link opens the same place.
      // history.state is kept: the dashboard back guard stores its marker there.
      const hash = name === 'items' ? (adminTypeFilter || 'items') : name === 'dashboard' ? '' : name;
      try { window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search + (hash ? `#${hash}` : '')); } catch (error) { /* ignore */ }
      window.scrollTo({ top: 0 });
    }

    function showAdminItems(type = '', status = '') {
      adminTypeFilter = type || '';
      document.getElementById('adminFilterStatus').value = status || '';
      adminCurrentPage = 1;
      const [title, text] = ITEM_HEADINGS[adminTypeFilter] || ITEM_HEADINGS[''];
      document.getElementById('itemsHeading').textContent = title;
      document.getElementById('itemsSubheading').textContent = text;
      showAdminView('items');
      renderItemsTable();
    }

    function applyAdminHash() {
      const hash = decodeURIComponent(window.location.hash.replace(/^#/, ''));
      if (hash === 'lost' || hash === 'found') showAdminItems(hash);
      else if (hash === 'items') showAdminItems('');
      else showAdminView(hash);
    }

    function syncSidebar() {
      document.querySelectorAll('.side-link[data-view]').forEach(link => {
        const active = link.dataset.view === activeTab
          && (link.dataset.view !== 'items' || (link.dataset.adminFilter || '') === adminTypeFilter);
        link.classList.toggle('active', active);
        if (active) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
      });
    }

    function openSidebar() {
      document.getElementById('adminSidebar').classList.add('open');
      document.getElementById('sideBackdrop').classList.add('open');
      syncMenuButton();
    }

    function closeSidebar() {
      document.getElementById('adminSidebar').classList.remove('open');
      document.getElementById('sideBackdrop').classList.remove('open');
      syncMenuButton();
    }

    const SIDEBAR_KEY = 'admin_sidebar_collapsed';
    const isDesktop = () => window.matchMedia('(min-width: 1024px)').matches;

    function syncMenuButton() {
      const expanded = isDesktop()
        ? !document.getElementById('adminApp').classList.contains('is-collapsed')
        : document.getElementById('adminSidebar').classList.contains('open');
      document.getElementById('sidebarToggle').setAttribute('aria-expanded', String(expanded));
      document.getElementById('sidebarCollapse').setAttribute('aria-expanded', String(expanded));
    }

    // Wide screens: the menu shrinks to an icon rail and the choice is remembered.
    // Narrow screens: the same button opens the slide-out menu.
    function setSidebarCollapsed(collapsed, remember = true) {
      document.getElementById('adminApp').classList.toggle('is-collapsed', collapsed);
      document.querySelectorAll('.side-link').forEach(link => {
        // In the icon rail the label is gone, so it moves to a tooltip.
        if (collapsed) link.title = link.querySelector('span').textContent.trim(); else link.removeAttribute('title');
      });
      if (remember) {
        try { localStorage.setItem(SIDEBAR_KEY, collapsed ? '1' : '0'); } catch (error) { /* ignore */ }
      }
      syncMenuButton();
    }

    function toggleSidebar() {
      if (isDesktop()) setSidebarCollapsed(!document.getElementById('adminApp').classList.contains('is-collapsed'));
      else openSidebar();
    }

    function restoreSidebarState() {
      let saved = null;
      try { saved = localStorage.getItem(SIDEBAR_KEY); } catch (error) { /* ignore */ }
      if (saved === '1') setSidebarCollapsed(true, false); else syncMenuButton();
    }

    // The bell and the profile button each open one small panel; only one is open at a time.
    function setupHeaderMenus() {
      const pairs = [['adminBell', 'notifPanel'], ['profileBtn', 'profileMenu']];
      const closeAll = returnFocus => pairs.forEach(([buttonId, panelId]) => {
        const panel = document.getElementById(panelId);
        const button = document.getElementById(buttonId);
        if (!panel.hidden && returnFocus) button.focus();
        panel.hidden = true;
        button.setAttribute('aria-expanded', 'false');
      });
      pairs.forEach(([buttonId, panelId]) => {
        const button = document.getElementById(buttonId);
        const panel = document.getElementById(panelId);
        button.addEventListener('click', event => {
          event.stopPropagation();
          const opening = panel.hidden;
          closeAll(false);
          panel.hidden = !opening;
          button.setAttribute('aria-expanded', String(opening));
        });
        // Choosing something inside a panel closes it.
        panel.addEventListener('click', event => { if (event.target.closest('[data-action]')) closeAll(false); });
      });
      document.addEventListener('click', event => { if (!event.target.closest('.pop-wrap')) closeAll(false); });
      document.addEventListener('keydown', event => { if (event.key === 'Escape') closeAll(true); });
    }

    // The sun / moon switch follows the page theme, including changes made elsewhere.
    function setupThemePill() {
      const pill = document.getElementById('themePill');
      const sync = () => pill.setAttribute('aria-checked', String((document.documentElement.getAttribute('data-theme') || 'dark') !== 'light'));
      pill.addEventListener('click', () => toggleTheme());
      new MutationObserver(sync).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
      sync();
    }

    function renderNotifications(pending) {
      const waiting = [...pending].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt)).slice(0, 5);
      document.getElementById('notifCount').textContent = pending.length ? `${pending.length} waiting` : 'All clear';
      document.getElementById('notifBody').innerHTML = waiting.length
        ? `<ul class="feed">${waiting.map(claim => `
          <li class="feed-row">
            <div class="feed-main"><strong title="${escHtml(claim.itemTitle || 'Item')}">Claim for ${escHtml(claim.itemTitle || 'an item')}</strong><small>${escHtml(claim.claimantName || 'Unknown claimant')} · ${escHtml(relativeTime(claim.createdAt))}</small></div>
            <button type="button" class="action-btn action-btn-claim" data-action="openClaimReview" data-args="${actionArgs(claim.id)}">Review</button>
          </li>`).join('')}</ul>`
        : '<p class="feed-empty"><svg class="ico" aria-hidden="true"><use href="#i-found"/></svg>You are all caught up.</p>';
    }

    function renderAdminIdentity(user) {
      const name = String(user.fullName || user.email || 'Administrator').trim();
      const initials = name.split(/\s+/).slice(0, 2).map(part => part[0]).join('').toUpperCase() || 'A';
      document.getElementById('topName').textContent = name;
      document.getElementById('topAvatar').textContent = initials;
      document.getElementById('menuName').textContent = name;
      document.getElementById('menuEmail').textContent = user.email || '';
      const now = new Date();
      const greeting = now.getHours() < 12 ? 'Good morning' : now.getHours() < 18 ? 'Good afternoon' : 'Good evening';
      const today = now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
      document.getElementById('dashWelcome').textContent = `${greeting}, ${name.split(/\s+/)[0]}. Today is ${today}.`;
    }

    // ── Dashboard ────────────────────────────────────────────────────────────
    const DAY_MS = 24 * 60 * 60 * 1000;

    function itemTime(item) {
      const time = Date.parse(item.createdAt || item.date);
      return Number.isFinite(time) ? time : 0;
    }

    function isResolved(item) { return Boolean(item.claimed) || item.status === 'claimed'; }
    function isOpenItem(item) { return !isResolved(item) && item.status !== 'archived'; }

    // Locations are stored as "<office> (<details>)"; ranking by office keeps one office on one bar.
    function officeOf(item) {
      const location = String(item.location || '').trim();
      const details = String(item.locationDetails || '').trim();
      if (details && location.endsWith(`(${details})`)) return location.slice(0, -(details.length + 2)).trim() || location;
      return location || 'Unknown';
    }

    function relativeTime(value) {
      const time = Date.parse(value);
      if (!Number.isFinite(time)) return '';
      const minutes = Math.round((Date.now() - time) / 60000);
      if (minutes < 1) return 'just now';
      if (minutes < 60) return `${minutes} min ago`;
      const hours = Math.round(minutes / 60);
      if (hours < 24) return `${hours} hr${hours === 1 ? '' : 's'} ago`;
      const days = Math.round(hours / 24);
      if (days < 30) return `${days} day${days === 1 ? '' : 's'} ago`;
      return formatDate(value);
    }

    // Round axis: at most four steps of 1, 2, 5, 10 ... so ticks are clean whole numbers.
    function niceScale(peak) {
      const target = Math.max(peak, 4);
      const magnitude = Math.pow(10, Math.floor(Math.log10(target / 4)));
      const step = [1, 2, 5, 10].map(factor => factor * magnitude).find(size => target / size <= 4) || 10 * magnitude;
      return { step, max: Math.ceil(target / step) * step };
    }

    function buildMonthlyTrend(items, months = 6) {
      const now = new Date();
      const buckets = [];
      for (let back = months - 1; back >= 0; back -= 1) {
        const month = new Date(now.getFullYear(), now.getMonth() - back, 1);
        buckets.push({
          key: `${month.getFullYear()}-${month.getMonth()}`,
          label: month.toLocaleDateString('en-US', { month: 'short' }),
          title: month.toLocaleDateString('en-US', { month: 'long', year: 'numeric' }),
          lost: 0,
          found: 0
        });
      }
      const byKey = new Map(buckets.map(bucket => [bucket.key, bucket]));
      items.forEach(item => {
        const time = itemTime(item);
        if (!time || (item.type !== 'lost' && item.type !== 'found')) return;
        const date = new Date(time);
        const bucket = byKey.get(`${date.getFullYear()}-${date.getMonth()}`);
        if (bucket) bucket[item.type] += 1;
      });
      return buckets;
    }

    // Counts per week for the last eight weeks, oldest first, for the tile sparklines.
    function weeklyCounts(times, weeks = 8) {
      const now = Date.now();
      const counts = new Array(weeks).fill(0);
      times.forEach(time => {
        const age = now - time;
        if (!time || age < 0 || age >= weeks * 7 * DAY_MS) return;
        counts[weeks - 1 - Math.floor(age / (7 * DAY_MS))] += 1;
      });
      return counts;
    }

    // A quiet line in a neutral colour; only the newest week wears the tile's colour.
    function sparkline(values) {
      const width = 88;
      const height = 28;
      const pad = 4;
      const peak = Math.max(1, ...values);
      const points = values.map((value, index) => [
        pad + index * (width - pad * 2) / (values.length - 1),
        height - pad - value / peak * (height - pad * 2)
      ].map(number => number.toFixed(1)));
      const last = points[points.length - 1];
      return `<svg class="spark" viewBox="0 0 ${width} ${height}" aria-hidden="true" focusable="false"><polyline points="${points.map(point => point.join(',')).join(' ')}"/><circle cx="${last[0]}" cy="${last[1]}" r="3.5"/></svg>`;
    }

    // Rolling windows for the dashboard's date-range filter. It only scopes the
    // resolution-rate card and the top-categories/top-locations lists, which otherwise
    // average over every report ever filed; the KPI tiles, trend chart and queues below
    // stay on their own fixed windows.
    const DASHBOARD_RANGE_MS = { week: 7 * DAY_MS, month: 30 * DAY_MS, quarter: 90 * DAY_MS, all: Infinity };
    const DASHBOARD_RANGE_LABEL = { week: 'the last 7 days', month: 'the last 30 days', quarter: 'the last 90 days', all: '' };

    function setDashboardRange(range) {
      dashboardRange = DASHBOARD_RANGE_MS[range] ? range : 'all';
      document.querySelectorAll('#dashRangeSeg [data-range]').forEach(button => {
        const on = button.dataset.range === dashboardRange;
        button.classList.toggle('active', on);
        button.setAttribute('aria-pressed', String(on));
      });
      renderDashboard(adminItems);
    }

    function itemsInDashboardRange(items) {
      const windowMs = DASHBOARD_RANGE_MS[dashboardRange];
      if (!Number.isFinite(windowMs)) return items;
      const now = Date.now();
      return items.filter(item => {
        const time = itemTime(item);
        return time && now - time <= windowMs;
      });
    }

    // New items in the last 30 days compared with the 30 days before that.
    function periodChange(times) {
      const now = Date.now();
      const current = times.filter(time => time && now - time <= 30 * DAY_MS).length;
      const previous = times.filter(time => time && now - time > 30 * DAY_MS && now - time <= 60 * DAY_MS).length;
      const diff = current - previous;
      return { current, text: diff === 0 ? 'Same as prior 30 days' : `${diff > 0 ? '+' : '−'}${Math.abs(diff)} vs prior 30 days` };
    }

    function setLiveStatus(online) {
      const box = document.getElementById('liveStatus');
      if (!box) return;
      box.classList.toggle('is-offline', !online);
      document.getElementById('liveText').textContent = online
        ? `Live · updated ${new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`
        : 'Offline · showing the last data';
    }

    // The first time the dashboard fills in, tiles rise in, bars grow and numbers count up.
    // Later refreshes (every few seconds) update silently. Skipped for reduced motion.
    let dashboardIntroDone = false;
    function playDashboardIntro() {
      if (dashboardIntroDone) return;
      dashboardIntroDone = true;
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
      const root = document.getElementById('tabDashboard');
      root.classList.add('intro');
      window.setTimeout(() => root.classList.remove('intro'), 1800);
      document.querySelectorAll('#kpiRow [data-count]').forEach(element => {
        const target = Number(element.dataset.count);
        if (!Number.isFinite(target) || target < 1) return;
        const start = performance.now();
        const tick = now => {
          const progress = Math.min(1, (now - start) / 800);
          element.textContent = String(Math.round(target * (1 - Math.pow(1 - progress, 3))));
          if (progress < 1) window.requestAnimationFrame(tick);
        };
        element.textContent = '0';
        window.requestAnimationFrame(tick);
      });
    }

    function setCount(id, value) {
      const element = document.getElementById(id);
      element.textContent = value > 99 ? '99+' : String(value);
      element.hidden = !value;
    }

    function renderAdminPanel(items = adminItems) {
      adminItems = items;
      renderDashboard(items);
      renderClaimQueue();
      renderItemsTable();
    }

    function renderDashboard(items) {
      const now = Date.now();
      const pending = claimRequests.filter(claim => claim.status === 'pending');
      const lost = items.filter(item => item.type === 'lost');
      const found = items.filter(item => item.type === 'found');
      const openLost = lost.filter(isOpenItem).length;
      const openFound = found.filter(isOpenItem).length;
      const resolved = items.filter(isResolved).length;
      const counted = items.filter(item => item.status !== 'archived').length;
      const rate = counted ? Math.round(resolved / counted * 100) : 0;
      const oldest = pending.reduce((first, claim) => (!first || Date.parse(claim.createdAt) < Date.parse(first.createdAt) ? claim : first), null);

      // Resolution rate, top categories and top locations respect the date-range picker;
      // everything else above keeps using the full, unscoped `items`.
      const rangeItems = itemsInDashboardRange(items);
      const rangeResolved = rangeItems.filter(isResolved).length;
      const rangeCounted = rangeItems.filter(item => item.status !== 'archived').length;
      const rangeRate = rangeCounted ? Math.round(rangeResolved / rangeCounted * 100) : 0;
      const rangeSuffix = DASHBOARD_RANGE_LABEL[dashboardRange] ? ` · ${DASHBOARD_RANGE_LABEL[dashboardRange]}` : '';
      document.getElementById('rateSubtitle').textContent = `Reports that ended with the item returned${rangeSuffix}`;
      document.getElementById('catSubtitle').textContent = `Most reported kinds of items${rangeSuffix}`;
      document.getElementById('locSubtitle').textContent = `Offices and areas with the most reports${rangeSuffix}`;

      const lostTimes = lost.map(itemTime);
      const foundTimes = found.map(itemTime);
      const lostChange = periodChange(lostTimes);
      const foundChange = periodChange(foundTimes);
      const resolvedTimes = items.filter(isResolved).map(item => Date.parse(item.claimedAt) || 0);
      const claimTimes = claimRequests.map(claim => Date.parse(claim.createdAt) || 0);

      const tile = (kind, icon, label, value, sub, action, args, trend) => `
        <button type="button" class="kpi kpi--${kind}" data-action="${action}" data-args='${args}'>
          <span class="kpi-top"><span class="kpi-label">${label}</span><span class="kpi-chip" aria-hidden="true"><svg class="ico"><use href="#i-${icon}"/></svg></span></span>
          <span class="kpi-mid"><span class="kpi-value" data-count="${value}">${value}</span>${sparkline(trend)}</span>
          <span class="kpi-sub">${sub}</span>
        </button>`;
      const subLines = (first, second) => `<span>${first}</span>${second ? `<span class="kpi-delta">${second}</span>` : ''}`;
      const kpiRow = document.getElementById('kpiRow');
      kpiRow.removeAttribute('aria-busy');
      kpiRow.innerHTML =
        tile('lost', 'search', 'Open lost reports', openLost, subLines(`${lostChange.current} new in 30 days`, lostChange.text), 'showAdminItems', '["lost"]', weeklyCounts(lostTimes)) +
        tile('found', 'found', 'Open found reports', openFound, subLines(`${foundChange.current} new in 30 days`, foundChange.text), 'showAdminItems', '["found"]', weeklyCounts(foundTimes)) +
        tile('claims', 'shield', 'Claims to review', pending.length, subLines(oldest ? `Oldest: ${escHtml(relativeTime(oldest.createdAt))}` : 'Nothing waiting', ''), 'showAdminView', '["claims"]', weeklyCounts(claimTimes)) +
        tile('returned', 'box', 'Resolved reports', resolved, subLines(`${rate}% of all reports`, ''), 'showAdminItems', '["", "claimed"]', weeklyCounts(resolvedTimes));

      const banner = document.getElementById('attentionBanner');
      banner.hidden = !pending.length;
      if (pending.length) {
        banner.querySelector('strong').textContent = `${pending.length} claim${pending.length === 1 ? ' is' : 's are'} waiting for review`;
        banner.querySelector('small').textContent = oldest ? `The oldest was submitted ${relativeTime(oldest.createdAt)}.` : '';
      }

      const resolveDays = rangeItems.filter(isResolved)
        .map(item => (Date.parse(item.claimedAt) - itemTime(item)) / DAY_MS)
        .filter(days => Number.isFinite(days) && days >= 0);
      const averageDays = resolveDays.length ? resolveDays.reduce((sum, days) => sum + days, 0) / resolveDays.length : null;
      const longestOpen = rangeItems.filter(isOpenItem).filter(item => itemTime(item)).sort((a, b) => itemTime(a) - itemTime(b))[0];
      const longestDays = longestOpen ? Math.floor((now - itemTime(longestOpen)) / DAY_MS) : null;
      const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;

      renderTrendChart(items);

      document.getElementById('claimMeter').innerHTML = `
        <div class="meter-head"><span class="meter-value">${rangeRate}%</span><span class="meter-caption">of reports resolved</span></div>
        <div class="meter-track" role="progressbar" aria-label="Resolved reports" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${rangeRate}"><i style="width:${rangeRate}%"></i></div>
        <dl class="meter-facts">
          <div><dt>Active</dt><dd>${rangeItems.filter(isOpenItem).length}</dd></div>
          <div><dt>Resolved</dt><dd>${rangeResolved}</dd></div>
          <div><dt>Archived</dt><dd>${rangeItems.length - rangeCounted}</dd></div>
        </dl>
        <ul class="metric-list">
          <li><span>Average time to resolve</span><b>${averageDays === null ? 'Not enough data' : plural(Math.round(averageDays * 10) / 10, 'day')}</b></li>
          <li><span>Longest open report</span><b${longestOpen ? ` title="${escHtml(longestOpen.title)}"` : ''}>${longestDays === null ? 'None open' : plural(longestDays, 'day')}</b></li>
        </ul>`;

      renderRankList('topCategories', countValues(rangeItems, 'category').slice(0, 5));
      renderRankList('topLocations', countValues(rangeItems, officeOf).slice(0, 5));

      const waiting = [...pending].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt)).slice(0, 5);
      document.getElementById('dashClaims').innerHTML = waiting.length
        ? `<ul class="feed">${waiting.map(claim => `
          <li class="feed-row">
            <div class="feed-main"><strong title="${escHtml(claim.itemTitle || 'Item')}">${escHtml(claim.itemTitle || 'Item')}</strong><small>${escHtml(claim.claimantName || 'Unknown claimant')} · ${escHtml(relativeTime(claim.createdAt))}</small></div>
            <button type="button" class="action-btn action-btn-claim" data-action="openClaimReview" data-args="${actionArgs(claim.id)}">Review</button>
          </li>`).join('')}</ul>`
        : '<p class="feed-empty"><svg class="ico" aria-hidden="true"><use href="#i-found"/></svg>All caught up. No claims are waiting.</p>';

      const latest = [...items].sort((a, b) => itemTime(b) - itemTime(a)).slice(0, 5);
      document.getElementById('dashRecent').innerHTML = latest.length
        ? `<ul class="feed">${latest.map(item => `
          <li class="feed-row">
            <span class="badge ${item.type === 'lost' ? 'badge-lost' : 'badge-found'}">${escHtml(item.type)}</span>
            <div class="feed-main"><strong title="${escHtml(item.title)}">${escHtml(item.title)}</strong><small>${escHtml(officeOf(item))} · ${escHtml(relativeTime(item.createdAt || item.date))}</small></div>
          </li>`).join('')}</ul>`
        : '<p class="feed-empty">No reports yet.</p>';

      setCount('countLost', openLost);
      setCount('countFound', openFound);
      setCount('countClaims', pending.length);
      setCount('bellCount', pending.length);
      renderNotifications(pending);
      document.getElementById('adminBell').setAttribute('aria-label', pending.length ? `${pending.length} claim${pending.length === 1 ? '' : 's'} waiting for review` : 'No claims waiting for review');
      document.getElementById('segPending').textContent = pending.length ? `(${pending.length})` : '';
      playDashboardIntro();
    }

    function renderRankList(id, entries) {
      const container = document.getElementById(id);
      if (!entries.length) {
        container.innerHTML = '<p class="viz-empty">No data yet.</p>';
        return;
      }
      const peak = entries[0][1];
      container.innerHTML = entries.map(([label, count]) => `
        <div class="rank-row">
          <span class="rank-label" title="${escHtml(label)}">${escHtml(label)}</span>
          <span class="rank-track"><i style="--w:${(count / peak).toFixed(3)}"></i><b>${count}</b></span>
        </div>`).join('');
    }

    function renderTrendChart(items) {
      const buckets = buildMonthlyTrend(items);
      const plot = document.getElementById('trendPlot');
      document.getElementById('trendTip').hidden = true;
      // The same numbers as a table, for screen readers and anyone who prefers one.
      document.getElementById('trendTable').innerHTML = `
        <table class="trend-table">
          <thead><tr><th>Month</th><th>Lost</th><th>Found</th><th>Total</th></tr></thead>
          <tbody>${buckets.map(bucket => `<tr><td>${escHtml(bucket.title)}</td><td>${bucket.lost}</td><td>${bucket.found}</td><td>${bucket.lost + bucket.found}</td></tr>`).join('')}</tbody>
        </table>`;

      const peak = Math.max(0, ...buckets.map(bucket => Math.max(bucket.lost, bucket.found)));
      if (!peak) {
        plot.innerHTML = '<p class="viz-empty">No reports in the last six months.</p>';
        return;
      }
      const { step, max } = niceScale(peak);
      const ticks = [];
      for (let value = 0; value <= max; value += step) ticks.push(value);
      // Only the newest month prints its numbers; the tooltip and table carry the rest.
      const column = (type, value, newest) => `<span class="trend-col trend-col--${type}" style="--h:${(value / max * 100).toFixed(2)}${value ? ';min-height:3px' : ''}">${newest && value ? `<b>${value}</b>` : ''}</span>`;
      const months = buckets.map((bucket, index) => `
        <div class="trend-month" style="--i:${index}" tabindex="0" role="img" aria-label="${escHtml(bucket.title)}: ${bucket.lost} lost, ${bucket.found} found" data-title="${escHtml(bucket.title)}" data-lost="${bucket.lost}" data-found="${bucket.found}">
          ${column('lost', bucket.lost, index === buckets.length - 1)}${column('found', bucket.found, index === buckets.length - 1)}
        </div>`).join('');
      plot.innerHTML = `
        <div class="trend-chart" style="--n:${buckets.length}">
          <div class="trend-area">
            ${ticks.map(value => `<div class="trend-tick${value === 0 ? ' trend-tick--base' : ''}" style="--p:${(value / max * 100).toFixed(2)}"><span>${value}</span></div>`).join('')}
            <div class="trend-groups">${months}</div>
          </div>
          <div class="trend-labels">${buckets.map(bucket => `<span>${escHtml(bucket.label)}</span>`).join('')}</div>
        </div>`;
    }

    // One tooltip for the whole chart; each month is a hover and keyboard target.
    function bindTrendTooltip() {
      const wrap = document.getElementById('trendWrap');
      const tip = document.getElementById('trendTip');
      let active = null;
      const hide = () => {
        tip.hidden = true;
        if (active) active.classList.remove('is-active');
        active = null;
      };
      const show = month => {
        if (month === active) return;
        if (active) active.classList.remove('is-active');
        active = month;
        month.classList.add('is-active');
        tip.innerHTML = `<strong>${escHtml(month.dataset.title)}</strong>`
          + `<div><i class="sw sw--lost" aria-hidden="true"></i>Lost<b>${escHtml(month.dataset.lost)}</b></div>`
          + `<div><i class="sw sw--found" aria-hidden="true"></i>Found<b>${escHtml(month.dataset.found)}</b></div>`;
        tip.hidden = false;
        const wrapBox = wrap.getBoundingClientRect();
        const box = month.getBoundingClientRect();
        const area = wrap.querySelector('.trend-area');
        // Beside the month, so it never sits on top of the columns being read.
        let left = box.right - wrapBox.left + 8;
        if (left + tip.offsetWidth > wrapBox.width) left = box.left - wrapBox.left - tip.offsetWidth - 8;
        tip.style.left = `${Math.max(0, left)}px`;
        tip.style.top = `${(area ? area.getBoundingClientRect().top - wrapBox.top : 0) + 8}px`;
      };
      wrap.addEventListener('mouseover', event => {
        const month = event.target.closest('.trend-month');
        if (month) show(month); else hide();
      });
      wrap.addEventListener('mouseleave', hide);
      wrap.addEventListener('focusin', event => {
        const month = event.target.closest('.trend-month');
        if (month) show(month);
      });
      wrap.addEventListener('focusout', hide);
      document.addEventListener('click', event => { if (!event.target.closest('.trend-month')) hide(); });
      document.addEventListener('keydown', event => { if (event.key === 'Escape') hide(); });
    }

    function toggleTrendTable(button) {
      const showTable = button.getAttribute('aria-pressed') !== 'true';
      button.setAttribute('aria-pressed', String(showTable));
      button.textContent = showTable ? 'View as chart' : 'View as table';
      document.getElementById('trendPlot').hidden = showTable;
      document.getElementById('trendTable').hidden = !showTable;
      document.getElementById('trendTip').hidden = true;
    }

    // ── Claim verification queue ─────────────────────────────────────────────
    function setClaimsFilter(filter) {
      adminClaimsFilter = filter === 'all' ? 'all' : 'pending';
      document.querySelectorAll('[data-claims-filter]').forEach(button => {
        const on = button.dataset.claimsFilter === adminClaimsFilter;
        button.classList.toggle('active', on);
        button.setAttribute('aria-pressed', String(on));
      });
      renderClaimQueue();
    }

    function renderClaimQueue() {
      const body = document.getElementById('adminClaimsBody');
      const empty = document.getElementById('adminClaimsEmptyState');
      if (!body || !empty) return;
      const claims = adminClaimsFilter === 'pending'
        ? claimRequests.filter(claim => claim.status === 'pending').sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
        : claimRequests.slice();
      empty.hidden = claims.length > 0;
      empty.querySelector('h3').textContent = adminClaimsFilter === 'pending' ? 'No claims waiting' : 'No claims yet';
      body.innerHTML = claims.map(claim => {
        const status = claim.status === 'pending'
          ? '<span class="badge admin-status-pending">Pending</span>'
          : claim.status === 'approved'
            ? '<span class="badge badge-claimed">Approved</span>'
            : '<span class="badge admin-status-rejected">Rejected</span>';
        const action = claim.status === 'pending'
          ? `<button type="button" class="action-btn action-btn-claim" data-action="openClaimReview" data-args="${actionArgs(claim.id)}">Review claim</button>`
          : `<small>${claim.reviewedAt ? `Reviewed ${escHtml(formatDate(claim.reviewedAt))}` : ''}</small>`;
        return `
        <tr>
          <td class="td-title">${escHtml(claim.itemTitle || 'Item')}<small>${escHtml(claim.itemRefCode || '')}</small></td>
          <td>${escHtml(claim.claimantName || 'Unknown')}<small>${escHtml(claim.claimantEmail || '')}</small></td>
          <td>${escHtml(formatDate(claim.createdAt))}</td>
          <td>${status}</td>
          <td>${action}</td>
        </tr>`;
      }).join('');
    }

    // key is a property name, or a function that reads the label from an item.
    function countValues(items, key) {
      const read = typeof key === 'function' ? key : item => item[key];
      const counts = new Map();
      items.forEach(item => {
        const label = read(item) || 'Unknown';
        counts.set(label, (counts.get(label) || 0) + 1);
      });
      return [...counts.entries()].sort((a, b) => b[1] - a[1]);
    }

    function openAdminLogoutModal() {
      document.getElementById('adminLogoutModal').classList.add('open');
    }

    function closeAdminLogoutModal() {
      document.getElementById('adminLogoutModal').classList.remove('open');
    }

    async function confirmAdminLogout() {
      const button = document.getElementById('confirmAdminLogoutBtn');
      button.disabled = true;
      try {
        const response = await adminFetch('/api/auth/logout', {
          method: 'POST',
        });
        if (!response.ok) throw new Error('Logout request failed.');
        window.location.href = '/login';
      } catch (error) {
        button.disabled = false;
        showToast('Unable to log out. Please try again.', 'error');
      }
    }

    function renderItemsTable() {
      let items = getFilteredAdminItems();

      items.sort((a, b) => {
        const left = ['status', 'category'].includes(adminSort.key) ? (a[adminSort.key] || '') : new Date(a.createdAt || a.date).getTime();
        const right = ['status', 'category'].includes(adminSort.key) ? (b[adminSort.key] || '') : new Date(b.createdAt || b.date).getTime();
        const comparison = typeof left === 'string' ? left.localeCompare(right) : left - right;
        return adminSort.direction === 'asc' ? comparison : -comparison;
      });

      const tbody = document.getElementById('adminTableBody');
      const empty = document.getElementById('adminEmptyState');
      const totalItems = items.length;
      const totalPages = Math.ceil(totalItems / adminItemsPerPage);
      adminCurrentPage = totalPages ? Math.min(adminCurrentPage, totalPages) : 1;
      const startIndex = (adminCurrentPage - 1) * adminItemsPerPage;
      const pageItems = items.slice(startIndex, startIndex + adminItemsPerPage);
      visibleAdminItems = pageItems;
      renderItemsPagination(totalItems, totalPages, startIndex);

      if (totalItems === 0) {
        tbody.innerHTML = '';
        empty.style.display = 'block';
        updateBulkToolbar();
        return;
      }
      empty.style.display = 'none';

      tbody.innerHTML = pageItems.map((item, idx) => {
        const date = item.type === 'lost' ? formatDate(item.dateLost) : formatDate(item.dateFound);
        const canClaim   = item.status !== 'claimed' && item.status !== 'archived';
        const canRestore = item.status === 'claimed' || item.status === 'archived';
        const itemClaims = claimRequests.filter(claim => String(claim.itemId) === String(item.id));
        const pendingClaim = itemClaims.find(claim => claim.status === 'pending');
        const latestClaim = itemClaims[0];
        const itemStatus = item.status === 'archived'
          ? '<span class="badge badge-archived">Archived</span>'
          : item.claimed || item.status === 'claimed'
          ? '<span class="badge badge-claimed">Claimed</span>'
          : pendingClaim
            ? '<span class="badge admin-status-pending">Pending</span>'
            : latestClaim?.status === 'rejected'
              ? '<span class="badge admin-status-rejected">Rejected · Available</span>'
              : statusBadge(item.status);
            const reporterValues = [...new Set([item.reporterName, item.reporterContact].filter(value => value && value !== '—'))];
        const rowNumber = startIndex + idx + 1;
        return `
        <tr>
          <td title="${rowNumber}"><span class="table-select-cell"><input class="admin-checkbox item-select" type="checkbox" data-item-id="${escHtml(item.id)}" ${selectedItemIds.has(String(item.id)) ? 'checked' : ''} aria-label="Select ${escHtml(item.title)}" /><span>${rowNumber}</span></span></td>
          <td class="td-title item-title-cell" title="${escHtml(item.title)}">
            ${escHtml(item.title)}
          </td>
          <td title="${escHtml(item.type)}"><span class="badge ${item.type === 'lost' ? 'badge-lost' : 'badge-found'}">${escHtml(item.type)}</span></td>
          <td title="${escHtml(item.category)}">${escHtml(item.category)}</td>
          <td class="location-cell" title="${escHtml(item.location)}">${escHtml(item.location)}</td>
          <td class="reporter-cell" title="${escHtml(reporterValues.join(' · ') || '—')}">${reporterValues.length
            ? reporterValues.map((value, index) => `<span class="admin-cell-wrap${index ? ' reporter-contact' : ''}">${escHtml(value)}</span>`).join('')
            : '—'}</td>
          <td title="${escHtml(date)}">${date}</td>
          <td class="status-cell" title="${pendingClaim ? 'Pending verification: a claim is waiting for review' : latestClaim?.status === 'rejected' && !item.claimed ? 'Rejected · Available' : escHtml(item.status)}">${itemStatus}</td>
          <td class="actions-cell">
            <div class="action-buttons">
              ${pendingClaim ? `<button class="action-btn action-btn-claim" data-action="openClaimReview" data-args="${actionArgs(pendingClaim.id)}">Review Claim</button>` : ''}
              ${canRestore ? `<button class="action-btn action-btn-restore" data-action="openRestoreModal" data-args="${actionArgs(item.id, item.status)}">Restore</button>` : ''}
              <button class="action-btn action-btn-delete" data-action="openDeleteModal" data-args="${actionArgs(item.id, item.title, reporterValues[0] || 'Unknown reporter')}">Delete</button>
            </div>
          </td>
        </tr>`;
      }).join('');
      tbody.querySelectorAll('.item-select').forEach(input => input.addEventListener('change', () => {
        const id = String(input.dataset.itemId);
        if (input.checked) selectedItemIds.add(id); else selectedItemIds.delete(id);
        updateBulkToolbar();
      }));
      updateBulkToolbar();
    }

    function getFilteredAdminItems() {
      let items = adminItems.slice();
      const query = document.getElementById('adminSearch').value.toLowerCase().trim();
      const type = adminTypeFilter;
      const status = document.getElementById('adminFilterStatus').value;
      const dateRange = document.getElementById('adminFilterDate').value;

      if (query) items = items.filter(item =>
        (item.title || '').toLowerCase().includes(query) ||
        (item.reporterName || '').toLowerCase().includes(query) ||
        (item.reporterContact || '').toLowerCase().includes(query) ||
        (item.reporterEmail || '').toLowerCase().includes(query) ||
        (item.category || '').toLowerCase().includes(query) ||
        (item.location || '').toLowerCase().includes(query) ||
        (item.desc || '').toLowerCase().includes(query)
      );
      if (type) items = items.filter(item => item.type === type);
      if (status) items = items.filter(item => item.status === status || (['lost', 'found'].includes(status) && item.type === status));
      if (dateRange) {
        const now = new Date();
        const start = new Date(now);
        if (dateRange === 'today') start.setHours(0, 0, 0, 0);
        if (dateRange === 'week') start.setDate(now.getDate() - 7);
        if (dateRange === 'month') start.setMonth(now.getMonth() - 1);
        items = items.filter(item => new Date(item.createdAt || item.date).getTime() >= start.getTime());
      }
      return items;
    }

    function renderItemsPagination(totalItems, totalPages, startIndex) {
      const summary = document.getElementById('paginationSummary');
      const controls = document.getElementById('paginationControls');
      const firstItem = totalItems ? startIndex + 1 : 0;
      const lastItem = totalItems ? Math.min(startIndex + adminItemsPerPage, totalItems) : 0;
      summary.textContent = `Showing ${firstItem} to ${lastItem} of ${totalItems} entries`;

      if (totalPages <= 1) {
        controls.innerHTML = '';
        return;
      }

      const pageButtons = Array.from({ length: totalPages }, (_, index) => {
        const page = index + 1;
        const active = page === adminCurrentPage;
        return `<button type="button" class="pagination-button${active ? ' active' : ''}" data-action="changeAdminItemsPage" data-args="${actionArgs(page)}" aria-label="Page ${page}"${active ? ' aria-current="page"' : ''}>${page}</button>`;
      }).join('');

      controls.innerHTML = `
        <button type="button" class="pagination-button" data-action="changeAdminItemsPage" data-args="${actionArgs(adminCurrentPage - 1)}" ${adminCurrentPage === 1 ? 'disabled' : ''}>Previous</button>
        ${pageButtons}
        <button type="button" class="pagination-button" data-action="changeAdminItemsPage" data-args="${actionArgs(adminCurrentPage + 1)}" ${adminCurrentPage === totalPages ? 'disabled' : ''}>Next</button>`;
    }

    function changeAdminItemsPage(page) {
      const totalPages = Math.max(1, Math.ceil(getFilteredAdminItems().length / adminItemsPerPage));
      adminCurrentPage = Math.max(1, Math.min(Number(page) || 1, totalPages));
      renderItemsTable();
    }

    async function updateItemClaimStatus(id, proof = '') {
      try {
        const response = await adminFetch(`/api/items/${encodeURIComponent(id)}/claim`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ proof })
        });
        const data = await response.json();
        if (!response.ok || !data.success) throw new Error(data.message || 'Unable to update item status.');
        await refreshAdminItems();
        showToast(data.message);
        return true;
      } catch (error) {
        showToast(error.message, 'error');
        return false;
      }
    }

    async function updateItemStatus(id, status) {
      try {
        const response = await adminFetch(`/api/items/${encodeURIComponent(id)}/status`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status }) });
        const data = await response.json();
        if (!response.ok || !data.success) throw new Error(data.message || 'Unable to update item status.');
        await refreshAdminItems();
        showToast(data.message);
        return true;
      } catch (error) { showToast(error.message, 'error'); return false; }
    }

    function markClaimed(id) {
      updateItemClaimStatus(id, 'Verified by moderator during campus handoff.');
    }

    function markRestore(id, status = 'claimed') {
      if (status === 'archived') return updateItemStatus(id, 'active');
      return updateItemClaimStatus(id);
    }

    function openRestoreModal(id, status = 'claimed') {
      const item = adminItems.find(entry => String(entry.id) === String(id));
      restoreTarget = { id, status };
      const title = item?.title || 'this item';
      const message = status === 'archived'
        ? `Restore "${title}" from the archive? It will become active again.`
        : `Restore "${title}" and remove its claimed status?`;
      document.getElementById('restoreMsg').textContent = message;
      document.getElementById('restoreModal').classList.add('open');
    }

    function closeRestoreModal() {
      document.getElementById('restoreModal').classList.remove('open');
      restoreTarget = null;
    }

    async function confirmRestore() {
      if (!restoreTarget) return;
      const button = document.getElementById('confirmRestore');
      const target = restoreTarget;
      button.disabled = true;
      try {
        if (await markRestore(target.id, target.status)) closeRestoreModal();
      } finally {
        button.disabled = false;
      }
    }

    function openDeleteModal(id, title, reporter = 'Unknown reporter') {
      deleteTargetId = id;
      document.getElementById('deleteMsg').textContent =
        `Delete "${title}" reported by ${reporter}? This action cannot be undone.`;
      document.getElementById('deleteModal').classList.add('open');
    }
    function closeDeleteModal() {
      document.getElementById('deleteModal').classList.remove('open');
      deleteTargetId = null;
    }
    async function doDelete() {
      if (!deleteTargetId) return;

      const id = deleteTargetId;
      const button = document.getElementById('confirmDelete');
      button.disabled = true;
      try {
        const response = await adminFetch(`/api/items/${encodeURIComponent(id)}`, {
          method: 'DELETE',
        });
        const data = await response.json();
        if (!response.ok && response.status !== 404) {
          throw new Error(data.message || 'Unable to delete item. Please try again.');
        }

        closeDeleteModal();
        await refreshAdminItems();
        await refreshStudentBelongings();
        showToast('Item permanently deleted.');
      } catch (error) {
        showToast(error.message || 'Unable to delete item. Please try again.', 'error');
      } finally {
        button.disabled = false;
      }
    }

    function openClaimReview(id) {
      const claim = claimRequests.find(entry => entry.id === id);
      const item = adminItems.find(entry => String(entry.id) === String(claim?.itemId));
      if (!claim || !item) {
        showToast('Claim or item details are unavailable. Refresh and try again.', 'error');
        return;
      }

      activeClaimReviewId = id;
      const approveButton = document.getElementById('claimApproveButton');
      const rejectButton = document.getElementById('claimRejectButton');
      approveButton.textContent = 'Approve Claim';
      approveButton.onclick = () => prepareClaimDecision('approved');
      approveButton.hidden = false;
      rejectButton.textContent = 'Reject Claim';
      rejectButton.onclick = () => prepareClaimDecision('rejected');
      rejectButton.hidden = false;

      document.getElementById('claimReviewTitle').textContent = `Verify Claim Request - ${item.id}`;
      const proofImage = /^\/uploads\/[a-zA-Z0-9._-]+$/.test(claim.proof || '')
        ? `<img src="${escHtml(claim.proof)}" alt="Claimant proof image" />`
        : '';
      document.getElementById('claimReviewContent').innerHTML = `
        <div class="claim-review-grid">
          <section class="claim-review-section">
            <h3>Claimant Details</h3>
            <p><strong>Student Name:</strong> ${escHtml(claim.claimantName || 'Not provided')}</p>
            <p><strong>Student ID Number:</strong> ${escHtml(claim.claimantStudentId || 'Not provided')}</p>
            <p><strong>Email:</strong> ${escHtml(claim.claimantEmail || 'Not provided')}</p>
            <p><strong>Contact Number:</strong> ${escHtml(claim.claimantContact || 'Not provided')}</p>
            <p><strong>Course &amp; Year:</strong> ${escHtml(claim.claimantCourseYear || 'Not provided')}</p>
            <p><strong>Department:</strong> ${escHtml(claim.claimantDepartment || 'Not provided')}</p>
          </section>
          <section class="claim-review-section">
            <h3>Public Item Details</h3>
            <p><strong>Item:</strong> ${escHtml(item.title)}</p>
            <p><strong>Type / Category:</strong> ${escHtml(item.type)} / ${escHtml(item.category)}</p>
            <p><strong>Location:</strong> ${escHtml(item.location)}</p>
            <p><strong>Description:</strong> ${escHtml(item.desc || item.description || 'No description provided.')}</p>
            ${item.photo ? `<img src="${escHtml(item.photo)}" alt="Reported item" />` : ''}
          </section>
          <section class="claim-review-section">
            <h3>Claimant's Proof / Secret Detail</h3>
            <p>${escHtml(claim.proof || 'No proof detail provided.')}</p>${proofImage}
          </section>
          <section class="claim-review-section">
            <h3>Secret Ownership Detail</h3>
            <p>${escHtml(item.verification || 'No secret ownership detail was provided.')}</p>
          </section>
        </div>`;
      document.getElementById('claimReviewDecisionFields').innerHTML = '';
      document.getElementById('claimReviewModal').classList.add('open');
    }

    function closeClaimReview() {
      document.getElementById('claimReviewModal').classList.remove('open');
      activeClaimReviewId = null;
    }

    function prepareClaimDecision(status) {
      const fields = document.getElementById('claimReviewDecisionFields');
      const approveButton = document.getElementById('claimApproveButton');
      const rejectButton = document.getElementById('claimRejectButton');
      if (status === 'approved') {
        fields.innerHTML = `
          <label for="claimPickupInstructions">Optional pickup instructions</label>
          <textarea class="claim-review-input" id="claimPickupInstructions" rows="2" maxlength="500" placeholder="Please present your CSPC Student ID at the SAS Office, Room 101"></textarea>
          <label for="claimHandoverSignature">Admin handover acknowledgment</label>
          <input class="form-control claim-review-input" id="claimHandoverSignature" maxlength="120" placeholder="Type your full name to acknowledge handover" required />`;
        approveButton.textContent = 'Confirm Approval';
        approveButton.onclick = () => submitClaimDecision('approved');
        rejectButton.hidden = true;
      } else {
        fields.innerHTML = `
          <label for="claimRejectionReason">Reason for rejection</label>
          <textarea class="claim-review-input" id="claimRejectionReason" rows="2" maxlength="500" required placeholder="Proof provided does not match item details"></textarea>`;
        rejectButton.textContent = 'Submit Rejection';
        rejectButton.onclick = () => submitClaimDecision('rejected');
        approveButton.hidden = true;
      }
    }

    async function submitClaimDecision(status) {
      const pickupInstructions = status === 'approved'
        ? document.getElementById('claimPickupInstructions').value.trim()
        : '';
      const handoverSignature = status === 'approved'
        ? document.getElementById('claimHandoverSignature').value.trim()
        : '';
      const rejectionReason = status === 'rejected'
        ? document.getElementById('claimRejectionReason').value.trim()
        : '';
      if (status === 'rejected' && rejectionReason.length < 5) {
        showToast('Enter a rejection reason of at least 5 characters.', 'error');
        return;
      }
      if (status === 'approved' && handoverSignature.length < 2) {
        showToast('Enter your name to acknowledge the physical handover.', 'error');
        return;
      }

      try {
        const response = await adminFetch(`/api/items/claims/${encodeURIComponent(activeClaimReviewId)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status, pickupInstructions, rejectionReason, handoverSignature })
        });
        const data = await response.json();
        if (!response.ok || !data.success) throw new Error(data.message || 'Unable to review claim.');
        closeClaimReview();
        await refreshAdminClaims();
        await refreshAdminItems();
        showToast(data.message);
      } catch (error) {
        showToast(error.message, 'error');
      }
    }

    function toggleSelectAllVisible(event) {
      visibleAdminItems.forEach(item => {
        if (event.currentTarget.checked) selectedItemIds.add(String(item.id));
        else selectedItemIds.delete(String(item.id));
      });
      renderItemsTable();
    }

    function updateBulkToolbar() {
      const count = selectedItemIds.size;
      document.getElementById('selectedItemsCount').textContent = `${count} selected`;
      ['bulkClaimBtn', 'bulkArchiveBtn', 'bulkDeleteBtn', 'exportSelectedBtn'].forEach(id => { document.getElementById(id).disabled = count === 0; });
      const selectAll = document.getElementById('selectAllItems');
      const selectedVisibleCount = visibleAdminItems.filter(item => selectedItemIds.has(String(item.id))).length;
      selectAll.checked = visibleAdminItems.length > 0 && selectedVisibleCount === visibleAdminItems.length;
      selectAll.indeterminate = selectedVisibleCount > 0 && selectedVisibleCount < visibleAdminItems.length;
    }

    function openActionConfirm(title, message) {
      return new Promise(resolve => {
        const modal = document.getElementById('actionConfirmModal');
        const confirmButton = document.getElementById('confirmActionConfirm');
        document.getElementById('actionConfirmTitle').textContent = title;
        document.getElementById('actionConfirmMsg').textContent = message;
        modal.classList.add('open');
        const finish = value => { modal.classList.remove('open'); actionConfirmResolver = null; resolve(value); };
        actionConfirmResolver = () => finish(false);
        confirmButton.onclick = () => finish(true);
        document.getElementById('cancelActionConfirm').onclick = () => finish(false);
      });
    }

    function closeActionConfirm() {
      if (actionConfirmResolver) actionConfirmResolver();
      else document.getElementById('actionConfirmModal').classList.remove('open');
    }

    async function runBulkAction(action) {
      const ids = [...selectedItemIds];
      if (!ids.length) return;
      const actionText = action === 'delete' ? 'delete' : action === 'archive' ? 'archive' : 'mark as claimed';
      if (!await openActionConfirm('Confirm Bulk Action', `Are you sure you want to ${actionText} ${ids.length} selected item(s)?`)) return;
      try {
        const response = await adminFetch('/api/items/bulk', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids, action }) });
        const data = await response.json();
        if (!response.ok || !data.success) throw new Error(data.message || 'Bulk operation failed.');
        ids.forEach(id => selectedItemIds.delete(id));
        await refreshAdminItems();
        await refreshAdminClaims();
        showToast(`${data.affected} item(s) updated.`);
      } catch (error) { showToast(error.message, 'error'); }
    }

    async function sendBroadcast() {
      const subject = document.getElementById('broadcastSubject').value.trim();
      const message = document.getElementById('broadcastMessage').value.trim();
      if (subject.length < 3 || message.length < 5) return showToast('Enter a subject and message first.', 'error');
      if (!await openActionConfirm('Confirm Broadcast', 'Send this announcement to all registered students?')) return;
      const button = document.getElementById('sendBroadcastBtn');
      button.disabled = true;
      try {
        const response = await adminFetch('/api/items/broadcast', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subject, message }) });
        const data = await response.json();
        if (!response.ok || !data.success) throw new Error(data.message || 'Broadcast failed.');
        document.getElementById('broadcastSubject').value = '';
        document.getElementById('broadcastMessage').value = '';
        showToast(`Broadcast sent to ${data.sent} of ${data.recipients} student(s).`);
      } catch (error) { showToast(error.message, 'error'); } finally { button.disabled = false; }
    }

    async function openActivityModal(id) {
      const item = adminItems.find(entry => String(entry.id) === String(id));
      if (!item) return;
      document.getElementById('activityTitle').textContent = `Activity: ${item.title}`;
      document.getElementById('activityNote').dataset.itemId = id;
      document.getElementById('activityNote').value = '';
      document.getElementById('activityContent').innerHTML = '<p>Loading activity…</p>';
      document.getElementById('activityModal').classList.add('open');
      try {
        const response = await adminFetch(`/api/items/${encodeURIComponent(id)}/activity`);
        const data = await response.json();
        document.getElementById('activityContent').innerHTML = data.activity?.length
          ? `<div class="activity-list">${data.activity.map(entry => `<div class="activity-entry"><strong>${escHtml(entry.action)}</strong><span>${escHtml(entry.actorName)} · ${formatDate(entry.timestamp)}</span>${entry.notes ? `<p>${escHtml(entry.notes)}</p>` : ''}</div>`).join('')}</div>`
          : '<p class="activity-empty">No activity recorded yet.</p>';
      } catch (error) { document.getElementById('activityContent').innerHTML = `<p class="activity-empty">${escHtml(error.message)}</p>`; }
    }

    function closeActivityModal() { document.getElementById('activityModal').classList.remove('open'); }

    async function saveActivityNote() {
      const note = document.getElementById('activityNote');
      if (!note.value.trim()) return showToast('Enter a note first.', 'error');
      const response = await adminFetch(`/api/items/${encodeURIComponent(note.dataset.itemId)}/activity`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ notes: note.value.trim() }) });
      const data = await response.json();
      if (!response.ok || !data.success) return showToast(data.message || 'Unable to save note.', 'error');
      note.value = '';
      openActivityModal(note.dataset.itemId);
      showToast('Activity note saved.');
    }

    function exportCSV(selectedIds = null) {
      const items = selectedIds ? adminItems.filter(item => selectedIds.includes(String(item.id))) : adminItems;
      const headers = ['ID','Type','Title','Category','Location','Status','Reporter','Contact','Email','Date Lost/Found','Created At'];
      const rows = items.map(i => [
        i.id, i.type, i.title, i.category, i.location, i.status,
        i.reporterName, i.reporterContact, i.reporterEmail || '',
        i.dateLost || i.dateFound || '', i.createdAt
      ].map(v => `"${String(v || '').replace(/"/g,'""')}"`).join(','));

      const csv = [headers.join(','), ...rows].join('\n');
      const blob = new Blob([csv], { type: 'text/csv' });
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href = url;
      a.download = `cspc-lostfound-${new Date().toISOString().slice(0,10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
      showToast('CSV exported successfully.');
    }
