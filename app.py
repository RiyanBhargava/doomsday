import os
from dotenv import load_dotenv
from flask import Flask, session, request, send_from_directory, jsonify, make_response
from flask_session import Session
from flask_socketio import SocketIO
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

# SocketIO (configured for long-polling compatibility to work cleanly on WSGI / PythonAnywhere standard)
socketio = SocketIO(app, manage_session=False, cors_allowed_origins="*")

# Make socketio globally accessible to use carefully inside blueprints using current_app extensions if needed,
# or we can import it directly. It's safe to import `socketio` from app.py in other modules.

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

# SocketIO Events
@socketio.on('broadcast_announcement')
def handle_announcement(msg):
    socketio.emit('announcement', msg)

@socketio.on('maintenance_change')
def handle_maintenance(active):
    if active:
        socketio.emit('maintenance')

if __name__ == '__main__':
    port = int(os.environ.get("PORT", 3000))
    print("\\n  ==========================================")
    print(f"      DOOMSDAY ARENA 2026 SERVER (FLASK)    ")
    print(f"      Running on http://localhost:{port}      ")
    print("  ==========================================\\n")
    
    # Normally we would start GDrive sync daemon here, but in Python WSGI we might 
    # handle it differently.
    import threading
    from services.gdrive import init_gdrive, full_sync
    
    def background_sync():
        import time
        from database import get_db
        # Get a db connection for the background thread
        if init_gdrive():
            sync_interval_ms = int(os.getenv('DRIVE_SYNC_INTERVAL', 60000))
            sync_interval_s = sync_interval_ms / 1000.0
            
            # Application context is needed for DB logic if we rely on it, but we can just use 
            # a direct sqlite connection in the background thread.
            import sqlite3
            import database
            with app.app_context():
                time.sleep(5)
                # First sync
                full_sync()
                while True:
                    time.sleep(sync_interval_s)
                    try:
                        full_sync()
                    except Exception as e:
                        print(f"Background sync error: {e}")

    thread = threading.Thread(target=background_sync, daemon=True)
    thread.start()

    socketio.run(app, port=port, debug=True, use_reloader=False)
