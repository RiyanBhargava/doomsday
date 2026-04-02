import os
import io
import time
import json
import datetime
import typing
from flask import Blueprint, request, jsonify, Response, current_app
from database import query_db, insert_db, execute_db
from middleware.auth import require_admin
import services.gdrive as gdrive
from werkzeug.utils import secure_filename

admin_bp = Blueprint('admin', __name__)

@admin_bp.before_request
@require_admin
def before_request():
    pass

@admin_bp.route('/questions', methods=['GET'])
def get_questions():
    questions = query_db('SELECT * FROM questions ORDER BY category, sort_order ASC')
    return jsonify([dict(q) for q in questions])

@admin_bp.route('/question/<int:id>', methods=['GET'])
def get_question(id):
    q = query_db('SELECT * FROM questions WHERE id = ?', [id], one=True)
    if not q:
        return jsonify({'error': 'Not found'}), 404

    q_dict = dict(q)
    attachments = query_db('SELECT * FROM attachments WHERE question_id = ?', [id])
    links = query_db('SELECT * FROM reference_links WHERE question_id = ?', [id])

    q_dict['attachments'] = [dict(a) for a in attachments]
    q_dict['links'] = [dict(l) for l in links]

    return jsonify(q_dict)

@admin_bp.route('/question', methods=['POST'])
def create_question():
    data = request.get_json() or {}
    title = data.get('title')
    category = data.get('category')
    body_markdown = data.get('body_markdown')
    answer = data.get('answer', '')
    answer_mode = data.get('answer_mode', 'exact')
    sort_order = data.get('sort_order', 0)
    visible_from = data.get('visible_from')
    links = data.get('links', [])

    q_id = insert_db('''
        INSERT INTO questions (title, category, body_markdown, answer, answer_mode, sort_order, visible_from)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    ''', [title, category, body_markdown, answer, answer_mode, sort_order, visible_from])

    if links and isinstance(links, list):
        for l in links:
            insert_db('INSERT INTO reference_links (question_id, label, url) VALUES (?, ?, ?)',
                      [q_id, l.get('label'), l.get('url')])

    return jsonify({'id': q_id, 'success': True})

@admin_bp.route('/question/<int:id>', methods=['PUT'])
def update_question(id):
    data = request.get_json() or {}
    
    execute_db('''
        UPDATE questions SET title=?, category=?, body_markdown=?, answer=?, answer_mode=?, sort_order=?, visible_from=?, updated_at=CURRENT_TIMESTAMP
        WHERE id=?
    ''', [data.get('title'), data.get('category'), data.get('body_markdown'), data.get('answer'),
          data.get('answer_mode'), data.get('sort_order'), data.get('visible_from'), id])

    execute_db('DELETE FROM reference_links WHERE question_id = ?', [id])
    links = data.get('links', [])
    if links and isinstance(links, list):
        for l in links:
            insert_db('INSERT INTO reference_links (question_id, label, url) VALUES (?, ?, ?)',
                      [id, l.get('label'), l.get('url')])

    return jsonify({'success': True})

@admin_bp.route('/question/<int:id>', methods=['DELETE'])
def delete_question(id):
    attachments = query_db('SELECT filepath FROM attachments WHERE question_id = ?', [id])
    for a in attachments:
        try:
            os.remove(a['filepath'])
        except Exception:
            pass

    execute_db('DELETE FROM questions WHERE id = ?', [id])
    return jsonify({'success': True})

@admin_bp.route('/question/<int:id>/upload', methods=['POST'])
def upload_attachment(id):
    if 'file' not in request.files:
        return jsonify({'error': 'No file'}), 400

    file = request.files['file']
    if file.filename == '':
        return jsonify({'error': 'No file'}), 400

    upload_dir = os.path.join(os.path.dirname(__file__), '..', 'uploads')
    if not os.path.exists(upload_dir):
        os.makedirs(upload_dir, exist_ok=True)

    filename = str(int(time.time() * 1000)) + '-' + secure_filename(file.filename)
    filepath = 'uploads/' + filename
    
    # Save file to disk
    full_path = os.path.join(upload_dir, filename)
    file.save(full_path)

    insert_db('INSERT INTO attachments (question_id, filename, filepath) VALUES (?, ?, ?)',
              [id, file.filename, filepath])

    return jsonify({'success': True, 'filename': file.filename, 'filepath': filepath})

@admin_bp.route('/attachment/<int:id>', methods=['DELETE'])
def delete_attachment(id):
    att = query_db('SELECT * FROM attachments WHERE id = ?', [id], one=True)
    if att:
        full_path = os.path.join(os.path.dirname(__file__), '..', att['filepath'])
        try:
            os.remove(full_path)
        except Exception:
            pass
        execute_db('DELETE FROM attachments WHERE id = ?', [id])
    return jsonify({'success': True})

