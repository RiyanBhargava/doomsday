// gdrive-setup.js — One-time setup to get Google Drive refresh token
// Run: node gdrive-setup.js
// Then paste the refresh token into your .env file

require('dotenv').config();
const { google } = require('googleapis');
const http = require('http');
const url = require('url');

const CLIENT_ID = process.env.GDRIVE_CLIENT_ID;
const CLIENT_SECRET = process.env.GDRIVE_CLIENT_SECRET;
const REDIRECT_URI = 'http://localhost:4000/callback';

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.log('\n  ✗  Set GDRIVE_CLIENT_ID and GDRIVE_CLIENT_SECRET in .env first!\n');
  console.log('  Steps:');
  console.log('  1. Go to https://console.cloud.google.com/apis/credentials');
  console.log('  2. Create OAuth 2.0 Client ID (type: Web Application)');
  console.log('  3. Add redirect URI: http://localhost:4000/callback');
  console.log('  4. Copy Client ID and Client Secret into .env');
  console.log('  5. Run this script again\n');
  process.exit(1);
}

const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);

const authUrl = oauth2Client.generateAuthUrl({
  access_type: 'offline',
  prompt: 'consent',
  scope: ['https://www.googleapis.com/auth/drive']
});

// Start temp server to catch the callback
const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  if (parsed.pathname === '/callback' && parsed.query.code) {
    try {
      const { tokens } = await oauth2Client.getToken(parsed.query.code);
      
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`
        <html><body style="background:#0a0a0a;color:#00ff41;font-family:monospace;padding:40px;">
          <h2>✓ Google Drive Authorization Successful!</h2>
          <p>Add this to your <b>.env</b> file:</p>
          <pre style="background:#111;padding:20px;border:1px solid #333;word-break:break-all;">GDRIVE_REFRESH_TOKEN=${tokens.refresh_token}</pre>
          <p style="color:#666;">You can close this tab now.</p>
        </body></html>
      `);

      console.log('\n  ✓  Authorization successful!\n');
      console.log('  Add this to your .env file:\n');
      console.log(`  GDRIVE_REFRESH_TOKEN=${tokens.refresh_token}\n`);

      setTimeout(() => process.exit(0), 2000);
    } catch (err) {
      res.writeHead(500);
      res.end('Error: ' + err.message);
      console.error('Error getting tokens:', err.message);
    }
  }
});

server.listen(4000, () => {
  console.log('\n  ╔══════════════════════════════════════════════╗');
  console.log('  ║     Google Drive Authorization Setup          ║');
  console.log('  ╚══════════════════════════════════════════════╝\n');
  console.log('  Open this URL in your browser:\n');
  console.log(`  ${authUrl}\n`);
  console.log('  Waiting for authorization...\n');
});
