// routes/api.js — Participant-facing API routes
const express = require('express');
const router = express.Router();
const db = require('../database');
const { requireLogin, requireTeam, checkMaintenance } = require('../middleware/auth');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const gdrive = require('../services/gdrive');

// File upload config — memory storage (files go straight to Google Drive, not saved locally)
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } }); // 50MB

// ── Helper: check competition time ──────────────────────────────────────────
function isCompetitionActive() {
  const start = db.prepare("SELECT value FROM settings WHERE key = 'competition_start'").get();
  const end = db.prepare("SELECT value FROM settings WHERE key = 'competition_end'").get();
  const now = new Date();

  if (start && start.value && new Date(start.value) > now) return { active: false, reason: 'not_started', start: start.value, end: end?.value };
  if (end && end.value && new Date(end.value) < now) return { active: false, reason: 'ended', start: start?.value, end: end.value };
  return { active: true, start: start?.value, end: end?.value };
}

// ── GET /api/competition-info ───────────────────────────────────────────────
router.get('/competition-info', (req, res) => {
  const status = isCompetitionActive();
  const maintenance = db.prepare("SELECT value FROM settings WHERE key = 'maintenance_mode'").get();
  res.json({ ...status, maintenance: maintenance?.value === '1' });
});

// ── GET /api/questions/:category ─────────────────────────────────────────────
router.get('/questions/:category', requireLogin, requireTeam, checkMaintenance, (req, res) => {
  const category = req.params.category.toUpperCase();
  if (!['AI', 'CP', 'HEX', 'DEV'].includes(category)) {
    return res.status(400).json({ error: 'Invalid category' });
  }

  const questions = db.prepare(`
    SELECT id, title, category, sort_order, visible_from
    FROM questions WHERE category = ? ORDER BY sort_order ASC
  `).all(category);

  // Get questions this team has submitted to
  const submittedIds = db.prepare(`
    SELECT DISTINCT question_id FROM submissions WHERE team_id = ?
  `).all(req.team.id).map(s => s.question_id);

  const now = new Date();

  const result = questions.map((q) => {
    const hasSubmitted = submittedIds.includes(q.id);
    const isVisible = !q.visible_from || new Date(q.visible_from) <= now;

    return {
      id: q.id,
      title: q.title,
      category: q.category,
      submitted: hasSubmitted,
      unlocked: isVisible,
      sort_order: q.sort_order
    };
  });

  res.json(result);
});

// ── GET /api/question/:id — Full question detail ─────────────────────────────
router.get('/question/:id', requireLogin, requireTeam, checkMaintenance, (req, res) => {
  const question = db.prepare('SELECT id, title, category, body_markdown, sort_order, visible_from FROM questions WHERE id = ?').get(req.params.id);
  if (!question) return res.status(404).json({ error: 'Question not found' });

  // Log view
  db.prepare('INSERT INTO question_views (team_id, question_id) VALUES (?, ?)').run(req.team.id, question.id);
  db.prepare(`INSERT INTO activity_log (team_id, question_id, activity_type, category) VALUES (?, ?, 'question_viewed', ?)`).run(req.team.id, question.id, question.category);

  // Get attachments
  const attachments = db.prepare('SELECT id, filename, filepath FROM attachments WHERE question_id = ?').all(question.id);

  // Get reference links
  const links = db.prepare('SELECT id, label, url FROM reference_links WHERE question_id = ?').all(question.id);

  // Get previous submissions for this team + question
  const submissions = db.prepare('SELECT id, submitted_value, submitted_at FROM submissions WHERE team_id = ? AND question_id = ? ORDER BY submitted_at DESC').all(req.team.id, question.id);

  const previousSubmissions = submissions.map(s => {
    const files = db.prepare('SELECT id, filename, filepath FROM submission_files WHERE submission_id = ?').all(s.id);
    return { ...s, files };
  });

  res.json({
    ...question,
    attachments,
    links,
    submissions_count: submissions.length,
    previous_submissions: previousSubmissions
  });
});