@admin_bp.route('/activity', methods=['GET'])
def get_activity():
    try:
        limit = int(request.args.get('limit', 200))
    except (ValueError, TypeError):
        limit = 200
        
    try:
        offset = int(request.args.get('offset', 0))
    except (ValueError, TypeError):
        offset = 0

    category = request.args.get('category')
    activity_type = request.args.get('type')
    team_filter = request.args.get('team')

    query = '''
        SELECT a.*, t.team_name, t.id as team_number, q.title as question_title, q.category as question_category
        FROM activity_log a
        JOIN teams t ON a.team_id = t.id
        LEFT JOIN questions q ON a.question_id = q.id
        WHERE 1=1
    '''
    params: list = []

    if category:
        query += ' AND a.category = ?'
        params.append(category)
    if activity_type:
        query += ' AND a.activity_type = ?'
        params.append(activity_type)
    if team_filter:
        query += ' AND t.team_name LIKE ?'
        params.append(f'%{team_filter}%')

    query += ' ORDER BY a.created_at DESC LIMIT ? OFFSET ?'
    params.extend([limit, offset])

    rows = query_db(query, params)
    
    result = []
    for row in rows:
        row_dict = dict(row)
        prev = query_db('SELECT created_at FROM activity_log WHERE team_id = ? AND id < ? ORDER BY id DESC LIMIT 1',
                        [row['team_id'], row['id']], one=True)
                        
        time_since_last = None
        if prev:
            try:
                curr_dt = datetime.datetime.fromisoformat(row['created_at'].replace('Z',''))
                prev_dt = datetime.datetime.fromisoformat(prev['created_at'].replace('Z',''))
                time_since_last = int((curr_dt - prev_dt).total_seconds())
            except Exception:
                pass
                
        time_taken = None
        if row_dict['activity_type'] == 'correct_submission' and row_dict.get('metadata'):
            try:
                meta = json.loads(row_dict['metadata'])
                time_taken = meta.get('time_taken')
            except Exception:
                pass

        row_dict['timeSinceLast'] = time_since_last
        row_dict['timeTaken'] = time_taken
        result.append(row_dict)

    from database import get_db
    cur = get_db().execute('SELECT COUNT(*) as count FROM activity_log')
    total = cur.fetchone()['count']
    cur.close()

    return jsonify({'rows': result, 'total': total})

@admin_bp.route('/stats', methods=['GET'])
def get_stats():
    total_teams = query_db('SELECT COUNT(*) as count FROM teams WHERE banned = 0', one=True)['count']
    total_submissions = query_db('SELECT COUNT(*) as count FROM submissions', one=True)['count']
    active_users = query_db("SELECT COUNT(DISTINCT team_id) as count FROM activity_log WHERE created_at > datetime('now', '-30 minutes')", one=True)['count']

    categories = ['AI', 'CP', 'HEX', 'DEV']
    per_category = {}
    for cat in categories:
        total_q = query_db('SELECT COUNT(*) as count FROM questions WHERE category = ?', [cat], one=True)['count']
        total_sub = query_db('SELECT COUNT(*) as count FROM submissions WHERE question_id IN (SELECT id FROM questions WHERE category = ?)', [cat], one=True)['count']
        per_category[cat] = {'questions': total_q, 'submissions': total_sub}

    return jsonify({
        'totalTeams': total_teams,
        'totalSubmissions': total_submissions,
        'activeUsers': active_users,
        'perCategory': per_category
    })

@admin_bp.route('/settings', methods=['GET'])
def get_settings():
    settings = query_db('SELECT * FROM settings')
    obj = {}
    for s in settings:
        obj[s['key']] = s['value']
    return jsonify(obj)

