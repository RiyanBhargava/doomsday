
    let editingQuestionId = null;
    let activityOffset = 0;
    let subOffset = 0;
    const PAGE_LIMIT = 50;
    let debounceTimer = null;
    let debounceTimerSub = null;

    // Init
    async function init() {
      const res = await fetch('/auth/me');
      const data = await res.json();
      if (!data.loggedIn || data.user.role !== 'admin') {
        window.location.href = '/';
        return;
      }
      document.getElementById('admin-email').textContent = data.user.email;
      loadStats();
      loadQuestions();
      loadActivity();
      loadTeams();
      loadSettings();
    }

    // Section Nav
    function showSection(sectionId, link) {
      document.querySelectorAll('.admin-section').forEach(s => s.classList.remove('active'));
      document.getElementById(sectionId).classList.add('active');
      document.querySelectorAll('.admin-sidebar a').forEach(a => a.classList.remove('active'));
      link.classList.add('active');

      if (sectionId === 'dashboard-section') loadStats();
      if (sectionId === 'activity-section') loadActivity();
      if (sectionId === 'teams-section') loadTeams();
      if (sectionId === 'submissions-section') loadSubmissions();
    }

    // ── DASHBOARD ─────────────────────────────────────────────────────────────
    async function loadStats() {
      try {
        const res = await fetch('/admin/stats');
        const data = await res.json();

        document.getElementById('stat-teams').textContent = data.totalTeams;
        document.getElementById('stat-submissions').textContent = data.totalSubmissions;
        document.getElementById('stat-active').textContent = data.activeUsers;

        const catContainer = document.getElementById('category-stats');
        catContainer.innerHTML = '';
        for (const [cat, info] of Object.entries(data.perCategory)) {
          catContainer.innerHTML += `
            <div class="stat-card">
              <div class="stat-value" style="font-size:16px;">${cat}</div>
              <div style="font-size:12px;color:#666;margin-top:6px;">
                ${info.questions} Q &middot; ${info.submissions} submissions
              </div>
            </div>
          `;
        }
      } catch (e) { console.error('Stats error:', e); }
    }

    async function broadcastAnnouncement() {
      const msg = document.getElementById('broadcast-msg').value.trim();
      if (!msg) return;
      try {
        await fetch('/admin/announcement', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: msg })
        });

        document.getElementById('broadcast-msg').value = '';
        showToast('Announcement sent');
      } catch (e) { showToast('Failed', 'error'); }
    }

    // ── QUESTIONS ─────────────────────────────────────────────────────────────
    async function loadQuestions() {
      try {
        const res = await fetch('/admin/questions');
        const questions = await res.json();
        const container = document.getElementById('questions-list');

        const categories = { AI: [], CP: [], HEX: [], DEV: [] };
        questions.forEach(q => {
          if (categories[q.category]) categories[q.category].push(q);
        });

        container.innerHTML = '';
        for (const [cat, qs] of Object.entries(categories)) {
          if (qs.length === 0) continue;
          container.innerHTML += `<h3 style="font-size:13px;margin:16px 0 8px;">${cat} (${qs.length})</h3>`;
          qs.forEach(q => {
            container.innerHTML += `
              <div class="question-card">
                <span class="question-card-cat">${q.category}</span>
                <span class="question-card-title">${escapeHtml(q.title)}</span>
                <span style="color:#666;font-size:11px;">#${q.sort_order}</span>
                <div class="question-card-actions">
                  <button class="btn btn-small" onclick="editQuestion(${q.id})">Edit</button>
                  <button class="btn btn-small btn-danger" onclick="deleteQuestion(${q.id})">Del</button>
                </div>
              </div>
            `;
          });
        }

        if (questions.length === 0) {
          container.innerHTML = '<p style="color:#444;text-align:center;">No questions yet. Click "+ Add Question" to create one.</p>';
        }
      } catch (e) { console.error('Questions error:', e); }
    }

    function openQuestionEditor(question) {
      editingQuestionId = question ? question.id : null;
      document.getElementById('editor-title').textContent = question ? 'Edit Question' : 'Add Question';

      document.getElementById('q-title').value = question ? question.title : '';
      document.getElementById('q-category').value = question ? question.category : 'AI';
      document.getElementById('q-answer').value = question ? (question.answer || '') : '';
      document.getElementById('q-sort-order').value = question ? question.sort_order : 0;
      document.getElementById('q-visible-from').value = question && question.visible_from ? question.visible_from.slice(0, 16) : '';
      document.getElementById('q-body').value = question ? question.body_markdown : '';
      updatePreview();

      const linksContainer = document.getElementById('links-editor');
      linksContainer.innerHTML = '';
      if (question && question.links) {
        question.links.forEach(l => addLinkRow(l.label, l.url));
      }

      const uploadSection = document.getElementById('upload-section');
      uploadSection.style.display = question ? 'block' : 'none';
      if (question && question.attachments) {
        renderAttachments(question.attachments);
      }

      document.getElementById('question-editor-modal').classList.add('active');
    }

    function closeQuestionEditor() {
      document.getElementById('question-editor-modal').classList.remove('active');
      editingQuestionId = null;
    }

    async function editQuestion(id) {
      try {
        const res = await fetch(`/admin/question/${id}`);
        const q = await res.json();
        openQuestionEditor(q);
      } catch (e) { showToast('Failed to load question', 'error'); }
    }

    async function deleteQuestion(id) {
      if (!confirm('Delete this question permanently?')) return;
      try {
        await fetch(`/admin/question/${id}`, { method: 'DELETE' });
        showToast('Question deleted');
        loadQuestions();
      } catch (e) { showToast('Failed', 'error'); }
    }

    async function saveQuestion() {
      const data = {
        title: document.getElementById('q-title').value,
        category: document.getElementById('q-category').value,
        body_markdown: document.getElementById('q-body').value,
        answer: document.getElementById('q-answer').value || '',
        answer_mode: 'exact',
        sort_order: parseInt(document.getElementById('q-sort-order').value) || 0,
        visible_from: document.getElementById('q-visible-from').value || null,
        links: getLinks()
      };

      if (!data.title || !data.body_markdown) {
        showToast('Title and body are required', 'error');
        return;
      }

      try {
        const url = editingQuestionId ? `/admin/question/${editingQuestionId}` : '/admin/question';
        const method = editingQuestionId ? 'PUT' : 'POST';

        const res = await fetch(url, {
          method,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data)
        });
        const result = await res.json();

        if (result.success || result.id) {
          showToast(editingQuestionId ? 'Question updated' : 'Question created');
          if (!editingQuestionId && result.id) {
            editingQuestionId = result.id;
            document.getElementById('upload-section').style.display = 'block';
          }
          loadQuestions();
          if (editingQuestionId) {
            editQuestion(editingQuestionId);
          } else {
            closeQuestionEditor();
          }
        }
      } catch (e) { showToast('Save failed', 'error'); }
    }

    function updatePreview() {
      const md = document.getElementById('q-body').value;
      document.getElementById('q-preview').innerHTML = renderMarkdown(md);
      document.querySelectorAll('#q-preview pre code').forEach(block => hljs.highlightElement(block));
    }

    function renderMarkdown(md) {
      if (!md) return '';
      let text = md;
      text = text.replace(/\$\$([\s\S]+?)\$\$/g, (_, math) => {
        try { return '<div>' + katex.renderToString(math, { displayMode: true }) + '</div>'; }
        catch (e) { return '$$' + math + '$$'; }
      });
      text = text.replace(/\$([^\$\n]+?)\$/g, (_, math) => {
        try { return katex.renderToString(math, { displayMode: false }); }
        catch (e) { return '$' + math + '$'; }
      });
      return marked.parse(text);
    }

    // Links
    function addLinkRow(label = '', url = '') {
      const container = document.getElementById('links-editor');
      const row = document.createElement('div');
      row.className = 'link-editor-row';
      row.innerHTML = `
        <input type="text" class="input-field link-label-input" placeholder="Label" value="${escapeAttr(label)}">
        <input type="url" class="input-field link-url-input" placeholder="https://..." value="${escapeAttr(url)}">
        <button class="btn btn-small btn-danger" onclick="this.parentElement.remove()" style="padding:4px 8px;">&times;</button>
      `;
      container.appendChild(row);
    }

    function getLinks() {
      const rows = document.querySelectorAll('#links-editor .link-editor-row');
      return Array.from(rows).map(row => ({
        label: row.querySelector('.link-label-input').value,
        url: row.querySelector('.link-url-input').value
      })).filter(l => l.label.trim() && l.url.trim());
    }

    // Attachments
    function renderAttachments(attachments) {
      const container = document.getElementById('existing-attachments');
      container.innerHTML = attachments.map(a =>
        `<div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;">
          <span style="color:#666;font-size:12px;">&#128206; ${escapeHtml(a.filename)}</span>
          <button class="btn btn-small btn-danger" onclick="deleteAttachment(${a.id})" style="padding:2px 6px;font-size:8px;">&times;</button>
        </div>`
      ).join('');
    }

    async function uploadFile() {
      if (!editingQuestionId) { showToast('Save the question first', 'warning'); return; }
      const fileInput = document.getElementById('file-upload');
      if (!fileInput.files[0]) return;

      const formData = new FormData();
      formData.append('file', fileInput.files[0]);

      try {
        const res = await fetch(`/admin/question/${editingQuestionId}/upload`, {
          method: 'POST',
          body: formData
        });
        const data = await res.json();
        if (data.success) {
          showToast('File uploaded');
          editQuestion(editingQuestionId);
        }
      } catch (e) { showToast('Upload failed', 'error'); }
    }

    async function deleteAttachment(id) {
      try {
        await fetch(`/admin/attachment/${id}`, { method: 'DELETE' });
        showToast('Attachment removed');
        editQuestion(editingQuestionId);
      } catch (e) { showToast('Failed', 'error'); }
    }

    // ── SUBMISSIONS ───────────────────────────────────────────────────────────
    async function loadSubmissions() {
      try {
        const category = document.getElementById('sub-filter-category').value;
        const team = document.getElementById('sub-filter-team').value;

        const params = new URLSearchParams({ limit: PAGE_LIMIT, offset: subOffset });
        if (category) params.set('category', category);
        if (team) params.set('team', team);

        const res = await fetch(`/admin/submissions?${params}`);
        const data = await res.json();

        const container = document.getElementById('submissions-list');
        if (data.rows.length === 0) {
          container.innerHTML = '<p style="color:#333;text-align:center;">No submissions yet.</p>';
        } else {
          container.innerHTML = data.rows.map(s => {
            const time = new Date(s.submitted_at).toLocaleString();
            return `
              <div class="sub-card">
                <div class="sub-card-header">
                  <div>
                    <span class="sub-team">${escapeHtml(s.team_name)}</span>
                    <span style="color:#333;margin:0 6px;">|</span>
                    <span class="sub-question">${escapeHtml(s.question_title)} (${s.category})</span>
                  </div>
                  <span class="sub-time">${time}</span>
                </div>
                ${s.submitted_value ? `<div class="sub-value">${escapeHtml(s.submitted_value)}</div>` : ''}
                ${s.files && s.files.length > 0 ? `<div class="sub-files" style="margin-top:6px;">${s.files.map(f => `<a href="${f.filepath.startsWith('http') ? f.filepath : '/' + f.filepath}" target="_blank">&#128206; ${escapeHtml(f.filename)}</a>`).join('')}</div>` : ''}
              </div>
            `;
          }).join('');
        }

        const page = Math.floor(subOffset / PAGE_LIMIT) + 1;
        const totalPages = Math.ceil(data.total / PAGE_LIMIT) || 1;
        document.getElementById('sub-page-info').textContent = `Page ${page} of ${totalPages}`;
        document.getElementById('sub-prev').disabled = subOffset === 0;
        document.getElementById('sub-next').disabled = subOffset + PAGE_LIMIT >= data.total;
      } catch (e) { console.error('Submissions error:', e); }
    }

    function subPage(dir) {
      subOffset = Math.max(0, subOffset + dir * PAGE_LIMIT);
      loadSubmissions();
    }

    function debounceLoadSubmissions() {
      clearTimeout(debounceTimerSub);
      debounceTimerSub = setTimeout(() => { subOffset = 0; loadSubmissions(); }, 300);
    }

    // ── ACTIVITY LOG ──────────────────────────────────────────────────────────
    async function loadActivity() {
      try {
        const category = document.getElementById('activity-filter-category').value;
        const type = document.getElementById('activity-filter-type').value;
        const team = document.getElementById('activity-filter-team').value;

        const params = new URLSearchParams({ limit: PAGE_LIMIT, offset: activityOffset });
        if (category) params.set('category', category);
        if (type) params.set('type', type);
        if (team) params.set('team', team);

        const res = await fetch(`/admin/activity?${params}`);
        const data = await res.json();

        const tbody = document.getElementById('activity-body');
        if (data.rows.length === 0) {
          tbody.innerHTML = '<tr><td colspan="8" style="color:#333;text-align:center;">No activity yet</td></tr>';
        } else {
          tbody.innerHTML = data.rows.map(row => {
            const typeLabel = row.activity_type.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
            const time = new Date(row.created_at).toLocaleString();
            const sinceLast = row.timeSinceLast !== null ? formatDuration(row.timeSinceLast) : '—';
            const value = row.submitted_value || '';

            return `
              <tr class="activity-row">
                <td style="font-size:11px;color:#666;white-space:nowrap;">${time}</td>
                <td>${escapeHtml(row.team_code || '')}</td>
                <td>${escapeHtml(row.team_name)}</td>
                <td>${row.question_category || ''}</td>
                <td style="font-size:11px;">${escapeHtml(row.question_title || '')}</td>
                <td><span class="activity-type-${row.activity_type}" style="font-size:11px;font-weight:bold;">${typeLabel}</span></td>
                <td><span class="blurred-value" onclick="this.classList.toggle('revealed')">${escapeHtml(value)}</span></td>
                <td style="color:#666;font-size:11px;">${sinceLast}</td>
              </tr>
            `;
          }).join('');
        }

        const page = Math.floor(activityOffset / PAGE_LIMIT) + 1;
        const totalPages = Math.ceil(data.total / PAGE_LIMIT) || 1;
        document.getElementById('activity-page-info').textContent = `Page ${page} of ${totalPages}`;
        document.getElementById('activity-prev').disabled = activityOffset === 0;
        document.getElementById('activity-next').disabled = activityOffset + PAGE_LIMIT >= data.total;
      } catch (e) { console.error('Activity error:', e); }
    }

    function activityPage(dir) {
      activityOffset = Math.max(0, activityOffset + dir * PAGE_LIMIT);
      loadActivity();
    }

    function debounceLoadActivity() {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => { activityOffset = 0; loadActivity(); }, 300);
    }

    function formatDuration(seconds) {
      if (seconds < 60) return seconds + 's';
      if (seconds < 3600) return Math.floor(seconds / 60) + 'm ' + (seconds % 60) + 's';
      return Math.floor(seconds / 3600) + 'h ' + Math.floor((seconds % 3600) / 60) + 'm';
    }

    // ── TEAMS ─────────────────────────────────────────────────────────────────
    async function loadTeams() {
      try {
        const res = await fetch('/admin/teams');
        const teams = await res.json();
        const tbody = document.getElementById('teams-body');

        tbody.innerHTML = teams.map(t => {
          const membersList = (t.members || []).map(m => escapeHtml(m.email)).join('<br>');
          return `
          <tr class="team-row">
            <td style="font-family:Orbitron;font-size:11px;color:#00ff41;">${t.id}</td>
            <td style="font-family:Orbitron;font-size:11px;">${escapeHtml(t.team_name)}</td>
            <td style="color:#666;font-size:11px;">${membersList || '<span style="color:#333">No members</span>'} <span style="color:#444;font-size:9px;">(${t.member_count}/4)</span></td>
            <td style="color:#00ff41;font-family:Orbitron;">${t.submission_count}</td>
            <td>${t.banned ? '<span class="badge badge-red">Banned</span>' : '<span class="badge badge-green">Active</span>'}</td>
            <td>
              <div style="display:flex;gap:4px;flex-wrap:wrap;">
                ${t.banned
                  ? `<button class="btn btn-small" onclick="unbanTeam(${t.id})" style="padding:3px 8px;font-size:8px;">Unban</button>`
                  : `<button class="btn btn-small btn-danger" onclick="banTeam(${t.id})" style="padding:3px 8px;font-size:8px;">Ban</button>`
                }
                <button class="btn btn-small" onclick="resetTeam(${t.id})" style="padding:3px 8px;font-size:8px;">Reset</button>
              </div>
            </td>
          </tr>
        `}).join('');

        if (teams.length === 0) {
          tbody.innerHTML = '<tr><td colspan="7" style="color:#333;text-align:center;">No teams registered</td></tr>';
        }
      } catch (e) { console.error('Teams error:', e); }
    }

    async function banTeam(id) {
      if (!confirm('Ban this team?')) return;
      await fetch(`/admin/team/ban/${id}`, { method: 'POST' });
      showToast('Team banned');
      loadTeams();
    }

    async function unbanTeam(id) {
      await fetch(`/admin/team/unban/${id}`, { method: 'POST' });
      showToast('Team unbanned');
      loadTeams();
    }

    async function resetTeam(id) {
      if (!confirm('Reset all progress for this team? This cannot be undone.')) return;
      await fetch(`/admin/team/reset/${id}`, { method: 'POST' });
      showToast('Team progress reset');
      loadTeams();
    }

    function openRegisterTeamModal() {
      document.getElementById('register-team-modal').classList.add('active');
    }

    async function registerTeamManual() {
      const teamName = document.getElementById('reg-team-name').value.trim();
      const teamCode = document.getElementById('reg-team-code').value.trim();
      const errEl = document.getElementById('reg-error');

      if (!teamName || !teamCode) {
        errEl.textContent = 'All fields required';
        errEl.style.display = 'block';
        return;
      }

      try {
        const res = await fetch('/admin/team/register', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ teamName, teamCode })
        });
        const data = await res.json();
        if (data.error) {
          errEl.textContent = data.error;
          errEl.style.display = 'block';
          return;
        }
        showToast('Team registered');
        closeModal('register-team-modal');
        loadTeams();
      } catch (e) {
        errEl.textContent = 'Failed';
        errEl.style.display = 'block';
      }
    }

    // ── SETTINGS ──────────────────────────────────────────────────────────────
    async function loadSettings() {
      try {
        const res = await fetch('/admin/settings');
        const settings = await res.json();

        document.getElementById('setting-start').value = settings.competition_start ? settings.competition_start.slice(0, 16) : '';
        document.getElementById('setting-end').value = settings.competition_end ? settings.competition_end.slice(0, 16) : '';

        const mm = document.getElementById('toggle-maintenance');
        if (settings.maintenance_mode === '1') mm.classList.add('on'); else mm.classList.remove('on');
      } catch (e) { console.error('Settings error:', e); }
    }

    function toggleSetting(el, key) {
      el.classList.toggle('on');
      const value = el.classList.contains('on') ? '1' : '0';
      fetch('/admin/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [key]: value })
      });
    }

      async function saveSettings() {
      const data = {
        competition_start: document.getElementById('setting-start').value || '',
        competition_end: document.getElementById('setting-end').value || ''
      };

      try {
        await fetch('/admin/settings', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data)
        });
        showToast('Settings saved');
      } catch (e) { showToast('Failed', 'error'); }
    }

    // ── Utilities ─────────────────────────────────────────────────────────────
    function closeModal(id) {
      document.getElementById(id).classList.remove('active');
    }

    function escapeHtml(str) {
      if (!str) return '';
      const div = document.createElement('div');
      div.textContent = str;
      return div.innerHTML;
    }

    function escapeAttr(str) {
      return (str || '').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    async function logout() {
      await fetch('/auth/logout', { method: 'POST' });
      window.location.href = '/';
    }

    function showToast(msg, type = 'info') {
      const container = document.getElementById('toast-container');
      const toast = document.createElement('div');
      toast.className = 'toast' + (type === 'error' ? ' toast-error' : type === 'warning' ? ' toast-warning' : '');
      toast.textContent = msg;
      container.appendChild(toast);
      setTimeout(() => toast.remove(), 4000);
    }

    // Periodic polling for Admin Dashboard Activity / Submissions
    setInterval(() => {
      if (document.getElementById('activity-section').classList.contains('active')) loadActivity();
      if (document.getElementById('submissions-section').classList.contains('active')) loadSubmissions();
      if (document.getElementById('dashboard-section').classList.contains('active')) loadStats();
    }, 15000);

    init();
  