// routes/auth.js — Google OAuth and session routes
const express = require('express');
const router = express.Router();
const { processGoogleLogin } = require('../middleware/auth');
const db = require('../database');

// Helper: get user's team via team_members
function getUserTeam(userId) {
  const membership = db.prepare('SELECT team_id FROM team_members WHERE user_id = ?').get(userId);
  if (!membership) return null;
  return db.prepare('SELECT * FROM teams WHERE id = ?').get(membership.team_id);
}

// POST /auth/google — Receive Google ID token from frontend
router.post('/google', (req, res) => {
  const { credential } = req.body;
  if (!credential) return res.status(400).json({ error: 'No credential provided' });

  try {
    const parts = credential.split('.');
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());

    const email = payload.email;
    const name = payload.name;
    const picture = payload.picture;
    const hd = payload.hd;

    const allowedDomain = process.env.ALLOWED_DOMAIN || 'dubai.bits-pilani.ac.in';
    if (hd !== allowedDomain) {
      return res.status(403).json({ error: `Only @${allowedDomain} accounts are allowed` });
    }

    const user = processGoogleLogin({ email, name, picture });

    const team = getUserTeam(user.id);

    req.session.user = {
      id: user.id,
      email: user.email,
      name: user.name,
      picture: user.picture,
      role: user.role
    };

    res.json({
      user: req.session.user,
      hasTeam: !!team,
      team: team ? { id: team.id, team_name: team.team_name } : null,
      banned: team ? !!team.banned : false
    });
  } catch (err) {
    console.error('Google auth error:', err);
    res.status(500).json({ error: 'Authentication failed' });
  }
});

// POST /auth/create-team — Create a new team
router.post('/create-team', (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: 'Not authenticated' });

  const { teamName, teamCode } = req.body;
  if (!teamName || !teamCode) return res.status(400).json({ error: 'Team name and team code are required' });

  if (teamName.length > 50) return res.status(400).json({ error: 'Team name too long (max 50 chars)' });
  if (teamCode.length < 4) return res.status(400).json({ error: 'Team code must be at least 4 characters' });

  // Check if user already in a team
  const existing = db.prepare('SELECT id FROM team_members WHERE user_id = ?').get(req.session.user.id);
  if (existing) return res.status(400).json({ error: 'You are already in a team' });

  // Check name uniqueness
  const dupName = db.prepare('SELECT id FROM teams WHERE team_name = ?').get(teamName);
  if (dupName) return res.status(400).json({ error: 'Team name already taken' });

  try {
    const result = db.prepare('INSERT INTO teams (team_name, team_code) VALUES (?, ?)').run(teamName, teamCode);
    const teamId = result.lastInsertRowid;

    // Add creator as first member
    db.prepare('INSERT INTO team_members (team_id, user_id) VALUES (?, ?)').run(teamId, req.session.user.id);

    const team = db.prepare('SELECT * FROM teams WHERE id = ?').get(teamId);
    res.json({ success: true, team: { id: team.id, team_name: team.team_name } });
  } catch (err) {
    console.error('Team creation error:', err);
    res.status(500).json({ error: 'Failed to create team' });
  }
});

// POST /auth/join-team — Join an existing team
router.post('/join-team', (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: 'Not authenticated' });

  const { teamName, teamCode } = req.body;
  if (!teamName || !teamCode) return res.status(400).json({ error: 'Team name and team code are required' });

  // Check if user already in a team
  const existing = db.prepare('SELECT id FROM team_members WHERE user_id = ?').get(req.session.user.id);
  if (existing) return res.status(400).json({ error: 'You are already in a team' });

  // Find team
  const team = db.prepare('SELECT * FROM teams WHERE team_name = ?').get(teamName);
  if (!team) return res.status(404).json({ error: 'Team not found' });

  // Verify code
  if (team.team_code !== teamCode) return res.status(403).json({ error: 'Incorrect team code' });

  // Check member count
  const memberCount = db.prepare('SELECT COUNT(*) as count FROM team_members WHERE team_id = ?').get(team.id).count;
  if (memberCount >= 4) return res.status(400).json({ error: 'Team is full (max 4 members)' });

  if (team.banned) return res.status(403).json({ error: 'This team has been banned' });

  try {
    db.prepare('INSERT INTO team_members (team_id, user_id) VALUES (?, ?)').run(team.id, req.session.user.id);
    res.json({ success: true, team: { id: team.id, team_name: team.team_name } });
  } catch (err) {
    console.error('Team join error:', err);
    res.status(500).json({ error: 'Failed to join team' });
  }
});

// GET /auth/me — Get current session info
router.get('/me', (req, res) => {
  if (!req.session.user) return res.json({ loggedIn: false });

  const team = getUserTeam(req.session.user.id);
  res.json({
    loggedIn: true,
    user: req.session.user,
    hasTeam: !!team,
    team: team ? { id: team.id, team_name: team.team_name } : null,
    banned: team ? !!team.banned : false
  });
});

// POST /auth/logout
router.post('/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

module.exports = router;
