// server.js - CSPC Lost & Found Management System (Node.js & Express)
// Hostinger injects production variables directly; load .env only for local development.
if (!['test', 'production'].includes(process.env.NODE_ENV)) require('dotenv').config();

const express = require('express');
const compression = require('compression');
const session = require('express-session');
const FileStore = require('session-file-store')(session);
const PgSessionStore = require('connect-pg-simple')(session);
const path = require('path');
const fs = require('fs');

const crypto = require('crypto');

const authRoutes = require('./routes/authRoutes');
const itemRoutes = require('./routes/itemRoutes');
const messengerRoutes = require('./routes/messengerRoutes');
const postgresStore = require('./services/postgresStore');

// Served to anyone not on the allowlist while it is active. Fully self-contained (no
// external CSS/JS, no /cspc-logo.png) so it never depends on anything that might itself
// be gated, but it mirrors public/home.html's nav + hero so visitors see the real brand
// instead of a generic placeholder.
const siteUnavailableHtml = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Not Available - Back2You</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700;900&display=swap" rel="stylesheet">
<style>
  :root { --blue-main:#1d4ed8; --blue-dark:#1e3a8a; --text-main:#0f172a; --text-muted:#475569; --border:#e2e8f0; }
  * { box-sizing:border-box; }
  body { margin:0; min-height:100vh; display:flex; flex-direction:column; background:#f8fafc; color:var(--text-main); font-family:'DM Sans',system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; }
  a { text-decoration:none; }
  .navbar { border-bottom:1px solid var(--border); background:#ffffff; }
  .navbar-container { max-width:1140px; margin:0 auto; padding:1rem 1.5rem; display:flex; align-items:center; justify-content:space-between; gap:1rem; }
  .nav-logo { display:flex; align-items:center; gap:.6rem; font-weight:700; font-size:1.15rem; color:var(--blue-main); }
  .nav-logo-badge { width:34px; height:34px; border-radius:50%; flex-shrink:0; background:linear-gradient(160deg,#5b82f0,#1d4ed8); display:flex; align-items:center; justify-content:center; box-shadow:0 6px 16px -6px rgba(29,78,216,.6); }
  .nav-logo-badge svg { width:18px; height:18px; stroke:#fff; fill:none; stroke-width:2; stroke-linecap:round; stroke-linejoin:round; }
  .btn { display:inline-flex; align-items:center; justify-content:center; padding:.65rem 1.3rem; border-radius:.6rem; font-weight:600; font-size:.92rem; }
  .btn-primary { color:#fff; background:linear-gradient(180deg,#5b82f0 0%,#3556cc 100%); box-shadow:0 10px 24px -10px rgba(65,105,225,.7); }
  .btn-primary:hover { background:linear-gradient(180deg,#7394f3 0%,#2d48b0 100%); }
  .hero-section { flex:1 0 auto; max-width:1140px; width:100%; margin:0 auto; padding:clamp(3rem,8vh,5rem) 1.5rem; display:flex; align-items:center; justify-content:space-between; gap:3rem; flex-wrap:wrap; }
  .hero-text { max-width:620px; }
  .hero-greeting { display:inline-flex; align-items:center; gap:.55rem; color:var(--text-muted); font-size:.9rem; }
  .hero-greeting::before { content:''; width:.48rem; height:.48rem; border-radius:50%; background:#38b982; box-shadow:0 0 0 4px rgba(56,185,130,.15); }
  .landing-headline { font-size:clamp(2.1rem,4.5vw,3.1rem); font-weight:900; letter-spacing:-0.03em; line-height:1.08; margin:.6rem 0 1rem; }
  .landing-headline span { color:var(--blue-main); }
  .hero-tagline { max-width:520px; color:var(--text-muted); line-height:1.7; font-size:1.02rem; margin:0 0 1.75rem; }
  .hero-notice { display:inline-flex; align-items:center; gap:.5rem; padding:.5rem .9rem; margin-bottom:1.25rem; border-radius:.6rem; background:#fff7ed; border:1px solid #fed7aa; color:#9a3412; font-size:.85rem; font-weight:600; }
  .hero-avatar { flex-shrink:0; width:min(280px,36vw); height:min(280px,36vw); border-radius:50%; background:radial-gradient(circle at 35% 30%, rgba(91,130,240,.22), rgba(91,130,240,.04) 70%); display:flex; align-items:center; justify-content:center; }
  .hero-avatar-badge { width:62%; height:62%; border-radius:50%; background:linear-gradient(160deg,#5b82f0,#1d4ed8); box-shadow:0 20px 50px -18px rgba(29,78,216,.55); display:flex; align-items:center; justify-content:center; }
  .hero-avatar-badge svg { width:46%; height:46%; stroke:#fff; fill:none; stroke-width:1.6; stroke-linecap:round; stroke-linejoin:round; }
  .site-footer { border-top:1px solid var(--border); }
  .footer-container { max-width:1140px; margin:0 auto; padding:1.5rem; display:flex; align-items:center; justify-content:space-between; gap:1rem; flex-wrap:wrap; }
  .footer-brand { display:flex; align-items:center; gap:.65rem; }
  .footer-name { margin:0; font-weight:700; }
  .footer-tagline, .footer-location { margin:0; color:var(--text-muted); font-size:.85rem; }
  @media (max-width:760px) { .hero-section { justify-content:center; text-align:center; } .hero-avatar { order:-1; } }
</style>
</head>
<body>
  <nav class="navbar" aria-label="Main navigation">
    <div class="navbar-container">
      <span class="nav-logo">
        <span class="nav-logo-badge" aria-hidden="true"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.5 3.8 5.5 3.8 9s-1.3 6.5-3.8 9c-2.5-2.5-3.8-5.5-3.8-9s1.3-6.5 3.8-9Z"/></svg></span>
        Back2You
      </span>
      <a href="/login" class="btn btn-primary">Sign In</a>
    </div>
  </nav>

  <header class="hero-section">
    <div class="hero-text">
      <p class="hero-greeting">Camarines Sur Polytechnic Colleges</p>
      <h1 class="landing-headline">Modernizing the Campus <span>Lost &amp; Found</span></h1>
      <div class="hero-notice">This site isn&rsquo;t available right now. Please check back later.</div>
      <p class="hero-tagline">
        Back2You is CSPC&rsquo;s campus lost-and-found platform. Report lost items, post found ones, and let smart
        matching, QR stickers and verified handovers bring belongings back to their owners.
      </p>
      <a class="btn btn-primary" href="/login">Sign In</a>
    </div>
    <div class="hero-avatar" aria-hidden="true">
      <span class="hero-avatar-badge"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.5 3.8 5.5 3.8 9s-1.3 6.5-3.8 9c-2.5-2.5-3.8-5.5-3.8-9s1.3-6.5 3.8-9Z"/></svg></span>
    </div>
  </header>

  <footer class="site-footer">
    <div class="footer-container">
      <div class="footer-brand">
        <span class="nav-logo-badge" aria-hidden="true" style="width:36px;height:36px;"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.5 3.8 5.5 3.8 9s-1.3 6.5-3.8 9c-2.5-2.5-3.8-5.5-3.8-9s1.3-6.5 3.8-9Z"/></svg></span>
        <div>
          <p class="footer-name">Back2You</p>
          <p class="footer-tagline">Lost &amp; found for the CSPC community</p>
        </div>
      </div>
      <p class="footer-location">Camarines Sur Polytechnic Colleges · Nabua, Camarines Sur</p>
    </div>
  </footer>
</body>
</html>`;

// Browser assets referenced by the HTML pages, mapped to their files on disk.
function assetFile(urlPath) {
  if (urlPath === '/icons.js') return path.join(__dirname, 'icons.js');
  if (urlPath === '/vendor/qrcode.js') return require.resolve('qrcode-generator/qrcode.js');
  if (urlPath === '/vendor/jsQR.js') return require.resolve('jsqr/dist/jsQR.js');
  // three's package.json "exports" map only lists the ESM/CJS entry points, so
  // the UMD/global build can't be resolved as a subpath import. Derive its path
  // from the main entry instead, since both files live in the same build/ dir.
  if (urlPath === '/vendor/three.min.js') return path.join(path.dirname(require.resolve('three')), 'three.min.js');
  if (urlPath === '/vendor/leaflet.js') return require.resolve('leaflet/dist/leaflet.js');
  if (urlPath === '/vendor/leaflet.css') return require.resolve('leaflet/dist/leaflet.css');
  const match = /^\/(css|js)\/([\w.-]+)$/.exec(urlPath);
  return match ? path.join(__dirname, match[1], match[2]) : null;
}

// Files only change on deploy (which restarts the app) in production; during
// development, re-read them on every request so edits show up immediately.
const cacheAssetInfo = () => process.env.NODE_ENV === 'production';

const assetVersions = new Map();
function assetVersion(urlPath) {
  if (!cacheAssetInfo() || !assetVersions.has(urlPath)) {
    const file = assetFile(urlPath);
    let version = null;
    try {
      version = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 10);
    } catch {
      // Unknown or missing asset: leave its URL unversioned.
    }
    assetVersions.set(urlPath, version);
  }
  return assetVersions.get(urlPath);
}

// Stamp every CSS/JS link with a hash of its contents so browsers fetch new files
// after each deploy without anyone editing ?v= tags by hand.
const pageCache = new Map();
function sendPage(res, file) {
  if (!cacheAssetInfo() || !pageCache.has(file)) {
    const html = fs
      .readFileSync(file, 'utf8')
      .replace(/(src|href)="(\/(?:css|js|vendor)\/[\w.-]+|\/icons\.js)(?:\?v=[^"]*)?"/g, (whole, attr, urlPath) => {
        const version = assetVersion(urlPath);
        return version ? `${attr}="${urlPath}?v=${version}"` : whole;
      });
    pageCache.set(file, html);
  }
  res.set('Cache-Control', 'no-cache');
  res.type('html').send(pageCache.get(file));
}

// Versioned asset URLs never change content, so they can be cached for a year.
function setAssetCacheHeaders(res) {
  res.set('Cache-Control', res.req.query.v ? 'public, max-age=31536000, immutable' : 'no-cache');
}

function createApp() {
  const app = express();
  const isProduction = process.env.NODE_ENV === 'production';
  // Resolve configured paths once so sendFile/static serving work with values
  // such as DATA_DIR=./data in production environments.
  const dataDir = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
  const sessionSecret = process.env.SESSION_SECRET || (isProduction ? '' : 'cspc-lostfound-development-only');

  if (!sessionSecret) {
    throw new Error('SESSION_SECRET must be configured in production.');
  }

  fs.mkdirSync(path.join(dataDir, 'uploads'), { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'sessions'), { recursive: true });
  if (isProduction) {
    app.set('trust proxy', 1);
  }

  app.disable('x-powered-by');
  // Gzips HTML/CSS/JS/JSON responses (notably the 600KB+ three.min.js bundle on first
  // visit); already-compressed formats like images skip it automatically.
  app.use(compression());
  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      // Location only for this site's own pages: the handover meetup asks for one reading
      // when a student agrees to share it. Embedded frames can never ask.
      // The microphone is allowed for this site's own pages only, for dictating a report in
      // the Quick Report Assistant. Display-capture and camera are allowed the same way, for
      // the built-in QR scanner: it shares the screen/window/tab on devices that support that,
      // and falls back to the camera on phones (no screen-capture API) for a printed sticker.
      // Third-party frames still get nothing, and frames of this site are blocked outright by
      // frame-ancestors/X-Frame-Options, so (self) is the whole surface. The browser still asks
      // the student before any audio/video is captured or a screen is shared.
      'Permissions-Policy': 'geolocation=(self), microphone=(self), display-capture=(self), camera=(self)',
      // Scripts only from this site (no inline code or handlers); inline style
      // attributes are still used by some markup. QR codes and photo previews use data:/blob: images.
      // OpenStreetMap tiles draw the small map of a shared meetup location.
      'Content-Security-Policy': [
        "default-src 'self'",
        // Google Identity Services (the "Sign in with Google" button) loads its script
        // from here and renders its button/consent prompt in an iframe from here too.
        "script-src 'self' https://accounts.google.com/gsi/client",
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
        "font-src 'self' https://fonts.gstatic.com",
        "img-src 'self' data: blob: https://tile.openstreetmap.org",
        "connect-src 'self' https://accounts.google.com",
        'frame-src https://accounts.google.com',
        "object-src 'none'",
        "base-uri 'self'",
        "form-action 'self'",
        "frame-ancestors 'none'",
      ].join('; '),
    });
    if (isProduction) res.set('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
    next();
  });

  app.use(express.json({ limit: '256kb' }));
  app.use(express.urlencoded({ extended: true, limit: '64kb' }));
  // A database-backed store so sessions survive restarts/redeploys on hosts with ephemeral
  // disks; local dev and tests (no DATABASE_URL) fall back to on-disk sessions.
  const sessionStore = postgresStore.isConfigured()
    ? new PgSessionStore({ pool: postgresStore.getPool(), tableName: 'app_sessions', createTableIfMissing: true })
    : new FileStore({ path: path.join(dataDir, 'sessions'), ttl: 86400, retries: 0 });

  app.use(
    session({
      name: 'cspc.sid',
      secret: sessionSecret,
      store: sessionStore,
      resave: false,
      saveUninitialized: false,
      cookie: {
        httpOnly: true,
        sameSite: 'lax',
        secure: isProduction,
        maxAge: 1000 * 60 * 60 * 24,
      },
    })
  );

  // A session whose account was deleted starts over as a signed-out visitor.
  app.use((req, res, next) => {
    if (req.session?.user && authRoutes.isAccountRemoved(req.session.user.id)) {
      return req.session.regenerate(() => next());
    }
    next();
  });

  // While the admin-managed allowlist holds any emails, the whole site (not just
  // register/login) is hidden from anyone who isn't on it: visitors see an "unavailable"
  // page instead of the app. Admins always bypass this, and a handful of paths (the
  // login page, its assets, and the auth API, which already enforces its own allowlist
  // check with a clearer message) stay reachable. getAllowedEmailsDirect() queries the
  // database directly, not through the per-request transaction context set up below,
  // since this must run on every request, not just /api/* ones.
  const allowlistExemptPaths = new Set(['/login', '/login.html', '/icons.js', '/api/messenger/webhook']);
  const allowlistExemptPrefixes = ['/css/', '/js/', '/vendor/', '/api/auth/'];
  app.use(async (req, res, next) => {
    if (req.session?.user?.role === 'admin') return next();
    if (allowlistExemptPaths.has(req.path) || allowlistExemptPrefixes.some((prefix) => req.path.startsWith(prefix))) {
      return next();
    }
    let allowedEmails;
    try {
      allowedEmails = await postgresStore.getAllowedEmailsDirect();
    } catch (error) {
      console.error(`Could not read the allowlist (${postgresStore.connectionTarget()}):`, error.message);
      return next();
    }
    if (allowedEmails.length === 0) return next();

    const sessionEmail = req.session?.user?.email ? String(req.session.user.email).trim().toLowerCase() : null;
    if (sessionEmail && allowedEmails.some((entry) => entry.email === sessionEmail)) return next();

    const sendUnavailable = () => {
      if (req.path.startsWith('/api/')) {
        return res.status(503).json({ success: false, message: "This site isn't available right now." });
      }
      res.status(503).type('html').send(siteUnavailableHtml);
    };
    if (req.session?.user) return req.session.regenerate(sendUnavailable);
    sendUnavailable();
  });

  const databaseRequest = postgresStore.requestMiddleware();
  app.use('/api', (req, res, next) => {
    if (req.method === 'POST' && ['/items', '/items/'].includes(req.path)) return next();
    databaseRequest(req, res, next);
  });
  // A session whose email was blocked after it signed in starts over as a signed-out
  // visitor. This reads the (database-backed) blocklist, so it must run after
  // databaseRequest has opened this request's transaction context.
  app.use('/api', (req, res, next) => {
    try {
      if (req.session?.user && authRoutes.isEmailBlocked(req.session.user.email)) {
        return req.session.regenerate(() => next());
      }
    } catch {
      // No transaction context for this request (e.g. the multipart item-upload
      // route skips it above); the next /api request will still catch a blocked session.
    }
    next();
  });
  app.use('/api/auth', authRoutes);
  app.use('/api/items', itemRoutes);
  app.use('/api/messenger', messengerRoutes);
  app.use('/api/stats', (req, res) => res.redirect('/api/items/stats'));
  app.use('/uploads', express.static(path.join(dataDir, 'uploads'), { fallthrough: false, maxAge: '7d' }));

  const page = (name) => path.join(__dirname, 'public', name);

  app.get('/admin.html', (req, res) => {
    if (!req.session?.user) return res.redirect('/login?redirect=/admin.html');
    if (req.session.user.role !== 'admin') return res.redirect('/');
    sendPage(res, path.join(__dirname, 'admin.html'));
  });

  app.get(['/browse.html', '/item-detail.html'], (req, res) => res.redirect(302, '/index.html#items'));
  app.get('/report-lost.html', (req, res) => res.redirect(302, '/index.html?report=lost#itemForm'));
  app.get('/report-found.html', (req, res) => res.redirect(302, '/index.html?report=found#itemForm'));
  app.get(['/found', '/match-reference', '/index.html'], (req, res) => sendPage(res, page('index.html')));
  app.get(['/home', '/home.html'], (req, res) => {
    if (req.session?.user) return res.redirect(302, '/');
    sendPage(res, page('home.html'));
  });
  // Signed-in students and employees go straight to the portal; visitors see the public landing page.
  app.get('/', (req, res) => {
    const user = req.session?.user;
    if (user?.role === 'admin') return res.redirect(302, '/admin.html');
    sendPage(res, page(user ? 'index.html' : 'home.html'));
  });
  app.get('/login', (req, res) => {
    const user = req.session?.user;
    if (user?.role === 'admin') return res.redirect(302, '/admin.html');
    if (user?.role === 'student' || user?.role === 'employee') return res.redirect(302, '/');
    sendPage(res, page('login.html'));
  });
  app.get(['/login.html', '/about.html'], (req, res) => sendPage(res, page(path.basename(req.path))));

  app.use(express.static(path.join(__dirname, 'public')));
  // Serve only browser assets from the project root; server code, scripts and data stay private.
  app.use('/css', express.static(path.join(__dirname, 'css'), { setHeaders: setAssetCacheHeaders }));
  app.use('/js', express.static(path.join(__dirname, 'js'), { setHeaders: setAssetCacheHeaders }));
  app.get(
    [
      '/icons.js',
      '/vendor/qrcode.js',
      '/vendor/jsQR.js',
      '/vendor/three.min.js',
      '/vendor/leaflet.js',
      '/vendor/leaflet.css',
    ],
    (req, res) => {
      setAssetCacheHeaders(res);
      res.sendFile(assetFile(req.path));
    }
  );

  app.use('/api/*', (req, res) => res.status(404).json({ success: false, message: 'API endpoint not found.' }));

  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ success: false, message: 'Image must be 5 MB or smaller.' });
    }
    if (err.name === 'MulterError' || err.status || err.type === 'entity.too.large') {
      return res
        .status(err.status === 413 || err.type === 'entity.too.large' ? 413 : err.status || 400)
        .json({ success: false, message: err.message || 'Invalid upload.' });
    }
    if (req.path.startsWith('/api/')) {
      console.error('API error:', err);
      return res.status(500).json({ success: false, message: 'An unexpected server error occurred.' });
    }
    console.error('Server error:', err);
    res.status(500).send('An unexpected server error occurred.');
  });

  return app;
}

// Two instances can end up starting at almost the same moment (a deploy's old and new
// process briefly overlapping, or a crash-looping restart), and their first-run
// CREATE/ALTER TABLE statements then collide on Postgres's system catalog with
// "tuple concurrently updated" - transient, and gone as soon as the other instance's
// statement commits, so retry a few times instead of crashing the whole process over
// a race that clears itself within a second or two.
async function initializeDatabaseWithRetry(attempts = 5, baseDelayMs = 500) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await postgresStore.initialize();
      return;
    } catch (error) {
      const retryable = /tuple concurrently updated|deadlock detected/i.test(error.message);
      if (!retryable || attempt === attempts) throw error;
      const delay = baseDelayMs * attempt + Math.random() * baseDelayMs;
      console.warn(
        `Database setup hit a transient conflict (attempt ${attempt}/${attempts}), retrying in ${Math.round(delay)}ms:`,
        error.message
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

async function startServer() {
  const PORT = process.env.PORT || 3000;
  const app = createApp();
  const server = app.listen(PORT, '0.0.0.0', () => console.log(`Server running at: http://localhost:${PORT}`));

  // Bind the port before remote database setup so managed hosts can detect
  // the application within their startup timeout.
  try {
    if (process.env.NODE_ENV === 'production' || postgresStore.isConfigured()) {
      await initializeDatabaseWithRetry();
    }
    await authRoutes.ensureDefaultAdminAccount();
  } catch (error) {
    server.close(() => {});
    throw error;
  }
  return server;
}

if (process.env.NODE_ENV !== 'test') {
  startServer().catch((error) => {
    console.error('Server startup failed:', error.message);
    process.exitCode = 1;
  });
}

module.exports = { createApp, startServer };
