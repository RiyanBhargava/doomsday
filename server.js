// server.js — Main entry point
require('dotenv').config();
const express = require('express');
const session = require('express-session');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const gdrive = require('./services/gdrive');
const db = require('./database');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

// ── Middleware ─────────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const sessionMiddleware = session({
  secret: process.env.SESSION_SECRET || 'doomsday-secret-change-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 24 * 60 * 60 * 1000, // 24 hours
    httpOnly: true,
    sameSite: 'lax'
  }
});
app.use(sessionMiddleware);

// Share session with socket.io
io.engine.use(sessionMiddleware);

// Make io accessible in routes
app.set('io', io);

// ── Admin page protection (BEFORE static files) ──────────────────────────────
app.use('/admin.html', (req, res, next) => {
  if (!req.session || !req.session.user || req.session.user.role !== 'admin') {
    return res.status(404).sendFile(path.join(__dirname, 'public', '404.html'));
  }
  next();
});

// Static files
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// ── Socket.io broadcast hooks (BEFORE routes) ────────────────────────────────
app.use('/api/submit', (req, res, next) => {
  const origJson = res.json.bind(res);
  res.json = (data) => {
    if (data && data.success) {
      io.emit('new_activity');
    }
    return origJson(data);
  };
  next();
});

app.use('/api/question', (req, res, next) => {
  if (req.method === 'GET') {
    const origJson = res.json.bind(res);
    res.json = (data) => {
      if (data && data.id) io.emit('new_activity');
      return origJson(data);
    };
  }
  next();
});

// ── Routes ────────────────────────────────────────────────────────────────────
const authRoutes = require('./routes/auth');
const apiRoutes = require('./routes/api');
const adminRoutes = require('./routes/admin');

// Serve public config (Google Client ID + domain) to frontend
app.get('/api/config', (req, res) => {
  res.json({
    googleClientId: process.env.GOOGLE_CLIENT_ID,
    allowedDomain: process.env.ALLOWED_DOMAIN || 'dubai.bits-pilani.ac.in'
  });
});

app.use('/auth', authRoutes);
app.use('/api', apiRoutes);
app.use('/admin', adminRoutes);

// ── 404 handler ───────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).sendFile(path.join(__dirname, 'public', '404.html'));
});

// ── Socket.io ─────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  socket.on('broadcast_announcement', (msg) => {
    io.emit('announcement', msg);
  });

  socket.on('broadcast_announcement_clear', () => {
    io.emit('announcement_clear');
  });

  socket.on('maintenance_change', (active) => {
    if (active) io.emit('maintenance');
  });
});

// ── Start ─────────────────────────────────────────────────────────────────────
server.listen(PORT, async () => {
  console.log(`\n  ╔══════════════════════════════════════════╗`);
  console.log(`  ║     DOOMSDAY ARENA 2026 SERVER           ║`);
  console.log(`  ║     Running on http://localhost:${PORT}      ║`);
  console.log(`  ╚══════════════════════════════════════════╝\n`);

  // Initialize Google Drive sync
  const driveOk = await gdrive.init();
  if (driveOk) {
    // Full sync every 1 minute (activity log + submissions log + DB backup)
    const SYNC_INTERVAL = parseInt(process.env.DRIVE_SYNC_INTERVAL) || 60 * 1000;
    setInterval(() => gdrive.fullSync(db), SYNC_INTERVAL);
    // Initial sync on startup
    setTimeout(() => gdrive.fullSync(db), 5000);
  }
});
