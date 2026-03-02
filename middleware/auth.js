// middleware/auth.js — Authentication and authorization middleware
const db = require('../database');

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'acm@dubai.bits-pilani.ac.in';

// Check if user is logged in
function requireLogin(req, res, next) {
  if (!req.session || !req.session.user) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  next();
}

// Check if user is admin
function requireAdmin(req, res, next) {
  if (!req.session || !req.session.user) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  if (req.session.user.role !== 'admin') {
    return res.status(403).json({ error: 'Access denied' });
  }
  next();
}

// Check if user is a participant with a registered team
function requireTeam(req, res, next) {
  if (!req.session || !req.session.user) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  const membership = db.prepare('SELECT team_id FROM team_members WHERE user_id = ?').get(req.session.user.id);
  if (!membership) {
    return res.status(400).json({ error: 'No team registered' });
  }
  const team = db.prepare('SELECT * FROM teams WHERE id = ?').get(membership.team_id);
  if (!team) {
    return res.status(400).json({ error: 'No team registered' });
  }
  if (team.banned) {
    return res.status(403).json({ error: 'banned' });
  }
  req.team = team;
  next();
}

// Check maintenance mode
function checkMaintenance(req, res, next) {
  const setting = db.prepare("SELECT value FROM settings WHERE key = 'maintenance_mode'").get();
  if (setting && setting.value === '1') {
    if (req.session && req.session.user && req.session.user.role === 'admin') {
      return next(); // Admins bypass maintenance
    }
    return res.status(503).json({ error: 'Maintenance mode active' });
  }
  next();
}

// Process Google OAuth token and create/fetch user
function processGoogleLogin(profile) {
  const email = profile.email;
  const name = profile.name;
  const picture = profile.picture;
  const role = email === ADMIN_EMAIL ? 'admin' : 'participant';

  // Upsert user
  let user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user) {
    db.prepare('INSERT INTO users (email, name, picture, role) VALUES (?, ?, ?, ?)').run(email, name, picture, role);
    user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  } else {
    db.prepare('UPDATE users SET name = ?, picture = ?, role = ? WHERE email = ?').run(name, picture, role, email);
    user.name = name;
    user.picture = picture;
    user.role = role;
  }

  return user;
}

module.exports = { requireLogin, requireAdmin, requireTeam, checkMaintenance, processGoogleLogin, ADMIN_EMAIL };
