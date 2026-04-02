import os
from functools import wraps
from flask import session, request, jsonify
from database import query_db, execute_db

ADMIN_EMAIL = os.getenv('ADMIN_EMAIL', 'acm@dubai.bits-pilani.ac.in')

def require_login(f):
    @wraps(f)
    def decorated_function(*args, **kwargs):
        if 'user' not in session:
            return jsonify({'error': 'Not authenticated'}), 401
        return f(*args, **kwargs)
    return decorated_function

def require_admin(f):
    @wraps(f)
    def decorated_function(*args, **kwargs):
        if 'user' not in session:
            return jsonify({'error': 'Not authenticated'}), 401
        if session['user'].get('role') != 'admin':
            return jsonify({'error': 'Access denied'}), 403
        return f(*args, **kwargs)
    return decorated_function

def require_team(f):
    @wraps(f)
    def decorated_function(*args, **kwargs):
        if 'user' not in session:
            return jsonify({'error': 'Not authenticated'}), 401
        
        user_id = session['user']['id']
        membership = query_db('SELECT team_id FROM team_members WHERE user_id = ?', [user_id], one=True)
        if not membership:
            return jsonify({'error': 'No team registered'}), 400
            
        team = query_db('SELECT * FROM teams WHERE id = ?', [membership['team_id']], one=True)
        if not team:
            return jsonify({'error': 'No team registered'}), 400
            
        if team['banned']:
            return jsonify({'error': 'banned'}), 403
            
        # Store team in request context equivalent by passing it, or attach it to flask 'g'
        from flask import g
        g.team = team
        return f(*args, **kwargs)
    return decorated_function

def check_maintenance(f):
    @wraps(f)
    def decorated_function(*args, **kwargs):
        setting = query_db("SELECT value FROM settings WHERE key = 'maintenance_mode'", one=True)
        if setting and setting['value'] == '1':
            if 'user' in session and session['user'].get('role') == 'admin':
                pass # Admins bypass maintenance
            else:
                return jsonify({'error': 'Maintenance mode active'}), 503
        return f(*args, **kwargs)
    return decorated_function

def process_google_login(profile):
    email = profile.get('email')
    name = profile.get('name')
    picture = profile.get('picture')
    role = 'admin' if email == ADMIN_EMAIL else 'participant'

    user = query_db('SELECT * FROM users WHERE email = ?', [email], one=True)
    if not user:
        from database import insert_db
        user_id = insert_db('INSERT INTO users (email, name, picture, role) VALUES (?, ?, ?, ?)', [email, name, picture, role])
        user = query_db('SELECT * FROM users WHERE id = ?', [user_id], one=True)
    else:
        execute_db('UPDATE users SET name = ?, picture = ?, role = ? WHERE email = ?', [name, picture, role, email])
        user = dict(user) # Copy row
        user['name'] = name
        user['picture'] = picture
        user['role'] = role

    return user
