import os
from dotenv import load_dotenv
from flask import Flask, session, request, send_from_directory, jsonify, make_response
from flask_session import Session
from datetime import timedelta
from database import close_db

# Load environment variables
load_dotenv()

app = Flask(__name__, static_folder='public', static_url_path='')

# Configuration
app.config['SECRET_KEY'] = os.getenv('SESSION_SECRET', 'doomsday-secret-change-in-production')
app.config['SESSION_TYPE'] = 'filesystem'
app.config['PERMANENT_SESSION_LIFETIME'] = timedelta(hours=24)
app.config['SESSION_COOKIE_HTTPONLY'] = True
app.config['SESSION_COOKIE_SAMESITE'] = 'Lax'
Session(app)

@app.teardown_appcontext
def teardown_db(exception):
    close_db(exception)

# Admin HTML security middleware
@app.before_request
def restrict_admin_html():
    if request.path == '/admin.html':
        user = session.get('user')
        if not user or user.get('role') != 'admin':
            return send_from_directory('public', '404.html'), 404

# Expose config endpoint
@app.route('/api/config')
def get_config():
    return jsonify({
        "googleClientId": os.getenv("GOOGLE_CLIENT_ID"),
        "allowedDomain": os.getenv("ALLOWED_DOMAIN", "dubai.bits-pilani.ac.in")
    })

# Serve root and index.html
@app.route('/')
def serve_index():
    return send_from_directory('public', 'index.html')

# Static routes
@app.route('/uploads/<path:filename>')
def custom_static_uploads(filename):
    return send_from_directory('uploads', filename)

# Blueprint registrations will go here
from routes.auth import auth_bp
from routes.api import api_bp
from routes.admin import admin_bp

app.register_blueprint(auth_bp, url_prefix='/auth')
app.register_blueprint(api_bp, url_prefix='/api')
app.register_blueprint(admin_bp, url_prefix='/admin')

# 404 Handler
@app.errorhandler(404)
def not_found(e):
    return send_from_directory('public', '404.html'), 404

if __name__ == '__main__':
    port = int(os.environ.get("PORT", 3000))
    print("\\n  ==========================================")
    print(f"      DOOMSDAY ARENA 2026 SERVER (FLASK)    ")
    print(f"      Running on http://localhost:{port}      ")
    print("  ==========================================\\n")
