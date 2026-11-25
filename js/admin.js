let deleteTargetId = null;
let restoreTarget = null;
let blockedEmails = [];
let allowedEmails = [];
let activeTab = 'dashboard';
let dashboardRange = 'all';
let adminItems = [];
let claimRequests = [];
let adminClaimsSignature = null;
let adminRefreshInProgress = false;
let adminItemsSignature = null;
let actionConfirmResolver = null;
let cachedServerItems = [];
const selectedItemIds = new Set();
const BROADCAST_TEMPLATES = [
  {
    id: 'urgent',
    command: '/urgent',
    title: 'Urgent Found Item / ID',
    description: 'Post a quick alert about an item or ID you found.',
    subject: 'Urgent: [Item Name] Found',
    message:
      'Hi! I found [Item Name] near [Location] on [Date]. If it may be yours, reply through Back2You with a detail that confirms ownership. We can arrange a safe handover on campus.',
  },
  {
    id: 'unclaimed',
    command: '/unclaimed',
    title: 'Unclaimed Item Reminder',
    description: 'Let the owner know a found item is still unclaimed.',
    subject: 'Reminder: [Item Name] Is Still Unclaimed',
    message:
      'A [Item Name] found near [Location] on [Date] is still unclaimed. If it belongs to you, message the finder through Back2You with a private identifying detail so you can arrange a safe handover.',
  },
  {
    id: 'lost',
    command: '/lost',
    title: 'Missing Item Alert',
    description: 'Ask the campus community to help find a misplaced item.',
    subject: 'Missing: [Item Name] Last Seen Near [Location]',
    message:
      'I misplaced [Item Name] near [Location] on [Date]. It is [Description]. If you found it, please message me through Back2You and share a detail to help confirm it.',
  },
  {
    id: 'batch',
    command: '/batch',
    title: 'Weekly Unclaimed Summary',
    description: 'Share a roundup of items still waiting to be claimed.',
    subject: 'Weekly Unclaimed Items Summary - [Week of Date]',
    message:
      'These items were reported found this week and are still unclaimed: [List of Items]. If one may be yours, open its listing on Back2You and message the finder with a private identifying detail. Please arrange any handover directly and safely.',
  },
  {
    id: 'safety',
    command: '/safety',
    title: 'Meetup & Claim Reminder',
    description: 'Share a few reminders for a safe, verified handover.',
    subject: 'A Safe Meetup for [Item Name]',
    message:
      'Before meeting about [Item Name], confirm the item details in Back2You messages and agree on a public campus location and time ([Date/Time]). Consider bringing someone you trust. Do not share sensitive information or meet if you feel unsafe.',
  },
];
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
  if (!(await requireAdminSession())) return;
  refreshAdminItems();
  refreshStudentBelongings();
  refreshAdminClaims();
  refreshAdminUsers();
  refreshBlockedEmails();
  refreshAllowedEmails();
  showMessengerConnectBanner();
  window.setInterval(() => {
    refreshAdminItems();
    refreshStudentBelongings();
    refreshAdminClaims();
  }, 20000);

  // Sidebar navigation (the items links carry the lost / found filter)
  document.querySelectorAll('.side-link[data-view]').forEach((link) => {
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
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeSidebar();
  });
  document.querySelectorAll('#dashRangeSeg [data-range]').forEach((button) => {
    button.addEventListener('click', () => setDashboardRange(button.dataset.range));
  });
  // The top-bar search always searches items, so typing there leaves the dashboard.
  document.getElementById('adminSearch').addEventListener('input', () => {
    if (activeTab !== 'items') showAdminItems(adminTypeFilter);
  });
  bindTrendTooltip();
  setupGlobalKeyboardShortcuts();
  window.addEventListener('hashchange', applyAdminHash);
  applyAdminHash();

  // Delete modal controls
  document.getElementById('cancelDelete').addEventListener('click', closeDeleteModal);
  document.getElementById('confirmDelete').addEventListener('click', doDelete);
  document.getElementById('cancelRestore').addEventListener('click', closeRestoreModal);
  document.getElementById('confirmRestore').addEventListener('click', confirmRestore);

  document.getElementById('bulkClaimBtn').addEventListener('click', () => runBulkAction('claim'));
  document.getElementById('bulkArchiveBtn').addEventListener('click', () => runBulkAction('archive'));
  document.getElementById('bulkDeleteBtn').addEventListener('click', () => runBulkAction('delete'));
  document.getElementById('exportSelectedBtn').addEventListener('click', () => exportCSV([...selectedItemIds]));
  setupBroadcastTemplates();
  document.getElementById('sendBroadcastBtn').addEventListener('click', sendBroadcast);
  document.getElementById('cancelActionConfirm').addEventListener('click', closeActionConfirm);
  document.getElementById('openCreateUserBtn').addEventListener('click', () => {
    document.getElementById('userFormPanel').hidden = false;
  });
  document.getElementById('cancelCreateUserBtn').addEventListener('click', closeCreateUserForm);
  document.getElementById('createUserForm').addEventListener('submit', createAdminUser);
  document.querySelector('#createUserForm [name="role"]').addEventListener('change', (event) => {
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
  document.getElementById('blockEmailForm').addEventListener('submit', blockEmail);
  document.getElementById('allowEmailForm').addEventListener('submit', allowEmail);
  document.getElementById('selectAllItems').addEventListener('change', toggleSelectAllVisible);
  document.getElementById('adminFilterDate').addEventListener('change', () => {
    adminCurrentPage = 1;
    renderItemsTable();
  });
  document.querySelectorAll('.sort-button').forEach((button) =>
    button.addEventListener('click', () => {
      const key = button.dataset.sort;
      adminSort =
        adminSort.key === key
          ? { key, direction: adminSort.direction === 'asc' ? 'desc' : 'asc' }
          : { key, direction: 'asc' };
      renderItemsTable();
    })
  );

  // Reactive admin filters
  ['adminSearch', 'adminFilterStatus'].forEach((id) => {
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
  body.innerHTML = adminUsers
    .map(
      (user) => `
        <tr>
          <td>${escHtml(user.fullName || '—')}</td>
          <td>${escHtml(user.email || '—')}</td>
          <td><span class="badge ${user.role === 'admin' ? 'badge-role-admin' : user.role === 'employee' ? 'badge-role-employee' : 'badge-role-student'}">${escHtml(user.role === 'admin' ? 'Admin' : user.role === 'employee' ? 'Employee' : 'Student')}</span></td>
          <td>${escHtml(formatDate(user.createdAt))}</td>
          <td><button type="button" class="action-btn action-btn-delete user-delete-button" data-user-id="${escHtml(user.id)}" data-user-name="${escHtml(user.fullName || user.email)}"${user.id === window.currentAdminUserId ? ' disabled' : ''}>Delete</button></td>
        </tr>`
    )
    .join('');
  body
    .querySelectorAll('.user-delete-button')
    .forEach((button) =>
      button.addEventListener('click', () => openDeleteUserModal(button.dataset.userId, button.dataset.userName))
    );
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
  body.innerHTML = sorted
    .map(
      (entry) => `
        <tr>
          <td>${escHtml(entry.email)}</td>
          <td>${escHtml(formatDate(entry.blockedAt))}</td>
          <td><button type="button" class="action-btn action-btn-restore unblock-email-button" data-email="${escHtml(entry.email)}">Unblock</button></td>
        </tr>`
    )
    .join('');
  body
    .querySelectorAll('.unblock-email-button')
    .forEach((button) => button.addEventListener('click', () => unblockEmail(button.dataset.email)));
}

async function blockEmail(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const submit = form.querySelector('button[type="submit"]');
  submit.disabled = true;
  try {
    const email = new FormData(form).get('email');
    const response = await adminFetch('/api/auth/blocked-emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });
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
  status.textContent =
    allowedEmails.length === 0
      ? 'Empty: every @my.cspc.edu.ph address may register and sign in. Add an email below to restrict access to only approved addresses (administrators can always sign in).'
      : `Restricted: only the ${allowedEmails.length} email(s) below (plus administrators) can register or sign in. Remove all of them to reopen access to everyone.`;
  const sorted = [...allowedEmails].sort((a, b) => new Date(b.addedAt) - new Date(a.addedAt));
  body.innerHTML = sorted
    .map(
      (entry) => `
        <tr>
          <td>${escHtml(entry.email)}</td>
          <td>${escHtml(formatDate(entry.addedAt))}</td>
          <td><button type="button" class="action-btn action-btn-delete remove-allowed-button" data-email="${escHtml(entry.email)}">Remove</button></td>
        </tr>`
    )
    .join('');
  body
    .querySelectorAll('.remove-allowed-button')
    .forEach((button) => button.addEventListener('click', () => removeAllowedEmail(button.dataset.email)));
}

async function allowEmail(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const submit = form.querySelector('button[type="submit"]');
  submit.disabled = true;
  try {
    const email = new FormData(form).get('email');
    const response = await adminFetch('/api/auth/allowed-emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });
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
    const response = await adminFetch('/api/auth/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.fromEntries(new FormData(form))),
    });
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
  document.getElementById('deleteUserMsg').textContent =
    `Are you sure you want to permanently delete ${name}? This action cannot be undone.`;
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
    const response = await adminFetch(`/api/auth/users/${encodeURIComponent(deleteUserTargetId)}`, {
      method: 'DELETE',
    });
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
          cachedServerItems = data.items.filter((item) => item.type !== 'registered').map(normalizeAdminItem);
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
      const existingItemIds = new Set(adminItems.map((item) => String(item.id)));
      selectedItemIds.forEach((id) => {
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
  body.innerHTML = studentBelongings
    .map(
      (item) => `
        <tr>
          <td class="td-title">${escHtml(item.title || 'Untitled belonging')}</td>
          <td>${escHtml(item.ownerName || item.reporterName || item.contact || 'Unknown student')}</td>
          <td>${escHtml(item.category || '—')}</td>
          <td>${escHtml(item.location || '—')}</td>
          <td>${escHtml(item.refCode || '—')}</td>
          <td>${escHtml(formatDate(item.createdAt || item.date))}</td>
          <td class="actions-cell"><button class="action-btn action-btn-delete" data-action="openDeleteModal" data-args="${actionArgs(item.id, item.title || 'this belonging', item.ownerName || 'the registered student')}">Delete</button></td>
        </tr>`
    )
    .join('');
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

// ── Messenger integration ─────────────────────────────────────────────────
async function loadMessengerPanel() {
  const connectionBody = document.getElementById('messengerConnectionBody');
  const diagnosticsBody = document.getElementById('messengerDiagnosticsBody');
  if (!connectionBody || !diagnosticsBody) return;
  connectionBody.textContent = 'Loading…';
  diagnosticsBody.textContent = 'Loading…';

  try {
    const response = await adminFetch('/api/messenger/page/connection', { cache: 'no-store' });
    const data = await response.json();
    renderMessengerConnection(data.success ? data : null);
  } catch (error) {
    connectionBody.textContent = 'Could not load the connection status.';
  }

  try {
    const response = await adminFetch('/api/messenger/diagnostics', { cache: 'no-store' });
    const data = await response.json();
    renderMessengerDiagnostics(data.success ? data : null);
  } catch (error) {
    diagnosticsBody.textContent = 'Could not load diagnostics.';
  }
}

function renderMessengerConnection(data) {
  const body = document.getElementById('messengerConnectionBody');
  if (!data) {
    body.textContent = 'Could not load the connection status.';
    return;
  }

  if (!data.connected) {
    body.innerHTML = `
          <p style="color:var(--text-muted);margin-bottom:.9rem;">No Facebook Page is connected yet. Connect one so students can link Messenger alerts.</p>
          <a class="btn btn-primary" href="/api/messenger/oauth/start">Connect with Facebook</a>
        `;
    return;
  }

  const page = data.page;
  body.innerHTML = `
        <p style="margin-bottom:.35rem;"><strong>${escHtml(page.pageName || 'Connected Page')}</strong> <span style="color:var(--text-muted);">(${escHtml(page.pageId)})</span></p>
        <p style="color:var(--text-muted);margin-bottom:.9rem;">Connected ${escHtml(formatDate(page.connectedAt))}${page.connectedByName ? ` by ${escHtml(page.connectedByName)}` : ''}</p>
        <div style="display:flex;gap:.75rem;">
          <a class="btn btn-outline" href="/api/messenger/oauth/start">Reconnect / switch Page</a>
          <button type="button" class="btn btn-outline" data-action="disconnectMessengerPage">Disconnect</button>
        </div>
      `;
}

function renderMessengerDiagnostics(data) {
  const body = document.getElementById('messengerDiagnosticsBody');
  if (!data) {
    body.textContent = 'Could not load diagnostics.';
    return;
  }

  if (!data.configured) {
    body.innerHTML = `<p style="color:var(--text-muted);">${escHtml(data.error || 'No Messenger Page is connected.')}</p>`;
    return;
  }

  const rows = [
    ['Token valid', data.tokenValid ? '✅ Yes' : `❌ No${data.error ? ` — ${data.error}` : ''}`],
    ['Token type', data.tokenType || '—'],
    ['Scopes granted', (data.scopes || []).join(', ') || '—'],
    ['Can send/receive messages', data.hasMessagingScope ? '✅ Yes (pages_messaging)' : '❌ No'],
    [
      'Webhook subscribed to "messages"',
      data.receivesMessages ? '✅ Yes' : data.subscriptionNote ? `⚠️ ${data.subscriptionNote}` : '❌ No',
    ],
  ];
  body.innerHTML = `
        <table style="width:100%;border-collapse:collapse;">
          <tbody>
            ${rows
              .map(
                ([label, value]) => `
              <tr>
                <td style="padding:.4rem .6rem .4rem 0;color:var(--text-muted);white-space:nowrap;">${escHtml(label)}</td>
                <td style="padding:.4rem 0;word-break:break-word;">${escHtml(value)}</td>
              </tr>`
              )
              .join('')}
          </tbody>
        </table>
      `;
}

async function disconnectMessengerPage() {
  if (
    !window.confirm(
      'Disconnect this Facebook Page? Students will stop receiving Messenger alerts until a Page is connected again.'
    )
  )
    return;
  try {
    const response = await adminFetch('/api/messenger/page/disconnect', { method: 'POST' });
    const data = await response.json();
    if (!response.ok || !data.success) throw new Error(data.message || 'Could not disconnect.');
    showToast('Facebook Page disconnected.');
    loadMessengerPanel();
  } catch (error) {
    showToast(error.message || 'Could not disconnect.', 'error');
  }
}

// Surfaces the result of the Facebook OAuth redirect once, then cleans the URL.
function showMessengerConnectBanner() {
  const params = new URLSearchParams(window.location.search);
  const connected = params.get('connected');
  const connectError = params.get('connectError');
  if (!connected && !connectError) return;
  if (connected) showToast(`Connected to Facebook Page "${connected}".`);
  if (connectError) showToast(connectError, 'error');
  params.delete('connected');
  params.delete('connectError');
  const query = params.toString();
  window.history.replaceState(
    window.history.state,
    '',
    window.location.pathname + (query ? `?${query}` : '') + window.location.hash
  );
}

// ── Views, sidebar and identity ──────────────────────────────────────────
const ADMIN_VIEWS = {
  dashboard: 'tabDashboard',
  items: 'tabItems',
  claims: 'tabClaimQueue',
  broadcast: 'tabBroadcast',
  belongings: 'tabBelongings',
  users: 'tabUsers',
  messenger: 'tabMessenger',
};
const ITEM_HEADINGS = {
  '': ['All items', 'Every lost and found report. Update statuses, review claims or remove reports.'],
  lost: ['Lost items', 'Reports from people who have lost something.'],
  found: ['Found items', 'Reports of items that someone found and handed in.'],
};

function showAdminView(name) {
  if (!ADMIN_VIEWS[name]) name = 'dashboard';
  activeTab = name;
  Object.entries(ADMIN_VIEWS).forEach(([key, id]) => {
    document.getElementById(id).hidden = key !== name;
  });
  syncSidebar();
  if (name === 'users') renderAdminUsers();
  if (name === 'messenger') loadMessengerPanel();
  // The address follows the view so a refresh or a shared link opens the same place.
  // history.state is kept: the dashboard back guard stores its marker there.
  const hash = name === 'items' ? adminTypeFilter || 'items' : name === 'dashboard' ? '' : name;
  try {
    window.history.replaceState(
      window.history.state,
      '',
      window.location.pathname + window.location.search + (hash ? `#${hash}` : '')
    );
  } catch (error) {
    /* ignore */
  }
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
  document.querySelectorAll('.side-link[data-view]').forEach((link) => {
    const active =
      link.dataset.view === activeTab &&
      (link.dataset.view !== 'items' || (link.dataset.adminFilter || '') === adminTypeFilter);
    link.classList.toggle('active', active);
    if (active) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
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
  document.querySelectorAll('.side-link').forEach((link) => {
    // In the icon rail the label is gone, so it moves to a tooltip.
    if (collapsed) link.title = link.querySelector('span').textContent.trim();
    else link.removeAttribute('title');
  });
  if (remember) {
    try {
      localStorage.setItem(SIDEBAR_KEY, collapsed ? '1' : '0');
    } catch (error) {
      /* ignore */
    }
  }
  syncMenuButton();
}

function toggleSidebar() {
  if (isDesktop()) setSidebarCollapsed(!document.getElementById('adminApp').classList.contains('is-collapsed'));
  else openSidebar();
}

function restoreSidebarState() {
  let saved = null;
  try {
    saved = localStorage.getItem(SIDEBAR_KEY);
  } catch (error) {
    /* ignore */
  }
  if (saved === '1') setSidebarCollapsed(true, false);
  else syncMenuButton();
}

// The bell and the profile button each open one small panel; only one is open at a time.
function setupHeaderMenus() {
  const pairs = [
    ['adminBell', 'notifPanel'],
    ['profileBtn', 'profileMenu'],
  ];
  const closeAll = (returnFocus) =>
    pairs.forEach(([buttonId, panelId]) => {
      const panel = document.getElementById(panelId);
      const button = document.getElementById(buttonId);
      if (!panel.hidden && returnFocus) button.focus();
      panel.hidden = true;
      button.setAttribute('aria-expanded', 'false');
    });
  pairs.forEach(([buttonId, panelId]) => {
    const button = document.getElementById(buttonId);
    const panel = document.getElementById(panelId);
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      const opening = panel.hidden;
      closeAll(false);
      panel.hidden = !opening;
      button.setAttribute('aria-expanded', String(opening));
    });
    // Choosing something inside a panel closes it.
    panel.addEventListener('click', (event) => {
      if (event.target.closest('[data-action]')) closeAll(false);
    });
  });
  document.addEventListener('click', (event) => {
    if (!event.target.closest('.pop-wrap')) closeAll(false);
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeAll(true);
  });
}

function setupGlobalKeyboardShortcuts() {
  const search = document.getElementById('adminSearch');
  const navSelectors = [
    '.side-link[data-view="dashboard"]',
    '.side-link[data-view="items"][data-admin-filter="lost"]',
    '.side-link[data-view="items"][data-admin-filter="found"]',
    '.side-link[data-view="items"][data-admin-filter=""]',
    '.side-link[data-view="claims"]',
    '.side-link[data-view="broadcast"]',
    '.side-link[data-view="users"]',
    '.side-link[data-view="belongings"]',
  ];

  document.getElementById('keyboardShortcutsButton').addEventListener('click', openKeyboardShortcuts);
  document.addEventListener('keydown', (event) => {
    if (event.defaultPrevented) return;
    if (event.key === 'Escape') {
      if (document.activeElement === search || event.target === search) {
        event.preventDefault();
        search.blur();
      }
      return;
    }
    if (event.repeat) return;

    const target = event.target;
    const typing =
      target instanceof HTMLElement && (target.matches('input, textarea, select') || target.isContentEditable);
    const hasOpenDialog = document.querySelector('.slip-overlay.open, .del-modal-backdrop.open');
    if (hasOpenDialog) return;

    const broadcastSection = document.getElementById('tabBroadcast');
    if (activeTab === 'broadcast' && broadcastSection.contains(target)) {
      if (event.altKey && !event.ctrlKey && !event.metaKey && /^[1-5]$/.test(event.key)) {
        const option = document.querySelectorAll('#broadcastTemplateMenu [role="menuitem"]')[Number(event.key) - 1];
        if (option) {
          event.preventDefault();
          option.click();
          return;
        }
      }
      if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key === 'Enter') {
        event.preventDefault();
        document.getElementById('sendBroadcastBtn').click();
        return;
      }
    }

    const commandK = (event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'k';
    const searchShortcut =
      commandK ||
      (event.key === '/' && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey && !typing);
    if (searchShortcut) {
      event.preventDefault();
      search.focus();
      search.select();
      return;
    }

    const helpShortcut =
      (event.key === '?' || (event.key === '/' && event.shiftKey)) &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey &&
      !typing;
    if (helpShortcut) {
      event.preventDefault();
      openKeyboardShortcuts();
      return;
    }

    if (event.altKey && !event.ctrlKey && !event.metaKey && /^[1-8]$/.test(event.key)) {
      const link = document.querySelector(navSelectors[Number(event.key) - 1]);
      if (link) {
        event.preventDefault();
        link.click();
      }
      return;
    }

    if (event.altKey && !event.ctrlKey && !event.metaKey && event.key.toLowerCase() === 'e') {
      if (activeTab === 'dashboard') {
        event.preventDefault();
        exportCSV();
      }
      return;
    }

    if (event.key === '[' && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey && !typing) {
      event.preventDefault();
      document.getElementById('sidebarCollapse').click();
    }
  });
}

function openKeyboardShortcuts() {
  const modal = document.getElementById('keyboardShortcutsModal');
  modal.hidden = false;
  modal.classList.add('open');
}

function closeKeyboardShortcuts() {
  const modal = document.getElementById('keyboardShortcutsModal');
  modal.classList.remove('open');
  modal.hidden = true;
}

// The sun / moon switch follows the page theme, including changes made elsewhere.
function setupThemePill() {
  const pill = document.getElementById('themePill');
  const sync = () =>
    pill.setAttribute(
      'aria-checked',
      String((document.documentElement.getAttribute('data-theme') || 'dark') !== 'light')
    );
  pill.addEventListener('click', () => toggleTheme());
  new MutationObserver(sync).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  sync();
}

// `pending` here is already filtered down to claims this admin hasn't dismissed -
// the true pending count (Claims badge, dashboard tile) is tracked separately.
function renderNotifications(pending) {
  const waiting = [...pending].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt)).slice(0, 5);
  document.getElementById('notifCount').textContent = pending.length ? `${pending.length} waiting` : 'All clear';
  document.getElementById('notifBody').innerHTML = waiting.length
    ? `<ul class="feed">${waiting
        .map(
          (claim) => `
          <li class="feed-row">
            <div class="feed-main"><strong title="${escHtml(claim.itemTitle || 'Item')}">Claim for ${escHtml(claim.itemTitle || 'an item')}</strong><small>${escHtml(claim.claimantName || 'Unknown claimant')} · ${escHtml(relativeTime(claim.createdAt))}</small></div>
            <button type="button" class="action-btn action-btn-outline" data-action="markClaimNotificationRead" data-args="${actionArgs(claim.id)}">Mark as read</button>
          </li>`
        )
        .join('')}</ul>`
    : '<p class="feed-empty"><svg class="ico" aria-hidden="true"><use href="#i-found"/></svg>You are all caught up.</p>';
}

async function markClaimNotificationRead(id, button) {
  button.disabled = true;
  try {
    const response = await adminFetch(`/api/items/claims/${encodeURIComponent(id)}/seen`, { method: 'PATCH' });
    if (!response.ok) throw new Error();
    const claim = claimRequests.find((entry) => entry.id === id);
    if (claim) {
      claim.seenByAdmin = Array.isArray(claim.seenByAdmin) ? claim.seenByAdmin : [];
      if (!claim.seenByAdmin.includes(window.currentAdminUserId)) claim.seenByAdmin.push(window.currentAdminUserId);
    }
    renderDashboard(adminItems);
  } catch (error) {
    showToast('Could not mark notification as read.', 'error');
    button.disabled = false;
  }
}

function renderAdminIdentity(user) {
  const name = String(user.fullName || user.email || 'Administrator').trim();
  const initials =
    name
      .split(/\s+/)
      .slice(0, 2)
      .map((part) => part[0])
      .join('')
      .toUpperCase() || 'A';
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

function isResolved(item) {
  return Boolean(item.claimed) || item.status === 'claimed';
}
function isOpenItem(item) {
  return !isResolved(item) && item.status !== 'archived';
}

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
  const step = [1, 2, 5, 10].map((factor) => factor * magnitude).find((size) => target / size <= 4) || 10 * magnitude;
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
      found: 0,
    });
  }
  const byKey = new Map(buckets.map((bucket) => [bucket.key, bucket]));
  items.forEach((item) => {
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
  times.forEach((time) => {
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
  const points = values.map((value, index) =>
    [pad + (index * (width - pad * 2)) / (values.length - 1), height - pad - (value / peak) * (height - pad * 2)].map(
      (number) => number.toFixed(1)
    )
  );
  const last = points[points.length - 1];
  return `<svg class="spark" viewBox="0 0 ${width} ${height}" aria-hidden="true" focusable="false"><polyline points="${points.map((point) => point.join(',')).join(' ')}"/><circle cx="${last[0]}" cy="${last[1]}" r="3.5"/></svg>`;
}

// Rolling windows for the dashboard's date-range filter. It only scopes the
// resolution-rate card and the top-categories/top-locations lists, which otherwise
// average over every report ever filed; the KPI tiles, trend chart and queues below
// stay on their own fixed windows.
const DASHBOARD_RANGE_MS = { week: 7 * DAY_MS, month: 30 * DAY_MS, quarter: 90 * DAY_MS, all: Infinity };
const DASHBOARD_RANGE_LABEL = {
  week: 'the last 7 days',
  month: 'the last 30 days',
  quarter: 'the last 90 days',
  all: '',
};

function setDashboardRange(range) {
  dashboardRange = DASHBOARD_RANGE_MS[range] ? range : 'all';
  document.querySelectorAll('#dashRangeSeg [data-range]').forEach((button) => {
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
  return items.filter((item) => {
    const time = itemTime(item);
    return time && now - time <= windowMs;
  });
}

// New items in the last 30 days compared with the 30 days before that.
function periodChange(times) {
  const now = Date.now();
  const current = times.filter((time) => time && now - time <= 30 * DAY_MS).length;
  const previous = times.filter((time) => time && now - time > 30 * DAY_MS && now - time <= 60 * DAY_MS).length;
  const diff = current - previous;
  return {
    current,
    text: diff === 0 ? 'Same as prior 30 days' : `${diff > 0 ? '+' : '−'}${Math.abs(diff)} vs prior 30 days`,
  };
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
  document.querySelectorAll('#kpiRow [data-count]').forEach((element) => {
    const target = Number(element.dataset.count);
    if (!Number.isFinite(target) || target < 1) return;
    const start = performance.now();
    const tick = (now) => {
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
  const pending = claimRequests.filter((claim) => claim.status === 'pending');
  const lost = items.filter((item) => item.type === 'lost');
  const found = items.filter((item) => item.type === 'found');
  const openLost = lost.filter(isOpenItem).length;
  const openFound = found.filter(isOpenItem).length;
  const resolved = items.filter(isResolved).length;
  const counted = items.filter((item) => item.status !== 'archived').length;
  const rate = counted ? Math.round((resolved / counted) * 100) : 0;
  const oldest = pending.reduce(
    (first, claim) => (!first || Date.parse(claim.createdAt) < Date.parse(first.createdAt) ? claim : first),
    null
  );

  // Resolution rate, top categories and top locations respect the date-range picker;
  // everything else above keeps using the full, unscoped `items`.
  const rangeItems = itemsInDashboardRange(items);
  const rangeResolved = rangeItems.filter(isResolved).length;
  const rangeCounted = rangeItems.filter((item) => item.status !== 'archived').length;
  const rangeRate = rangeCounted ? Math.round((rangeResolved / rangeCounted) * 100) : 0;
  const rangeSuffix = DASHBOARD_RANGE_LABEL[dashboardRange] ? ` · ${DASHBOARD_RANGE_LABEL[dashboardRange]}` : '';
  document.getElementById('rateSubtitle').textContent = `Reports that ended with the item returned${rangeSuffix}`;
  document.getElementById('catSubtitle').textContent = `Most reported kinds of items${rangeSuffix}`;
  document.getElementById('locSubtitle').textContent = `Offices and areas with the most reports${rangeSuffix}`;

  const lostTimes = lost.map(itemTime);
  const foundTimes = found.map(itemTime);
  const lostChange = periodChange(lostTimes);
  const foundChange = periodChange(foundTimes);
  const resolvedTimes = items.filter(isResolved).map((item) => Date.parse(item.claimedAt) || 0);
  const claimTimes = claimRequests.map((claim) => Date.parse(claim.createdAt) || 0);

  const tile = (kind, icon, label, value, sub, action, args, trend) => `
        <button type="button" class="kpi kpi--${kind}" data-action="${action}" data-args='${args}'>
          <span class="kpi-top"><span class="kpi-label">${label}</span><span class="kpi-chip" aria-hidden="true"><svg class="ico"><use href="#i-${icon}"/></svg></span></span>
          <span class="kpi-mid"><span class="kpi-value" data-count="${value}">${value}</span>${sparkline(trend)}</span>
          <span class="kpi-sub">${sub}</span>
        </button>`;
  const subLines = (first, second) =>
    `<span>${first}</span>${second ? `<span class="kpi-delta">${second}</span>` : ''}`;
  const kpiRow = document.getElementById('kpiRow');
  kpiRow.removeAttribute('aria-busy');
  kpiRow.innerHTML =
    tile(
      'lost',
      'search',
      'Open lost reports',
      openLost,
      subLines(`${lostChange.current} new in 30 days`, lostChange.text),
      'showAdminItems',
      '["lost"]',
      weeklyCounts(lostTimes)
    ) +
    tile(
      'found',
      'found',
      'Open found reports',
      openFound,
      subLines(`${foundChange.current} new in 30 days`, foundChange.text),
      'showAdminItems',
      '["found"]',
      weeklyCounts(foundTimes)
    ) +
    tile(
      'claims',
      'shield',
      'Pending claims',
      pending.length,
      subLines(oldest ? `Oldest: ${escHtml(relativeTime(oldest.createdAt))}` : 'Nothing pending', ''),
      'showAdminView',
      '["claims"]',
      weeklyCounts(claimTimes)
    ) +
    tile(
      'returned',
      'box',
      'Resolved reports',
      resolved,
      subLines(`${rate}% of all reports`, ''),
      'showAdminItems',
      '["", "claimed"]',
      weeklyCounts(resolvedTimes)
    );

  const banner = document.getElementById('attentionBanner');
  banner.hidden = !pending.length;
  if (pending.length) {
    banner.querySelector('strong').textContent =
      `${pending.length} claim${pending.length === 1 ? ' is' : 's are'} pending`;
    banner.querySelector('small').textContent = oldest
      ? `The oldest was submitted ${relativeTime(oldest.createdAt)}.`
      : '';
  }

  const resolveDays = rangeItems
    .filter(isResolved)
    .map((item) => (Date.parse(item.claimedAt) - itemTime(item)) / DAY_MS)
    .filter((days) => Number.isFinite(days) && days >= 0);
  const averageDays = resolveDays.length ? resolveDays.reduce((sum, days) => sum + days, 0) / resolveDays.length : null;
  const longestOpen = rangeItems
    .filter(isOpenItem)
    .filter((item) => itemTime(item))
    .sort((a, b) => itemTime(a) - itemTime(b))[0];
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
    ? `<ul class="feed">${waiting
        .map(
          (claim) => `
          <li class="feed-row">
            <div class="feed-main"><strong title="${escHtml(claim.itemTitle || 'Item')}">${escHtml(claim.itemTitle || 'Item')}</strong><small>${escHtml(claim.claimantName || 'Unknown claimant')} · ${escHtml(relativeTime(claim.createdAt))}</small></div>
          </li>`
        )
        .join('')}</ul>`
    : '<p class="feed-empty"><svg class="ico" aria-hidden="true"><use href="#i-found"/></svg>All caught up. No claims are pending.</p>';

  const latest = [...items].sort((a, b) => itemTime(b) - itemTime(a)).slice(0, 5);
  document.getElementById('dashRecent').innerHTML = latest.length
    ? `<ul class="feed">${latest
        .map(
          (item) => `
          <li class="feed-row">
            <span class="badge ${item.type === 'lost' ? 'badge-lost' : 'badge-found'}">${escHtml(item.type)}</span>
            <div class="feed-main"><strong title="${escHtml(item.title)}">${escHtml(item.title)}</strong><small>${escHtml(officeOf(item))} · ${escHtml(relativeTime(item.createdAt || item.date))}</small></div>
          </li>`
        )
        .join('')}</ul>`
    : '<p class="feed-empty">No reports yet.</p>';

  // The Claims badge and KPI tile always show the true pending count; the bell
  // only shows claims this admin hasn't dismissed yet (see markClaimNotificationRead).
  const unseenPending = pending.filter((claim) => !(claim.seenByAdmin || []).includes(window.currentAdminUserId));
  setCount('countLost', openLost);
  setCount('countFound', openFound);
  setCount('countClaims', pending.length);
  setCount('bellCount', unseenPending.length);
  renderNotifications(unseenPending);
  document
    .getElementById('adminBell')
    .setAttribute(
      'aria-label',
      unseenPending.length
        ? `${unseenPending.length} claim${unseenPending.length === 1 ? '' : 's'} pending`
        : 'No claims pending'
    );
  playDashboardIntro();
}

function renderRankList(id, entries) {
  const container = document.getElementById(id);
  if (!entries.length) {
    container.innerHTML = '<p class="viz-empty">No data yet.</p>';
    return;
  }
  const peak = entries[0][1];
  container.innerHTML = entries
    .map(
      ([label, count]) => `
        <div class="rank-row">
          <span class="rank-label" title="${escHtml(label)}">${escHtml(label)}</span>
          <span class="rank-track"><i style="--w:${(count / peak).toFixed(3)}"></i><b>${count}</b></span>
        </div>`
    )
    .join('');
}

function renderTrendChart(items) {
  const buckets = buildMonthlyTrend(items);
  const plot = document.getElementById('trendPlot');
  document.getElementById('trendTip').hidden = true;
  // The same numbers as a table, for screen readers and anyone who prefers one.
  document.getElementById('trendTable').innerHTML = `
        <table class="trend-table">
          <thead><tr><th>Month</th><th>Lost</th><th>Found</th><th>Total</th></tr></thead>
          <tbody>${buckets.map((bucket) => `<tr><td>${escHtml(bucket.title)}</td><td>${bucket.lost}</td><td>${bucket.found}</td><td>${bucket.lost + bucket.found}</td></tr>`).join('')}</tbody>
        </table>`;

  const peak = Math.max(0, ...buckets.map((bucket) => Math.max(bucket.lost, bucket.found)));
  if (!peak) {
    plot.innerHTML = '<p class="viz-empty">No reports in the last six months.</p>';
    return;
  }
  const { step, max } = niceScale(peak);
  const ticks = [];
  for (let value = 0; value <= max; value += step) ticks.push(value);
  // Only the newest month prints its numbers; the tooltip and table carry the rest.
  const column = (type, value, newest) =>
    `<span class="trend-col trend-col--${type}" style="--h:${((value / max) * 100).toFixed(2)}${value ? ';min-height:3px' : ''}">${newest && value ? `<b>${value}</b>` : ''}</span>`;
  const months = buckets
    .map(
      (bucket, index) => `
        <div class="trend-month" style="--i:${index}" tabindex="0" role="img" aria-label="${escHtml(bucket.title)}: ${bucket.lost} lost, ${bucket.found} found" data-title="${escHtml(bucket.title)}" data-lost="${bucket.lost}" data-found="${bucket.found}">
          ${column('lost', bucket.lost, index === buckets.length - 1)}${column('found', bucket.found, index === buckets.length - 1)}
        </div>`
    )
    .join('');
  plot.innerHTML = `
        <div class="trend-chart" style="--n:${buckets.length}">
          <div class="trend-area">
            ${ticks.map((value) => `<div class="trend-tick${value === 0 ? ' trend-tick--base' : ''}" style="--p:${((value / max) * 100).toFixed(2)}"><span>${value}</span></div>`).join('')}
            <div class="trend-groups">${months}</div>
          </div>
          <div class="trend-labels">${buckets.map((bucket) => `<span>${escHtml(bucket.label)}</span>`).join('')}</div>
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
  const show = (month) => {
    if (month === active) return;
    if (active) active.classList.remove('is-active');
    active = month;
    month.classList.add('is-active');
    tip.innerHTML =
      `<strong>${escHtml(month.dataset.title)}</strong>` +
      `<div><i class="sw sw--lost" aria-hidden="true"></i>Lost<b>${escHtml(month.dataset.lost)}</b></div>` +
      `<div><i class="sw sw--found" aria-hidden="true"></i>Found<b>${escHtml(month.dataset.found)}</b></div>`;
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
  wrap.addEventListener('mouseover', (event) => {
    const month = event.target.closest('.trend-month');
    if (month) show(month);
    else hide();
  });
  wrap.addEventListener('mouseleave', hide);
  wrap.addEventListener('focusin', (event) => {
    const month = event.target.closest('.trend-month');
    if (month) show(month);
  });
  wrap.addEventListener('focusout', hide);
  document.addEventListener('click', (event) => {
    if (!event.target.closest('.trend-month')) hide();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') hide();
  });
}

function toggleTrendTable(button) {
  const showTable = button.getAttribute('aria-pressed') !== 'true';
  button.setAttribute('aria-pressed', String(showTable));
  button.textContent = showTable ? 'View as chart' : 'View as table';
  document.getElementById('trendPlot').hidden = showTable;
  document.getElementById('trendTable').hidden = !showTable;
  document.getElementById('trendTip').hidden = true;
}

// ── Claims list ───────────────────────────────────────────────────────────
function renderClaimQueue() {
  const body = document.getElementById('adminClaimsBody');
  const empty = document.getElementById('adminClaimsEmptyState');
  if (!body || !empty) return;
  const claims = [...claimRequests].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  empty.hidden = claims.length > 0;
  body.innerHTML = claims
    .map((claim) => {
      const status =
        claim.status === 'pending'
          ? '<span class="badge admin-status-pending">Pending</span>'
          : claim.status === 'approved'
            ? '<span class="badge badge-claimed">Approved</span>'
            : '<span class="badge admin-status-rejected">Rejected</span>';
      return `
        <tr>
          <td class="td-title">${escHtml(claim.itemTitle || 'Item')}<small>${escHtml(claim.itemRefCode || '')}</small></td>
          <td>${escHtml(claim.claimantName || 'Unknown')}<small>${escHtml(claim.claimantEmail || '')}</small></td>
          <td>${escHtml(formatDate(claim.createdAt))}</td>
          <td>${status}</td>
          <td><button class="action-btn action-btn-delete" data-action="deleteClaim" data-args="${actionArgs(claim.id, claim.itemTitle || 'this item')}">Delete</button></td>
        </tr>`;
    })
    .join('');
}

async function deleteClaim(id, itemTitle) {
  if (
    !(await openActionConfirm(
      'Delete Claim',
      `Permanently delete the claim for "${itemTitle}"? This cannot be undone.`
    ))
  )
    return;
  try {
    const response = await adminFetch(`/api/items/claims/${encodeURIComponent(id)}`, { method: 'DELETE' });
    const data = await response.json();
    if (!response.ok || !data.success) throw new Error(data.message || 'Unable to delete claim.');
    showToast(data.message || 'Claim deleted.');
    await refreshAdminClaims();
  } catch (error) {
    showToast(error.message || 'Unable to delete claim.', 'error');
  }
}

// key is a property name, or a function that reads the label from an item.
function countValues(items, key) {
  const read = typeof key === 'function' ? key : (item) => item[key];
  const counts = new Map();
  items.forEach((item) => {
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
    const left = ['status', 'category'].includes(adminSort.key)
      ? a[adminSort.key] || ''
      : new Date(a.createdAt || a.date).getTime();
    const right = ['status', 'category'].includes(adminSort.key)
      ? b[adminSort.key] || ''
      : new Date(b.createdAt || b.date).getTime();
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

  tbody.innerHTML = pageItems
    .map((item, idx) => {
      const date = item.type === 'lost' ? formatDate(item.dateLost) : formatDate(item.dateFound);
      const canClaim = item.status !== 'claimed' && item.status !== 'archived';
      const canRestore = item.status === 'claimed' || item.status === 'archived';
      const itemClaims = claimRequests.filter((claim) => String(claim.itemId) === String(item.id));
      const pendingClaim = itemClaims.find((claim) => claim.status === 'pending');
      const latestClaim = itemClaims[0];
      const itemStatus =
        item.status === 'archived'
          ? '<span class="badge badge-archived">Archived</span>'
          : item.claimed || item.status === 'claimed'
            ? '<span class="badge badge-claimed">Claimed</span>'
            : pendingClaim
              ? '<span class="badge admin-status-pending">Pending</span>'
              : latestClaim?.status === 'rejected'
                ? '<span class="badge admin-status-rejected">Rejected · Available</span>'
                : statusBadge(item.status);
      const reporterValues = [
        ...new Set([item.reporterName, item.reporterContact].filter((value) => value && value !== '—')),
      ];
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
          <td class="reporter-cell" title="${escHtml(reporterValues.join(' · ') || '—')}">${
            reporterValues.length
              ? reporterValues
                  .map(
                    (value, index) =>
                      `<span class="admin-cell-wrap${index ? ' reporter-contact' : ''}">${escHtml(value)}</span>`
                  )
                  .join('')
              : '—'
          }</td>
          <td title="${escHtml(date)}">${date}</td>
          <td class="status-cell" title="${pendingClaim ? 'Pending verification: a claim is waiting for review' : latestClaim?.status === 'rejected' && !item.claimed ? 'Rejected · Available' : escHtml(item.status)}">${itemStatus}</td>
          <td class="actions-cell">
            <div class="action-buttons">
              ${canRestore ? `<button class="action-btn action-btn-restore" data-action="openRestoreModal" data-args="${actionArgs(item.id, item.status)}">Restore</button>` : ''}
              <button class="action-btn action-btn-delete" data-action="openDeleteModal" data-args="${actionArgs(item.id, item.title, reporterValues[0] || 'Unknown reporter')}">Delete</button>
            </div>
          </td>
        </tr>`;
    })
    .join('');
  tbody.querySelectorAll('.item-select').forEach((input) =>
    input.addEventListener('change', () => {
      const id = String(input.dataset.itemId);
      if (input.checked) selectedItemIds.add(id);
      else selectedItemIds.delete(id);
      updateBulkToolbar();
    })
  );
  updateBulkToolbar();
}

function getFilteredAdminItems() {
  let items = adminItems.slice();
  const query = document.getElementById('adminSearch').value.toLowerCase().trim();
  const type = adminTypeFilter;
  const status = document.getElementById('adminFilterStatus').value;
  const dateRange = document.getElementById('adminFilterDate').value;

  if (query)
    items = items.filter(
      (item) =>
        (item.title || '').toLowerCase().includes(query) ||
        (item.reporterName || '').toLowerCase().includes(query) ||
        (item.reporterContact || '').toLowerCase().includes(query) ||
        (item.reporterEmail || '').toLowerCase().includes(query) ||
        (item.category || '').toLowerCase().includes(query) ||
        (item.location || '').toLowerCase().includes(query) ||
        (item.desc || '').toLowerCase().includes(query)
    );
  if (type) items = items.filter((item) => item.type === type);
  if (status)
    items = items.filter(
      (item) => item.status === status || (['lost', 'found'].includes(status) && item.type === status)
    );
  if (dateRange) {
    const now = new Date();
    const start = new Date(now);
    if (dateRange === 'today') start.setHours(0, 0, 0, 0);
    if (dateRange === 'week') start.setDate(now.getDate() - 7);
    if (dateRange === 'month') start.setMonth(now.getMonth() - 1);
    items = items.filter((item) => new Date(item.createdAt || item.date).getTime() >= start.getTime());
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
      body: JSON.stringify({ proof }),
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
    const response = await adminFetch(`/api/items/${encodeURIComponent(id)}/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
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

function markClaimed(id) {
  updateItemClaimStatus(id, 'Verified by moderator during campus handoff.');
}

function markRestore(id, status = 'claimed') {
  if (status === 'archived') return updateItemStatus(id, 'active');
  return updateItemClaimStatus(id);
}

function openRestoreModal(id, status = 'claimed') {
  const item = adminItems.find((entry) => String(entry.id) === String(id));
  restoreTarget = { id, status };
  const title = item?.title || 'this item';
  const message =
    status === 'archived'
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

function toggleSelectAllVisible(event) {
  visibleAdminItems.forEach((item) => {
    if (event.currentTarget.checked) selectedItemIds.add(String(item.id));
    else selectedItemIds.delete(String(item.id));
  });
  renderItemsTable();
}

function updateBulkToolbar() {
  const count = selectedItemIds.size;
  document.getElementById('selectedItemsCount').textContent = `${count} selected`;
  ['bulkClaimBtn', 'bulkArchiveBtn', 'bulkDeleteBtn', 'exportSelectedBtn'].forEach((id) => {
    document.getElementById(id).disabled = count === 0;
  });
  const selectAll = document.getElementById('selectAllItems');
  const selectedVisibleCount = visibleAdminItems.filter((item) => selectedItemIds.has(String(item.id))).length;
  selectAll.checked = visibleAdminItems.length > 0 && selectedVisibleCount === visibleAdminItems.length;
  selectAll.indeterminate = selectedVisibleCount > 0 && selectedVisibleCount < visibleAdminItems.length;
}

function openActionConfirm(title, message) {
  return new Promise((resolve) => {
    const modal = document.getElementById('actionConfirmModal');
    const confirmButton = document.getElementById('confirmActionConfirm');
    document.getElementById('actionConfirmTitle').textContent = title;
    document.getElementById('actionConfirmMsg').textContent = message;
    modal.classList.add('open');
    const finish = (value) => {
      modal.classList.remove('open');
      actionConfirmResolver = null;
      resolve(value);
    };
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
  if (
    !(await openActionConfirm(
      'Confirm Bulk Action',
      `Are you sure you want to ${actionText} ${ids.length} selected item(s)?`
    ))
  )
    return;
  try {
    const response = await adminFetch('/api/items/bulk', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids, action }),
    });
    const data = await response.json();
    if (!response.ok || !data.success) throw new Error(data.message || 'Bulk operation failed.');
    ids.forEach((id) => selectedItemIds.delete(id));
    await refreshAdminItems();
    await refreshAdminClaims();
    showToast(`${data.affected} item(s) updated.`);
  } catch (error) {
    showToast(error.message, 'error');
  }
}

function setupBroadcastTemplates() {
  const subject = document.getElementById('broadcastSubject');
  const message = document.getElementById('broadcastMessage');
  const fields = document.getElementById('broadcastFields');
  const menu = document.getElementById('broadcastCommandMenu');
  const templateToggle = document.getElementById('broadcastTemplateToggle');
  const templateMenu = document.getElementById('broadcastTemplateMenu');
  let activeField = null;
  let activeTemplate = null;
  let activeSyncEdit = null;
  let matches = [];
  let selectedIndex = 0;

  function closeMenu() {
    menu.hidden = true;
    menu.replaceChildren();
    subject.setAttribute('aria-expanded', 'false');
    message.setAttribute('aria-expanded', 'false');
    subject.removeAttribute('aria-activedescendant');
    message.removeAttribute('aria-activedescendant');
    activeField = null;
    matches = [];
    selectedIndex = 0;
  }

  function closeTemplateMenu() {
    templateMenu.hidden = true;
    templateToggle.setAttribute('aria-expanded', 'false');
  }

  function positionMenu(field) {
    const fieldRect = field.getBoundingClientRect();
    const fieldsRect = fields.getBoundingClientRect();
    const menuHeight = menu.offsetHeight;
    const belowSpace = window.innerHeight - fieldRect.bottom - 12;
    let top = fieldRect.bottom - fieldsRect.top + 6;
    if (belowSpace < menuHeight && fieldRect.top - fieldsRect.top > menuHeight + 8) {
      top = fieldRect.top - fieldsRect.top - menuHeight - 6;
    }
    menu.style.top = `${Math.max(0, top)}px`;
  }

  function selectOption(index) {
    if (!matches.length) return;
    selectedIndex = (index + matches.length) % matches.length;
    const options = menu.querySelectorAll('[role="option"]');
    options.forEach((option, optionIndex) => {
      const selected = optionIndex === selectedIndex;
      option.classList.toggle('is-active', selected);
      option.setAttribute('aria-selected', String(selected));
    });
    const activeOption = options[selectedIndex];
    if (activeOption && activeField) {
      activeField.setAttribute('aria-activedescendant', activeOption.id);
      activeOption.scrollIntoView({ block: 'nearest' });
    }
  }

  function selectedPlaceholder(field) {
    const start = field.selectionStart;
    const end = field.selectionEnd;
    if (start === end) return null;
    const selected = /^\[([^\]]+)\]$/.exec(field.value.slice(start, end));
    return selected ? { name: selected[1], start, end } : null;
  }

  function preparePlaceholderSync(event) {
    const field = event.currentTarget;
    const start = field.selectionStart;
    const end = field.selectionEnd;
    if (
      activeSyncEdit &&
      activeSyncEdit.field === field &&
      start >= activeSyncEdit.start &&
      end <= activeSyncEdit.start + activeSyncEdit.value.length
    )
      return;

    const placeholder = selectedPlaceholder(field);
    if (!placeholder) {
      activeSyncEdit = null;
      return;
    }
    const otherField = field === subject ? message : subject;
    activeSyncEdit = {
      field,
      name: placeholder.name,
      start: placeholder.start,
      prefix: field.value.slice(0, placeholder.start),
      suffix: field.value.slice(placeholder.end),
      value: '',
      otherField,
      otherFieldValue: otherField.value,
    };
  }

  function syncEditedPlaceholder(field) {
    if (!activeSyncEdit) return;
    if (activeSyncEdit.field !== field) {
      activeSyncEdit = null;
      return;
    }
    const { prefix, suffix, name, otherField, otherFieldValue } = activeSyncEdit;
    const valueEnd = field.value.length - suffix.length;
    if (!field.value.startsWith(prefix) || !field.value.endsWith(suffix) || valueEnd < prefix.length) {
      activeSyncEdit = null;
      return;
    }
    const value = field.value.slice(prefix.length, valueEnd);
    activeSyncEdit.value = value;
    const token = `[${name}]`;
    otherField.value = otherFieldValue.split(token).join(value || token);
  }

  function selectNextPlaceholder(field) {
    const pattern = /\[[^\]]+\]/g;
    function findNext(targetField, start) {
      pattern.lastIndex = start;
      const match = pattern.exec(targetField.value);
      return match ? { field: targetField, match } : null;
    }

    const target = findNext(field, field.selectionEnd);
    if (target) return target;
    if (field === subject) {
      return findNext(message, 0) || findNext(subject, 0);
    }
    return findNext(subject, 0) || findNext(message, 0);
  }

  function selectPlaceholderAtClick(event) {
    const field = event.currentTarget;
    const start = field.selectionStart;
    const end = field.selectionEnd;
    const pattern = /\[[^\]]+\]/g;
    let match;
    while ((match = pattern.exec(field.value)) !== null) {
      const tokenEnd = match.index + match[0].length;
      const caretInside = start === end && start >= match.index && start < tokenEnd;
      const selectionInside = start < end && start >= match.index && end <= tokenEnd;
      if (caretInside || selectionInside) {
        field.setSelectionRange(match.index, tokenEnd);
        return;
      }
    }
  }

  function handlePlaceholderTab(event) {
    if (event.key !== 'Tab' || event.shiftKey || !menu.hidden) return;
    const target = selectNextPlaceholder(event.currentTarget);
    if (!target) return;
    event.preventDefault();
    target.field.focus();
    target.field.setSelectionRange(target.match.index, target.match.index + target.match[0].length);
  }

  function insertTemplate(template) {
    if (!template) return;
    activeTemplate = template;
    activeSyncEdit = null;
    subject.value = template.subject;
    message.value = template.message;
    closeMenu();
    closeTemplateMenu();

    const subjectPlaceholder = /\[[^\]]+\]/.exec(subject.value);
    const messagePlaceholder = /\[[^\]]+\]/.exec(message.value);
    if (messagePlaceholder) {
      message.focus();
      message.setSelectionRange(messagePlaceholder.index, messagePlaceholder.index + messagePlaceholder[0].length);
    } else {
      subject.focus();
      if (subjectPlaceholder)
        subject.setSelectionRange(subjectPlaceholder.index, subjectPlaceholder.index + subjectPlaceholder[0].length);
    }
  }

  function updateMenu(field) {
    const cursor = field.selectionStart;
    if (cursor === null || field.selectionEnd !== cursor) {
      closeMenu();
      return;
    }
    const precedingText = field.value.slice(0, cursor);
    const commandText = field === subject ? precedingText : precedingText.slice(precedingText.lastIndexOf('\n') + 1);
    const commandMatch = commandText.match(/(?:^|\s)\/([a-z0-9-]*)$/i);
    if (!commandMatch) {
      closeMenu();
      return;
    }

    const query = commandMatch[1].toLowerCase();
    matches = BROADCAST_TEMPLATES.filter((template) => template.command.slice(1).startsWith(query));
    if (!matches.length) {
      closeMenu();
      return;
    }
    activeField = field;
    selectedIndex = 0;
    menu.replaceChildren();
    matches.forEach((template, index) => {
      const option = document.createElement('button');
      option.type = 'button';
      option.id = `broadcast-command-${template.id}`;
      option.className = 'broadcast-command-option';
      option.setAttribute('role', 'option');
      option.setAttribute('aria-selected', String(index === selectedIndex));

      const heading = document.createElement('span');
      heading.className = 'broadcast-command-option-heading';
      const command = document.createElement('kbd');
      command.textContent = template.command;
      const title = document.createElement('strong');
      title.textContent = template.title;
      heading.append(command, title);

      const description = document.createElement('small');
      description.textContent = template.description;
      option.append(heading, description);
      option.addEventListener('mouseenter', () => selectOption(index));
      option.addEventListener('click', () => insertTemplate(template));
      menu.append(option);
    });

    menu.hidden = false;
    subject.setAttribute('aria-expanded', String(field === subject));
    message.setAttribute('aria-expanded', String(field === message));
    positionMenu(field);
    selectOption(0);
  }

  function handleMenuKeydown(event) {
    if (menu.hidden) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      selectOption(selectedIndex + 1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      selectOption(selectedIndex - 1);
    } else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      return;
    } else if (event.key === 'Enter' || (event.key === 'Tab' && !event.shiftKey)) {
      event.preventDefault();
      insertTemplate(matches[selectedIndex]);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      closeMenu();
    } else if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
      closeMenu();
    }
  }

  [subject, message].forEach((field) => {
    field.addEventListener('beforeinput', preparePlaceholderSync);
    field.addEventListener('input', () => {
      syncEditedPlaceholder(field);
      updateMenu(field);
    });
    field.addEventListener('click', selectPlaceholderAtClick);
    field.addEventListener('keydown', handlePlaceholderTab);
    field.addEventListener('keydown', handleMenuKeydown);
  });
  menu.addEventListener('keydown', handleMenuKeydown);

  BROADCAST_TEMPLATES.forEach((template) => {
    const option = document.createElement('button');
    option.type = 'button';
    option.className = 'broadcast-command-option';
    option.setAttribute('role', 'menuitem');
    const heading = document.createElement('span');
    heading.className = 'broadcast-command-option-heading';
    const command = document.createElement('kbd');
    command.textContent = template.command;
    const title = document.createElement('strong');
    title.textContent = template.title;
    heading.append(command, title);
    const description = document.createElement('small');
    description.textContent = template.description;
    option.append(heading, description);
    option.addEventListener('click', () => insertTemplate(template));
    templateMenu.append(option);
  });
  function focusTemplateOption(index) {
    const options = [...templateMenu.querySelectorAll('[role="menuitem"]')];
    if (!options.length) return;
    const currentIndex = options.indexOf(document.activeElement);
    const nextIndex =
      index === null
        ? 0
        : currentIndex < 0
          ? index < 0
            ? options.length - 1
            : 0
          : (currentIndex + index + options.length) % options.length;
    options[nextIndex].focus();
  }

  templateToggle.addEventListener('click', () => {
    if (templateMenu.hidden) {
      closeMenu();
      templateMenu.hidden = false;
      templateToggle.setAttribute('aria-expanded', 'true');
    } else closeTemplateMenu();
  });
  templateToggle.addEventListener('keydown', (event) => {
    if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
    event.preventDefault();
    if (templateMenu.hidden) {
      closeMenu();
      templateMenu.hidden = false;
      templateToggle.setAttribute('aria-expanded', 'true');
    }
    focusTemplateOption(event.key === 'ArrowDown' ? null : -1);
  });
  templateMenu.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      focusTemplateOption(event.key === 'ArrowDown' ? 1 : -1);
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      const options = templateMenu.querySelectorAll('[role="menuitem"]');
      const option = event.key === 'Home' ? options[0] : options[options.length - 1];
      if (option) option.focus();
    }
  });
  document.getElementById('tabBroadcast').addEventListener('keydown', (event) => {
    if (
      event.key !== 'Escape' ||
      event.defaultPrevented ||
      document.querySelector('.slip-overlay.open, .del-modal-backdrop.open')
    )
      return;
    event.preventDefault();
    if (!menu.hidden) closeMenu();
    else if (!templateMenu.hidden) {
      closeTemplateMenu();
      templateToggle.focus();
    } else document.getElementById('clearBroadcastBtn').click();
  });
  document.getElementById('sendBroadcastBtn').addEventListener('click', () => {
    closeMenu();
    closeTemplateMenu();
  });
  document.getElementById('clearBroadcastBtn').addEventListener('click', () => {
    subject.value = '';
    message.value = '';
    activeTemplate = null;
    activeSyncEdit = null;
    closeMenu();
    closeTemplateMenu();
    subject.focus();
  });
  document.addEventListener('pointerdown', (event) => {
    if (!menu.hidden && !menu.contains(event.target) && event.target !== subject && event.target !== message)
      closeMenu();
    if (!templateMenu.hidden && !templateMenu.contains(event.target) && event.target !== templateToggle)
      closeTemplateMenu();
  });
  document.addEventListener('focusin', (event) => {
    if (!menu.hidden && event.target !== activeField && !menu.contains(event.target)) closeMenu();
    if (!templateMenu.hidden && event.target !== templateToggle && !templateMenu.contains(event.target))
      closeTemplateMenu();
  });
  document.addEventListener('keydown', (event) => {
    if (!templateMenu.hidden && event.key === 'Escape') {
      event.preventDefault();
      closeTemplateMenu();
      templateToggle.focus();
      return;
    }
    if (
      !menu.hidden &&
      event.altKey &&
      !event.ctrlKey &&
      !event.metaKey &&
      (/^[1-8]$/.test(event.key) || event.key.toLowerCase() === 'e')
    )
      closeMenu();
  });
  window.addEventListener('resize', () => {
    if (activeField && !menu.hidden) positionMenu(activeField);
  });
}

async function sendBroadcast() {
  const subjectField = document.getElementById('broadcastSubject');
  const messageField = document.getElementById('broadcastMessage');
  const subject = subjectField.value.trim();
  const message = messageField.value.trim();
  const subjectPlaceholder = /\[[^\]]+\]/.exec(subjectField.value);
  const messagePlaceholder = /\[[^\]]+\]/.exec(messageField.value);
  const remainingPlaceholder = subjectPlaceholder
    ? { field: subjectField, match: subjectPlaceholder }
    : messagePlaceholder
      ? { field: messageField, match: messagePlaceholder }
      : null;
  if (remainingPlaceholder) {
    remainingPlaceholder.field.focus();
    remainingPlaceholder.field.setSelectionRange(
      remainingPlaceholder.match.index,
      remainingPlaceholder.match.index + remainingPlaceholder.match[0].length
    );
    showToast('Fill in all bracketed placeholders before sending.', 'error');
    return;
  }
  if (subject.length < 3 || message.length < 5) return showToast('Enter a subject and message first.', 'error');
  if (!(await openActionConfirm('Confirm Broadcast', 'Send this announcement to all registered students?'))) return;
  const button = document.getElementById('sendBroadcastBtn');
  button.disabled = true;
  try {
    const response = await adminFetch('/api/items/broadcast', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subject, message }),
    });
    const data = await response.json();
    if (!response.ok || !data.success) throw new Error(data.message || 'Broadcast failed.');
    document.getElementById('broadcastSubject').value = '';
    document.getElementById('broadcastMessage').value = '';
    showToast(`Broadcast sent to ${data.sent} of ${data.recipients} student(s).`);
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    button.disabled = false;
  }
}

async function openActivityModal(id) {
  const item = adminItems.find((entry) => String(entry.id) === String(id));
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
      ? `<div class="activity-list">${data.activity.map((entry) => `<div class="activity-entry"><strong>${escHtml(entry.action)}</strong><span>${escHtml(entry.actorName)} · ${formatDate(entry.timestamp)}</span>${entry.notes ? `<p>${escHtml(entry.notes)}</p>` : ''}</div>`).join('')}</div>`
      : '<p class="activity-empty">No activity recorded yet.</p>';
  } catch (error) {
    document.getElementById('activityContent').innerHTML = `<p class="activity-empty">${escHtml(error.message)}</p>`;
  }
}

function closeActivityModal() {
  document.getElementById('activityModal').classList.remove('open');
}

async function saveActivityNote() {
  const note = document.getElementById('activityNote');
  if (!note.value.trim()) return showToast('Enter a note first.', 'error');
  const response = await adminFetch(`/api/items/${encodeURIComponent(note.dataset.itemId)}/activity`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ notes: note.value.trim() }),
  });
  const data = await response.json();
  if (!response.ok || !data.success) return showToast(data.message || 'Unable to save note.', 'error');
  note.value = '';
  openActivityModal(note.dataset.itemId);
  showToast('Activity note saved.');
}

function exportCSV(selectedIds = null) {
  const items = selectedIds ? adminItems.filter((item) => selectedIds.includes(String(item.id))) : adminItems;
  const headers = [
    'ID',
    'Type',
    'Title',
    'Category',
    'Location',
    'Status',
    'Reporter',
    'Contact',
    'Email',
    'Date Lost/Found',
    'Created At',
  ];
  const rows = items.map((i) =>
    [
      i.id,
      i.type,
      i.title,
      i.category,
      i.location,
      i.status,
      i.reporterName,
      i.reporterContact,
      i.reporterEmail || '',
      i.dateLost || i.dateFound || '',
      i.createdAt,
    ]
      .map((v) => `"${String(v || '').replace(/"/g, '""')}"`)
      .join(',')
  );

  const csv = [headers.join(','), ...rows].join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `cspc-lostfound-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
  showToast('CSV exported successfully.');
}