@admin_bp.route('/settings', methods=['PUT'])
def update_settings():
    allowed = ['competition_start', 'competition_end', 'maintenance_mode']
    data = request.get_json()
    if not isinstance(data, dict):
        data = {}
    
    for key, value in data.items():
        if key in allowed:
            execute_db('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [key, str(value)])
            
    return jsonify({'success': True})

@admin_bp.route('/announcement', methods=['POST'])
def create_announcement():
    data = request.get_json() or {}
    message = data.get('message')
    if not message:
        return jsonify({'error': 'Message required'}), 400

    insert_db('INSERT INTO announcements (message) VALUES (?)', [message])
    try:
        current_app.extensions['socketio'].emit('announcement', message)
    except Exception:
        pass

    return jsonify({'success': True, 'message': message})

@admin_bp.route('/teams', methods=['GET'])
def get_teams():
    teams = query_db('''
        SELECT t.*,
          (SELECT COUNT(*) FROM submissions WHERE team_id = t.id) as submission_count,
          (SELECT COUNT(*) FROM team_members WHERE team_id = t.id) as member_count
        FROM teams t
        ORDER BY t.id ASC
    ''')

    result = []
    for t in teams:
        t_dict = dict(t)
        members = query_db('SELECT u.email, u.name FROM team_members tm JOIN users u ON tm.user_id = u.id WHERE tm.team_id = ?', [t['id']])
        t_dict['members'] = [dict(m) for m in members]
        result.append(t_dict)
        
    return jsonify(result)

@admin_bp.route('/team/ban/<int:id>', methods=['POST'])
def ban_team(id):
    execute_db('UPDATE teams SET banned = 1 WHERE id = ?', [id])
    return jsonify({'success': True})

@admin_bp.route('/team/unban/<int:id>', methods=['POST'])
def unban_team(id):
    execute_db('UPDATE teams SET banned = 0 WHERE id = ?', [id])
    return jsonify({'success': True})

@admin_bp.route('/team/reset/<int:id>', methods=['POST'])
def reset_team(id):
    execute_db('DELETE FROM submissions WHERE team_id = ?', [id])
    execute_db('DELETE FROM question_views WHERE team_id = ?', [id])
    return jsonify({'success': True})

@admin_bp.route('/team/register', methods=['POST'])
def register_team():
    data = request.get_json() or {}
    team_name = data.get('teamName')
    team_code = data.get('teamCode')
    if not team_name or not team_code:
        return jsonify({'error': 'Team name and team code required'}), 400

    try:
        insert_db('INSERT INTO teams (team_name, team_code) VALUES (?, ?)', [team_name, team_code])
        return jsonify({'success': True})
    except Exception:
        return jsonify({'error': 'Team name already exists'}), 400


@admin_bp.route('/submissions', methods=['GET'])
def get_submissions():
    try: limit = int(request.args.get('limit', 50))
    except: limit = 50
    try: offset = int(request.args.get('offset', 0))
    except: offset = 0

    category = request.args.get('category')
    team_filter = request.args.get('team')

    query = '''
        SELECT s.*, t.team_name, t.id as team_number, q.title as question_title, q.category
        FROM submissions s
        JOIN teams t ON s.team_id = t.id
        JOIN questions q ON s.question_id = q.id
        WHERE 1=1
    '''
    params: list = []

    if category:
        query += ' AND q.category = ?'
        params.append(category)
    if team_filter:
        query += ' AND t.team_name LIKE ?'
        params.append(f'%{team_filter}%')

    query += ' ORDER BY s.submitted_at DESC LIMIT ? OFFSET ?'
    params.extend([limit, offset])

    rows = query_db(query, params)

    result = []
    for r in rows:
        r_dict = dict(r)
        r_dict['files'] = []
        result.append(r_dict)

    count_query = 'SELECT COUNT(*) as count FROM submissions s JOIN questions q ON s.question_id = q.id JOIN teams t ON s.team_id = t.id WHERE 1=1'
    count_params = []
    if category:
        count_query += ' AND q.category = ?'
        count_params.append(category)
    if team_filter:
        count_query += ' AND t.team_name LIKE ?'
        count_params.append(f'%{team_filter}%')

    total = query_db(count_query, count_params, one=True)['count']
    return jsonify({'rows': result, 'total': total})

@admin_bp.route('/export-submissions', methods=['GET'])
def export_submissions():
    rows = query_db('''
        SELECT s.submitted_at, t.id as team_number, t.team_name, q.category, q.title as question_title, s.submitted_value
        FROM submissions s
        JOIN teams t ON s.team_id = t.id
        JOIN questions q ON s.question_id = q.id
        ORDER BY s.submitted_at DESC
    ''')

    csv_data = 'Timestamp,Team #,Team Name,Category,Question,Submitted Value\n'
    for r in rows:
        val = r['submitted_value'] or ''
        val = val.replace('"', '""')
        csv_data += f'"{r["submitted_at"]}","{r["team_number"]}","{r["team_name"]}","{r["category"]}","{r["question_title"]}","{val}"\n'

    return Response(
        csv_data,
        mimetype="text/csv",
        headers={"Content-disposition": "attachment; filename=submissions.csv"}
    )

@admin_bp.route('/export-activity', methods=['GET'])
def export_activity():
    rows = query_db('''
        SELECT a.created_at, t.id as team_number, t.team_name, a.category, 
          q.title as question_title, a.activity_type, a.submitted_value
        FROM activity_log a
        JOIN teams t ON a.team_id = t.id
        LEFT JOIN questions q ON a.question_id = q.id
        ORDER BY a.created_at DESC
    ''')

    csv_data = 'Timestamp,Team #,Team Name,Category,Question,Activity Type,Submitted Value\n'
    for r in rows:
        val = r['submitted_value'] or ''
        val = val.replace('"', '""')
        cat = r['category'] or ''
        title = r['question_title'] or ''
        csv_data += f'"{r["created_at"]}","{r["team_number"]}","{r["team_name"]}","{cat}","{title}","{r["activity_type"]}","{val}"\n'

    return Response(
        csv_data,
        mimetype="text/csv",
        headers={"Content-disposition": "attachment; filename=activity_log.csv"}
    )
