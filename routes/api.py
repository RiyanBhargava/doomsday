import threading
import datetime
import io
from flask import Blueprint, request, jsonify, g, current_app
from database import query_db, insert_db, execute_db, sqlite_dict_factory
from middleware.auth import require_login, require_team, check_maintenance
import services.gdrive as gdrive

api_bp = Blueprint('api', __name__)

def is_competition_active():
    start = query_db("SELECT value FROM settings WHERE key = 'competition_start'", one=True)
    end = query_db("SELECT value FROM settings WHERE key = 'competition_end'", one=True)
    now = datetime.datetime.now()

    def parse_dt(dt_str):
        if not dt_str: return None
        # attempt to parse ISO or similar. Just simplistic comparison since JS uses new Date(string)
        # Assuming frontend sends standard format YYYY-MM-DDTHH:MM
        try:
            return datetime.datetime.fromisoformat(dt_str.replace('Z', '+00:00'))
        except:
            return None

    # Actually, string comparison format may work if it's strictly ISO yyyy-mm-dd
    # so JS can compare. Just send back strings
    start_val = start['value'] if start else None
    end_val = end['value'] if end else None

    # For safety in python date comparisons, we just return the values to frontend
    # and do a rough check. The true check was in JS with new Date().
    
    start_dt = parse_dt(start_val)
    end_dt = parse_dt(end_val)

    # Convert now to UTC timezone-aware if start_dt is timezone-aware
    if start_dt and start_dt.tzinfo:
        now = datetime.datetime.now(datetime.timezone.utc)

    if start_val and start_dt and start_dt > now:
        return {'active': False, 'reason': 'not_started', 'start': start_val, 'end': end_val}
    if end_val and end_dt and end_dt < now:
        return {'active': False, 'reason': 'ended', 'start': start_val, 'end': end_val}
        
    return {'active': True, 'start': start_val, 'end': end_val}

@api_bp.route('/competition-info', methods=['GET'])
def competition_info():
    status: dict = dict(is_competition_active())
    maintenance = query_db("SELECT value FROM settings WHERE key = 'maintenance_mode'", one=True)
    status['maintenance'] = (maintenance['value'] == '1') if maintenance else False
    return jsonify(status)

@api_bp.route('/questions/<category>', methods=['GET'])
@require_login
@require_team
@check_maintenance
def get_questions(category):
    category = category.upper()
    if category not in ['AI', 'CP', 'HEX', 'DEV']:
        return jsonify({'error': 'Invalid category'}), 400

    questions = query_db('''
        SELECT id, title, category, sort_order, visible_from
        FROM questions WHERE category = ? ORDER BY sort_order ASC
    ''', [category])

    team_id = g.team['id']
    submitted_rows = query_db('SELECT DISTINCT question_id FROM submissions WHERE team_id = ?', [team_id])
    submitted_ids = [r['question_id'] for r in submitted_rows]

    now = datetime.datetime.now()

    result = []
    for q in questions:
        has_submitted = q['id'] in submitted_ids
        
        is_visible = True
        if q['visible_from']:
            try:
                vis_dt = datetime.datetime.fromisoformat(q['visible_from'].replace('Z', '+00:00'))
                # Handle tz issue
                cmp_now = datetime.datetime.now(datetime.timezone.utc) if vis_dt.tzinfo else now
                if vis_dt > cmp_now:
                    is_visible = False
            except:
                pass

        result.append({
            'id': q['id'],
            'title': q['title'],
            'category': q['category'],
            'submitted': has_submitted,
            'unlocked': is_visible,
            'sort_order': q['sort_order']
        })

    return jsonify(result)

