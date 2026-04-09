from app import app
from database import query_db, insert_db

with app.app_context():
    users = query_db('SELECT id, email, name FROM users')
    teams = query_db('SELECT id, team_name, team_code FROM teams')
    team_members = query_db('SELECT id, team_id, user_id FROM team_members')
    print("USERS:", users)
    print("TEAMS:", teams)
    print("MEM:", team_members)
