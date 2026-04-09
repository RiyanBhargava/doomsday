import os
import json
import base64
from flask import Blueprint, request, jsonify, session
from database import query_db, insert_db
from middleware.auth import process_google_login

auth_bp = Blueprint('auth', __name__)

def get_user_team(user_id):
    membership = query_db('SELECT team_id FROM team_members WHERE user_id = ?', [user_id], one=True)
    if not membership:
        return None
    return query_db('SELECT * FROM teams WHERE id = ?', [membership['team_id']], one=True)

@auth_bp.route('/google', methods=['POST'])
def google_login():
    data = request.get_json() or {}
    credential = data.get('credential')
    if not credential:
        return jsonify({'error': 'No credential provided'}), 400

    try:
        parts = credential.split('.')
        # Pad base64url if needed
        payload_b64 = parts[1]
        padding = 4 - (len(payload_b64) % 4)
        if padding != 4:
            payload_b64 += '=' * padding
            
        payload_json = base64.urlsafe_b64decode(payload_b64).decode('utf-8')
        payload = json.loads(payload_json)

        email = payload.get('email')
        name = payload.get('name')
        picture = payload.get('picture')
        hd = payload.get('hd')

        allowed_domain = os.getenv('ALLOWED_DOMAIN', 'dubai.bits-pilani.ac.in')
        if hd != allowed_domain:
            return jsonify({'error': f'Only @{allowed_domain} accounts are allowed'}), 403

        user = process_google_login({'email': email, 'name': name, 'picture': picture})
        team = get_user_team(user['id'])

        session['user'] = {
            'id': user['id'],
            'email': user['email'],
            'name': user['name'],
            'picture': user['picture'],
            'role': user['role']
        }

        return jsonify({
            'user': session['user'],
            'hasTeam': bool(team),
            'team': {'id': team['id'], 'team_name': team['team_name']} if team else None,
            'banned': bool(team.get('banned')) if team else False
        })
    except Exception as err:
        print('Google auth error:', err)
        return jsonify({'error': 'Authentication failed'}), 500


@auth_bp.route('/create-team', methods=['POST'])
def create_team():
    if 'user' not in session:
        return jsonify({'error': 'Not authenticated'}), 401

    data = request.get_json() or {}
    team_name = data.get('teamName')
    team_code = data.get('teamCode')
    
    if not team_name or not team_code:
        return jsonify({'error': 'Team name and team code are required'}), 400
        
    team_name_str = str(team_name)
    team_code_str = str(team_code)
        
    if len(team_name_str) > 50:
        return jsonify({'error': 'Team name too long (max 50 chars)'}), 400
    if len(team_code_str) < 4:
        return jsonify({'error': 'Team code must be at least 4 characters'}), 400

    existing = query_db('SELECT id FROM team_members WHERE user_id = ?', [session['user']['id']], one=True)
    if existing:
        return jsonify({'error': 'You are already in a team'}), 400

    dup_name = query_db('SELECT id FROM teams WHERE team_name = ?', [team_name], one=True)
    if dup_name:
        return jsonify({'error': 'Team name already taken'}), 400

    try:
        team_id = insert_db('INSERT INTO teams (team_name, team_code) VALUES (?, ?)', [team_name, team_code])
        insert_db('INSERT INTO team_members (team_id, user_id) VALUES (?, ?)', [team_id, session['user']['id']])

        team = query_db('SELECT * FROM teams WHERE id = ?', [team_id], one=True)
        return jsonify({
            'success': True,
            'team': {'id': team['id'], 'team_name': team['team_name']}
        })
    except Exception as err:
        print('Team creation error:', err)
        return jsonify({'error': 'Failed to create team'}), 500


@auth_bp.route('/join-team', methods=['POST'])
def join_team():
    if 'user' not in session:
        return jsonify({'error': 'Not authenticated'}), 401

    data = request.get_json() or {}
    team_name = data.get('teamName')
    team_code = data.get('teamCode')
    
    if not team_name or not team_code:
        return jsonify({'error': 'Team name and team code are required'}), 400

    existing = query_db('SELECT id FROM team_members WHERE user_id = ?', [session['user']['id']], one=True)
    if existing:
        return jsonify({'error': 'You are already in a team'}), 400

    team = query_db('SELECT * FROM teams WHERE team_name = ?', [team_name], one=True)
    if not team:
        return jsonify({'error': 'Team not found'}), 404

    if team['team_code'] != team_code:
        return jsonify({'error': 'Incorrect team code'}), 403

    member_count = query_db('SELECT COUNT(*) as count FROM team_members WHERE team_id = ?', [team['id']], one=True)['count']
    if member_count >= 4:
        return jsonify({'error': 'Team is full (max 4 members)'}), 400

    if team['banned']:
        return jsonify({'error': 'This team has been banned'}), 403

    try:
        insert_db('INSERT INTO team_members (team_id, user_id) VALUES (?, ?)', [team['id'], session['user']['id']])
        return jsonify({
            'success': True,
            'team': {'id': team['id'], 'team_name': team['team_name']}
        })
    except Exception as err:
        print('Team join error:', err)
        return jsonify({'error': 'Failed to join team'}), 500


@auth_bp.route('/me', methods=['GET'])
def auth_me():
    if 'user' not in session:
        return jsonify({'loggedIn': False})
    
    # Verify user still exists in DB in case of database reset
    db_user = query_db('SELECT id FROM users WHERE id = ?', [session['user']['id']], one=True)
    if not db_user:
        session.clear()
        return jsonify({'loggedIn': False})
        
    team = get_user_team(session['user']['id'])
    return jsonify({
        'loggedIn': True,
        'user': session['user'],
        'hasTeam': bool(team),
        'team': {'id': team['id'], 'team_name': team['team_name']} if team else None,
        'banned': bool(team.get('banned')) if team else False
    })


@auth_bp.route('/logout', methods=['POST'])
def logout():
    session.clear()
    return jsonify({'success': True})