// ── POST /api/submit/:questionId — Save submission (text + files) ────────────
router.post('/submit/:questionId', requireLogin, requireTeam, checkMaintenance, upload.array('files', 10), (req, res) => {
  const question = db.prepare('SELECT * FROM questions WHERE id = ?').get(req.params.questionId);
  if (!question) return res.status(404).json({ error: 'Question not found' });

  const answer = req.body.answer || '';

  if (!answer.trim() && (!req.files || req.files.length === 0)) {
    return res.status(400).json({ error: 'Provide a text answer or attach files' });
  }

  // Save submission
  const result = db.prepare('INSERT INTO submissions (team_id, question_id, submitted_value, is_correct, time_taken) VALUES (?, ?, ?, 0, 0)').run(
    req.team.id, question.id, answer.trim()
  );
  const submissionId = result.lastInsertRowid;

  // Upload files directly to Google Drive (no local storage)
  if (req.files && req.files.length > 0) {
    const insertFile = db.prepare('INSERT INTO submission_files (submission_id, filename, filepath) VALUES (?, ?, ?)');
    for (const file of req.files) {
      // Store a Drive reference path in DB
      const drivePath = `drive://${req.team.team_name}/${question.title}/${file.originalname}`;
      insertFile.run(submissionId, file.originalname, drivePath);

      // Upload buffer to Google Drive (non-blocking)
      gdrive.uploadSubmissionFile(
        file.buffer,
        file.originalname,
        file.mimetype,
        req.team.team_name,
        question.title
      ).catch(err => console.error('Drive upload error:', err.message));
    }
  }

  // Log activity
  db.prepare(`INSERT INTO activity_log (team_id, question_id, activity_type, category, submitted_value) VALUES (?, ?, 'submission', ?, ?)`).run(
    req.team.id, question.id, question.category,
    answer.trim() ? answer.trim().substring(0, 200) : '[file submission]'
  );

  // Trigger Drive activity sync (non-blocking)
  gdrive.syncActivityLog(db).catch(() => {});

  res.json({ success: true, submissionId });
});

// ── GET /api/progress — Team's overall progress ─────────────────────────────
router.get('/progress', requireLogin, requireTeam, (req, res) => {
  const categories = ['AI', 'CP', 'HEX', 'DEV'];
  const progress = {};

  for (const cat of categories) {
    const total = db.prepare('SELECT COUNT(*) as count FROM questions WHERE category = ?').get(cat);
    const submitted = db.prepare('SELECT COUNT(DISTINCT question_id) as count FROM submissions WHERE team_id = ? AND question_id IN (SELECT id FROM questions WHERE category = ?)').get(req.team.id, cat);
    progress[cat] = { total: total.count, submitted: submitted.count };
  }

  res.json({
    team: { name: req.team.team_name, id: req.team.id },
    progress
  });
});

// ── GET /api/dashboard — Team dashboard data ─────────────────────────────────
router.get('/dashboard', requireLogin, requireTeam, (req, res) => {
  const categories = ['AI', 'CP', 'HEX', 'DEV'];
  const categoryProgress = {};

  for (const cat of categories) {
    const questions = db.prepare('SELECT id, title FROM questions WHERE category = ? ORDER BY sort_order ASC').all(cat);

    categoryProgress[cat] = questions.map(q => {
      const subCount = db.prepare('SELECT COUNT(*) as count FROM submissions WHERE team_id = ? AND question_id = ?').get(req.team.id, q.id);
      const lastSub = db.prepare('SELECT submitted_at FROM submissions WHERE team_id = ? AND question_id = ? ORDER BY submitted_at DESC LIMIT 1').get(req.team.id, q.id);

      return {
        id: q.id,
        title: q.title,
        submitted: subCount.count > 0,
        submissionCount: subCount.count,
        lastSubmittedAt: lastSub?.submitted_at || null
      };
    });
  }

  res.json({
    team: { name: req.team.team_name, id: req.team.id },
    categoryProgress
  });
});

// ── GET /api/announcements ───────────────────────────────────────────────────
router.get('/announcements', requireLogin, (req, res) => {
  const anns = db.prepare('SELECT * FROM announcements ORDER BY created_at DESC LIMIT 50').all();
  res.json(anns);
});

module.exports = router;
