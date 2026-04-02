// routes/admin.js — Admin-only API routes
const express = require('express');
const router = express.Router();
const db = require('../database');
const { requireAdmin } = require('../middleware/auth');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

// File upload config
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, '..', 'uploads');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const uniqueName = Date.now() + '-' + file.originalname;
    cb(null, uniqueName);
  }
});
const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 } }); // 50MB limit

// All admin routes require admin role
router.use(requireAdmin);

// ── QUESTIONS CRUD ──────────────────────────────────────────────────────────

// GET /admin/questions — List all questions
router.get('/questions', (req, res) => {
  const questions = db.prepare('SELECT * FROM questions ORDER BY category, sort_order ASC').all();
  res.json(questions);
});

// GET /admin/question/:id — Single question with all details
router.get('/question/:id', (req, res) => {
  const q = db.prepare('SELECT * FROM questions WHERE id = ?').get(req.params.id);
  if (!q) return res.status(404).json({ error: 'Not found' });

  const attachments = db.prepare('SELECT * FROM attachments WHERE question_id = ?').all(q.id);
  const links = db.prepare('SELECT * FROM reference_links WHERE question_id = ?').all(q.id);

  res.json({ ...q, attachments, links });
});

// POST /admin/question — Create question
router.post('/question', (req, res) => {
  const { title, category, body_markdown, answer, answer_mode, sort_order, visible_from, links } = req.body;

  const result = db.prepare(`
    INSERT INTO questions (title, category, body_markdown, answer, answer_mode, sort_order, visible_from)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(title, category, body_markdown, answer || '', answer_mode || 'exact', sort_order || 0, visible_from || null);

  const questionId = result.lastInsertRowid;

  // Insert reference links
  if (links && Array.isArray(links)) {
    const insertLink = db.prepare('INSERT INTO reference_links (question_id, label, url) VALUES (?, ?, ?)');
    links.forEach(l => insertLink.run(questionId, l.label, l.url));
  }

  res.json({ id: questionId, success: true });
});

// PUT /admin/question/:id — Update question
router.put('/question/:id', (req, res) => {
  const { title, category, body_markdown, answer, answer_mode, sort_order, visible_from, links } = req.body;

  db.prepare(`
    UPDATE questions SET title=?, category=?, body_markdown=?, answer=?, answer_mode=?, sort_order=?, visible_from=?, updated_at=CURRENT_TIMESTAMP
    WHERE id=?
  `).run(title, category, body_markdown, answer, answer_mode, sort_order, visible_from || null, req.params.id);

  // Replace links
  db.prepare('DELETE FROM reference_links WHERE question_id = ?').run(req.params.id);
  if (links && Array.isArray(links)) {
    const insertLink = db.prepare('INSERT INTO reference_links (question_id, label, url) VALUES (?, ?, ?)');
    links.forEach(l => insertLink.run(req.params.id, l.label, l.url));
  }

  res.json({ success: true });
});

// DELETE /admin/question/:id
router.delete('/question/:id', (req, res) => {
  // Delete attachments files
  const attachments = db.prepare('SELECT filepath FROM attachments WHERE question_id = ?').all(req.params.id);
  attachments.forEach(a => {
    try { fs.unlinkSync(path.join(__dirname, '..', a.filepath)); } catch (e) {}
  });

  db.prepare('DELETE FROM questions WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// POST /admin/question/:id/upload — Upload attachment
router.post('/question/:id/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });

  const filepath = 'uploads/' + req.file.filename;
  db.prepare('INSERT INTO attachments (question_id, filename, filepath) VALUES (?, ?, ?)').run(
    req.params.id, req.file.originalname, filepath
  );

  res.json({ success: true, filename: req.file.originalname, filepath });
});

// DELETE /admin/attachment/:id
router.delete('/attachment/:id', (req, res) => {
  const att = db.prepare('SELECT * FROM attachments WHERE id = ?').get(req.params.id);
  if (att) {
    try { fs.unlinkSync(path.join(__dirname, '..', att.filepath)); } catch (e) {}
    db.prepare('DELETE FROM attachments WHERE id = ?').run(req.params.id);
  }
  res.json({ success: true });
});

// ── ACTIVITY LOG ─────────────────────────────────────────────────────────────
router.get('/activity', (req, res) => {
  const limit = parseInt(req.query.limit) || 200;
  const offset = parseInt(req.query.offset) || 0;
  const category = req.query.category;
  const activityType = req.query.type;
  const teamFilter = req.query.team;

  let query = `
    Select a.*, t.team_name, t.id as team_number, q.title as question_title, q.category as question_category
    FROM activity_log a
    JOIN teams t ON a.team_id = t.id
    LEFT JOIN questions q ON a.question_id = q.id
    WHERE 1=1
  `;
  const params = [];

  if (category) { query += ' AND a.category = ?'; params.push(category); }
  if (activityType) { query += ' AND a.activity_type = ?'; params.push(activityType); }
  if (teamFilter) { query += ' AND t.team_name LIKE ?'; params.push(`%${teamFilter}%`); }

  query += ' ORDER BY a.created_at DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  const rows = db.prepare(query).all(...params);

  // Add time since last activity for each team
  const result = rows.map(row => {
    const prev = db.prepare(`
      SELECT created_at FROM activity_log WHERE team_id = ? AND id < ? ORDER BY id DESC LIMIT 1
    `).get(row.team_id, row.id);

    let timeSinceLast = null;
    if (prev) {
      timeSinceLast = Math.floor((new Date(row.created_at) - new Date(prev.created_at)) / 1000);
    }

    // Time taken to solve (for correct submissions)
    let timeTaken = null;
    if (row.activity_type === 'correct_submission' && row.metadata) {
      try { timeTaken = JSON.parse(row.metadata).time_taken; } catch (e) {}
    }

    return { ...row, timeSinceLast, timeTaken };
  });

  const total = db.prepare('SELECT COUNT(*) as count FROM activity_log').get();
  res.json({ rows: result, total: total.count });
});

// ── DASHBOARD STATS ──────────────────────────────────────────────────────────
router.get('/stats', (req, res) => {
  const totalTeams = db.prepare('SELECT COUNT(*) as count FROM teams WHERE banned = 0').get().count;
  const totalSubmissions = db.prepare('SELECT COUNT(*) as count FROM submissions').get().count;
  const activeUsers = db.prepare(`SELECT COUNT(DISTINCT team_id) as count FROM activity_log WHERE created_at > datetime('now', '-30 minutes')`).get().count;

  const categories = ['AI', 'CP', 'HEX', 'DEV'];
  const perCategory = {};
  for (const cat of categories) {
    const totalQ = db.prepare('SELECT COUNT(*) as count FROM questions WHERE category = ?').get(cat).count;
    const totalSub = db.prepare('SELECT COUNT(*) as count FROM submissions WHERE question_id IN (SELECT id FROM questions WHERE category = ?)').get(cat).count;
    perCategory[cat] = { questions: totalQ, submissions: totalSub };
  }

  res.json({ totalTeams, totalSubmissions, activeUsers, perCategory });
});

// ── SETTINGS ─────────────────────────────────────────────────────────────────
router.get('/settings', (req, res) => {
  const settings = db.prepare('SELECT * FROM settings').all();
  const obj = {};
  settings.forEach(s => obj[s.key] = s.value);
  res.json(obj);
});

router.put('/settings', (req, res) => {
  const allowed = ['competition_start', 'competition_end', 'maintenance_mode'];
  const update = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');

  for (const [key, value] of Object.entries(req.body)) {
    if (allowed.includes(key)) {
      update.run(key, String(value));
    }
  }
  res.json({ success: true });
});

// ── ANNOUNCEMENTS ────────────────────────────────────────────────────────────
router.post('/announcement', (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: 'Message required' });

  db.prepare('INSERT INTO announcements (message) VALUES (?)').run(message);
  // Socket.io broadcast handled in server.js
  res.json({ success: true, message });
});

// ── TEAM MANAGEMENT ──────────────────────────────────────────────────────────
router.get('/teams', (req, res) => {
  const teams = db.prepare(`
    SELECT t.*,
      (SELECT COUNT(*) FROM submissions WHERE team_id = t.id) as submission_count,
      (SELECT COUNT(*) FROM team_members WHERE team_id = t.id) as member_count
    FROM teams t
    ORDER BY t.id ASC
  `).all();

  // Attach members list to each team
  const getMembers = db.prepare(`SELECT u.email, u.name FROM team_members tm JOIN users u ON tm.user_id = u.id WHERE tm.team_id = ?`);
  const result = teams.map(t => ({
    ...t,
    members: getMembers.all(t.id)
  }));

  res.json(result);
});

router.post('/team/ban/:id', (req, res) => {
  db.prepare('UPDATE teams SET banned = 1 WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

router.post('/team/unban/:id', (req, res) => {
  db.prepare('UPDATE teams SET banned = 0 WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

router.post('/team/reset/:id', (req, res) => {
  const teamId = req.params.id;

  res.json({ success: true });
});

router.post('/team/register', (req, res) => {
  const { teamName, teamCode } = req.body;
  if (!teamName || !teamCode) return res.status(400).json({ error: 'Team name and team code required' });

  try {
    db.prepare('INSERT INTO teams (team_name, team_code) VALUES (?, ?)').run(teamName, teamCode);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: 'Team name already exists' });
  }
});

// ── SUBMISSIONS VIEWER ────────────────────────────────────────────────────────
router.get('/submissions', (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  const offset = parseInt(req.query.offset) || 0;
  const category = req.query.category;
  const teamFilter = req.query.team;

  let query = `
    Select s.*, t.team_name, t.id as team_number, q.title as question_title, q.category
    FROM submissions s
    JOIN teams t ON s.team_id = t.id
    JOIN questions q ON s.question_id = q.id
    WHERE 1=1
  `;
  const params = [];

  if (category) { query += ' AND q.category = ?'; params.push(category); }
  if (teamFilter) { query += ' AND t.team_name LIKE ?'; params.push(`%${teamFilter}%`); }

  query += ' ORDER BY s.submitted_at DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  const rows = db.prepare(query).all(...params);

  // Attach files to each submission
  const result = rows.map(row => {
    return { ...row, files: [] };
  });

  let countQuery = 'SELECT COUNT(*) as count FROM submissions s JOIN questions q ON s.question_id = q.id JOIN teams t ON s.team_id = t.id WHERE 1=1';
  const countParams = [];
  if (category) { countQuery += ' AND q.category = ?'; countParams.push(category); }
  if (teamFilter) { countQuery += ' AND t.team_name LIKE ?'; countParams.push(`%${teamFilter}%`); }

  const total = db.prepare(countQuery).get(...countParams).count;
  res.json({ rows: result, total });
});

// ── EXPORT SUBMISSIONS ───────────────────────────────────────────────────────
router.get('/export-submissions', (req, res) => {
  const rows = db.prepare(`
    Select s.submitted_at, t.id as team_number, t.team_name, q.category, q.title as question_title, s.submitted_value
    FROM submissions s
    JOIN teams t ON s.team_id = t.id
    JOIN questions q ON s.question_id = q.id
    ORDER BY s.submitted_at DESC
  `).all();

  let csv = 'Timestamp,Team #,Team Name,Category,Question,Submitted Value\n';
  rows.forEach(r => {
    csv += `"${r.submitted_at}","${r.team_number}","${r.team_name}","${r.category}","${r.question_title}","${(r.submitted_value || '').replace(/"/g, '""')}"\n`;
  });

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename=submissions.csv');
  res.send(csv);
});

// ── EXPORT ACTIVITY LOG ──────────────────────────────────────────────────────
router.get('/export-activity', (req, res) => {
  const rows = db.prepare(`
    Select a.created_at, t.id as team_number, t.team_name, a.category, 
      q.title as question_title, a.activity_type, a.submitted_value
    FROM activity_log a
    JOIN teams t ON a.team_id = t.id
    LEFT JOIN questions q ON a.question_id = q.id
    ORDER BY a.created_at DESC
  `).all();

  let csv = 'Timestamp,Team #,Team Name,Category,Question,Activity Type,Submitted Value\n';
  rows.forEach(r => {
    csv += `"${r.created_at}","${r.team_number}","${r.team_name}","${r.category || ''}","${r.question_title || ''}","${r.activity_type}","${(r.submitted_value || '').replace(/"/g, '""')}"\n`;
  });

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename=activity_log.csv');
  res.send(csv);
});

module.exports = router;
