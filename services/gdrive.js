// services/gdrive.js — Google Drive sync service
// Uses OAuth2 refresh token to upload to YOUR Google Drive
// Folder: My Drive > Events > Doomsday Arena 2026

const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

const SCOPES = ['https://www.googleapis.com/auth/drive'];

// Subfolders inside the Doomsday Arena 2026 folder
const SUBFOLDERS = ['Submissions', 'Activity_Log', 'Database_Backups'];

let drive = null;
let folderIds = {};   // { 'Submissions': 'driveId', ... }
let rootFolderId = null;
let initialized = false;

// ── Initialize ──────────────────────────────────────────────────────────────
async function init() {
  try {
    const clientId = process.env.GDRIVE_CLIENT_ID;
    const clientSecret = process.env.GDRIVE_CLIENT_SECRET;
    const refreshToken = process.env.GDRIVE_REFRESH_TOKEN;

    if (!clientId || !clientSecret || !refreshToken) {
      console.log('  ⚠  Google Drive credentials not set in .env');
      console.log('     Run "node gdrive-setup.js" to get your refresh token.');
      return false;
    }

    const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, 'http://localhost:4000/callback');
    oauth2Client.setCredentials({ refresh_token: refreshToken });

    drive = google.drive({ version: 'v3', auth: oauth2Client });

    // Find or create: Events > Doomsday Arena 2026
    const eventsFolderId = await findOrCreateFolder('Events', 'root');
    rootFolderId = await findOrCreateFolder('Doomsday Arena 2026', eventsFolderId);

    // Create subfolders
    for (const sub of SUBFOLDERS) {
      folderIds[sub] = await findOrCreateFolder(sub, rootFolderId);
    }

    initialized = true;
    console.log('  ✓  Google Drive sync enabled');
    console.log('     Syncing to: My Drive > Events > Doomsday Arena 2026');
    return true;
  } catch (err) {
    console.error('  ✗  Google Drive init failed:', err.message);
    return false;
  }
}

// ── Folder helpers ──────────────────────────────────────────────────────────
async function findOrCreateFolder(name, parentId) {
  const query = `name='${name}' and mimeType='application/vnd.google-apps.folder' and '${parentId}' in parents and trashed=false`;
  const res = await drive.files.list({ q: query, fields: 'files(id, name)', spaces: 'drive' });

  if (res.data.files.length > 0) {
    return res.data.files[0].id;
  }

  // Create the folder
  const folder = await drive.files.create({
    requestBody: {
      name,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [parentId]
    },
    fields: 'id'
  });
  return folder.data.id;
}

// ── Upload submission file (from memory buffer) ──────────────────────────────
// Creates: Submissions/<TeamName>/<QuestionTitle>/<filename>
async function uploadSubmissionFile(buffer, originalFilename, mimeType, teamName, questionTitle) {
  if (!initialized) return null;
  try {
    // Make team subfolder
    const safeName = sanitize(teamName);
    const teamFolderId = await findOrCreateFolder(safeName, folderIds['Submissions']);

    // Make question subfolder
    const safeQuestion = sanitize(questionTitle);
    const questionFolderId = await findOrCreateFolder(safeQuestion, teamFolderId);

    const { Readable } = require('stream');
    const res = await drive.files.create({
      requestBody: {
        name: originalFilename,
        parents: [questionFolderId]
      },
      media: {
        mimeType: mimeType || 'application/octet-stream',
        body: Readable.from(buffer)
      },
      fields: 'id, name, webViewLink'
    });

    console.log(`  📁 Drive: Uploaded submission → ${safeName}/${safeQuestion}/${originalFilename}`);
    return res.data;
  } catch (err) {
    console.error('  ✗  Drive upload failed:', err.message);
    return null;
  }
}

// ── Upload question attachment ──────────────────────────────────────────────
async function uploadAttachment(localPath, originalFilename) {
  if (!initialized) return null;
  try {
    const res = await drive.files.create({
      requestBody: {
        name: originalFilename,
        parents: [folderIds['Question_Attachments']]
      },
      media: {
        body: fs.createReadStream(localPath)
      },
      fields: 'id, name'
    });

    console.log(`  📁 Drive: Uploaded attachment → ${originalFilename}`);
    return res.data;
  } catch (err) {
    console.error('  ✗  Drive attachment upload failed:', err.message);
    return null;
  }
}