@api_bp.route('/question/<int:id>', methods=['GET'])
@require_login
@require_team
@check_maintenance
def get_question(id):
    question = query_db('SELECT id, title, category, body_markdown, sort_order, visible_from FROM questions WHERE id = ?', [id], one=True)
    if not question:
        return jsonify({'error': 'Question not found'}), 404
        
    question_dict: dict = dict(question)

    team_id = g.team['id']
    insert_db('INSERT INTO question_views (team_id, question_id) VALUES (?, ?)', [team_id, id])
    insert_db("INSERT INTO activity_log (team_id, question_id, activity_type, category) VALUES (?, ?, 'question_viewed', ?)",
              [team_id, id, question_dict['category']])

    attachments = query_db('SELECT id, filename, filepath FROM attachments WHERE question_id = ?', [id])
    links = query_db('SELECT id, label, url FROM reference_links WHERE question_id = ?', [id])
    
    submissions = query_db('SELECT id, submitted_value, submitted_at FROM submissions WHERE team_id = ? AND question_id = ? ORDER BY submitted_at DESC', [team_id, id])
    
    prev_subs = []
    for s in submissions:
        s_dict = dict(s)
        s_dict['files'] = []
        prev_subs.append(s_dict)

    question_dict['attachments'] = [dict(a) for a in attachments]
    question_dict['links'] = [dict(l) for l in links]
    question_dict['submissions_count'] = len(submissions)
    question_dict['previous_submissions'] = prev_subs

    return jsonify(question_dict)

def trigger_drive_sync(app):
    with app.app_context():
        import database
        # just call gdrive directly, it will use its own db conn if needed, but we wrote it to not need db object for upload
        # Wait, sync_activity_log uses query_db
        gdrive.sync_activity_log()
        gdrive.sync_submissions_log()

@api_bp.route('/submit/<int:question_id>', methods=['POST'])
@require_login
@require_team
@check_maintenance
def submit_answer(question_id):
    question = query_db('SELECT * FROM questions WHERE id = ?', [question_id], one=True)
    if not question:
        return jsonify({'error': 'Question not found'}), 404

    data = request.get_json()
    if not data or not data.get('answer'):
        return jsonify({'error': 'Provide a submission link'}), 400
        
    answer = data.get('answer', '').strip()

    team_id = g.team['id']
    team_name = g.team['team_name']

    submission_id = insert_db('INSERT INTO submissions (team_id, question_id, submitted_value, is_correct, time_taken) VALUES (?, ?, ?, 0, 0)', 
                              [team_id, question_id, answer])

    app = current_app._get_current_object()

    activity_val = answer[:200]
    insert_db("INSERT INTO activity_log (team_id, question_id, activity_type, category, submitted_value) VALUES (?, ?, 'submission', ?, ?)",
              [team_id, question_id, question['category'], activity_val])

    return jsonify({'success': True, 'submissionId': submission_id})

@api_bp.route('/progress', methods=['GET'])
@require_login
@require_team
def get_progress():
    categories = ['AI', 'CP', 'HEX', 'DEV']
    progress = {}
    team_id = g.team['id']

    for cat in categories:
        total = query_db('SELECT COUNT(*) as count FROM questions WHERE category = ?', [cat], one=True)['count']
        sub = query_db('SELECT COUNT(DISTINCT question_id) as count FROM submissions WHERE team_id = ? AND question_id IN (SELECT id FROM questions WHERE category = ?)', 
                       [team_id, cat], one=True)['count']
        progress[cat] = {'total': total, 'submitted': sub}

    return jsonify({
        'team': {'name': g.team['team_name'], 'id': team_id},
        'progress': progress
    })

@api_bp.route('/dashboard', methods=['GET'])
@require_login
@require_team
def get_dashboard():
    categories = ['AI', 'CP', 'HEX', 'DEV']
    cat_progress = {}
    team_id = g.team['id']

    for cat in categories:
        questions = query_db('SELECT id, title FROM questions WHERE category = ? ORDER BY sort_order ASC', [cat])
        
        q_list = []
        for q in questions:
            sub = query_db('SELECT COUNT(*) as count FROM submissions WHERE team_id = ? AND question_id = ?', [team_id, q['id']], one=True)
            last = query_db('SELECT submitted_at FROM submissions WHERE team_id = ? AND question_id = ? ORDER BY submitted_at DESC LIMIT 1', [team_id, q['id']], one=True)
            
            q_list.append({
                'id': q['id'],
                'title': q['title'],
                'submitted': sub['count'] > 0,
                'submissionCount': sub['count'],
                'lastSubmittedAt': last['submitted_at'] if last else None
            })
        cat_progress[cat] = q_list

    return jsonify({
        'team': {'name': g.team['team_name'], 'id': team_id},
        'categoryProgress': cat_progress
    })

@api_bp.route('/announcements', methods=['GET'])
@require_login
def get_announcements():
    anns = query_db('SELECT * FROM announcements ORDER BY created_at DESC LIMIT 50')
    return jsonify([dict(a) for a in anns])