// ── Sync activity log as CSV ────────────────────────────────────────────────
async function syncActivityLog(db) {
  if (!initialized) return;
  try {
    const rows = db.prepare(`
      SELECT al.created_at, al.team_id, t.team_name, al.category,
             q.title AS question_title, al.activity_type, al.submitted_value
      FROM activity_log al
      LEFT JOIN teams t ON al.team_id = t.id
      LEFT JOIN questions q ON al.question_id = q.id
      ORDER BY al.created_at DESC
    `).all();

    // Build CSV
    let csv = 'Timestamp,Team #,Team Name,Category,Question,Activity Type,Submitted Value\n';
    for (const r of rows) {
      csv += `"${r.created_at}","${r.team_id}","${esc(r.team_name || '')}","${r.category || ''}","${esc(r.question_title || '')}","${r.activity_type}","${esc(r.submitted_value || '')}"\n`;
    }

    const filename = 'activity_log.csv';
    await uploadOrUpdate(filename, csv, folderIds['Activity_Log'], 'text/csv');
    console.log(`  📁 Drive: Synced activity log (${rows.length} entries)`);
  } catch (err) {
    console.error('  ✗  Drive activity sync failed:', err.message);
  }
}

// ── Sync submissions log as CSV ─────────────────────────────────────────────
async function syncSubmissionsLog(db) {
  if (!initialized) return;
  try {
    const rows = db.prepare(`
      SELECT s.id, s.submitted_at, s.team_id, t.team_name, q.category, q.title AS question_title,
             s.submitted_value, GROUP_CONCAT(sf.filename, '; ') AS attached_files
      FROM submissions s
      LEFT JOIN teams t ON s.team_id = t.id
      LEFT JOIN questions q ON s.question_id = q.id
      LEFT JOIN submission_files sf ON sf.submission_id = s.id
      GROUP BY s.id
      ORDER BY s.submitted_at DESC
    `).all();

    let csv = 'Submission ID,Timestamp,Team #,Team Name,Category,Question,Answer Text,Attached Files\n';
    for (const r of rows) {
      csv += `"${r.id}","${r.submitted_at}","${r.team_id}","${esc(r.team_name || '')}","${r.category || ''}","${esc(r.question_title || '')}","${esc(r.submitted_value || '')}","${esc(r.attached_files || '')}"\n`;
    }

    await uploadOrUpdate('submissions_log.csv', csv, folderIds['Activity_Log'], 'text/csv');
    console.log(`  📁 Drive: Synced submissions log (${rows.length} entries)`);
  } catch (err) {
    console.error('  ✗  Drive submissions sync failed:', err.message);
  }
}

// ── Backup database ─────────────────────────────────────────────────────────
async function backupDatabase() {
  if (!initialized) return;
  try {
    const dbPath = path.join(__dirname, '..', 'doomsday.db');
    if (!fs.existsSync(dbPath)) return;

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const backupName = `doomsday_backup_${timestamp}.db`;

    // Also keep a "latest" copy
    await uploadOrUpdate('doomsday_latest.db', null, folderIds['Database_Backups'], 'application/octet-stream', dbPath);
    console.log(`  📁 Drive: Database backup synced`);
  } catch (err) {
    console.error('  ✗  Drive DB backup failed:', err.message);
  }
}

// ── Upload or update (by name) ──────────────────────────────────────────────
async function uploadOrUpdate(filename, content, folderId, mimeType, filePath) {
  // Check if file already exists in folder
  const query = `name='${filename}' and '${folderId}' in parents and trashed=false`;
  const existing = await drive.files.list({ q: query, fields: 'files(id)', spaces: 'drive' });

  const media = filePath
    ? { mimeType, body: fs.createReadStream(filePath) }
    : { mimeType, body: require('stream').Readable.from([content]) };

  if (existing.data.files.length > 0) {
    // Update existing file
    await drive.files.update({
      fileId: existing.data.files[0].id,
      media
    });
  } else {
    // Create new file
    await drive.files.create({
      requestBody: { name: filename, parents: [folderId] },
      media,
      fields: 'id'
    });
  }
}

// ── Full sync (call periodically) ──────────────────────────────────────────
async function fullSync(db) {
  if (!initialized) return;
  try {
    await syncActivityLog(db);
    await syncSubmissionsLog(db);
    await backupDatabase();
  } catch (err) {
    console.error('  ✗  Drive full sync failed:', err.message);
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────
function sanitize(str) {
  return (str || 'Unknown').replace(/[<>:"/\\|?*]/g, '_').substring(0, 100);
}

function esc(str) {
  return String(str).replace(/"/g, '""');
}

function isEnabled() {
  return initialized;
}

module.exports = {
  init,
  uploadSubmissionFile,
  syncActivityLog,
  syncSubmissionsLog,
  backupDatabase,
  fullSync,
  isEnabled
};
