import os
import io
import datetime
import re
import typing
from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build
from googleapiclient.http import MediaIoBaseUpload, MediaFileUpload

SCOPES = ['https://www.googleapis.com/auth/drive']
SUBFOLDERS = ['Submissions', 'Activity_Log', 'Database_Backups']

drive_service: typing.Any = None
folder_ids = {}   # { 'Submissions': 'driveId', ... }
root_folder_id = None
gdrive_initialized = False

def init_gdrive():
    global drive_service, root_folder_id, gdrive_initialized, folder_ids
    try:
        client_id = os.getenv('GDRIVE_CLIENT_ID')
        client_secret = os.getenv('GDRIVE_CLIENT_SECRET')
        refresh_token = os.getenv('GDRIVE_REFRESH_TOKEN')

        if not client_id or not client_secret or not refresh_token:
            print('  ⚠  Google Drive credentials not set in .env')
            return False

        creds = Credentials(
            None,
            refresh_token=refresh_token,
            token_uri="https://oauth2.googleapis.com/token",
            client_id=client_id,
            client_secret=client_secret
        )

        drive_service = build('drive', 'v3', credentials=creds)

        # Find or create: Events > Doomsday Arena 2026
        events_folder_id = find_or_create_folder('Events', 'root')
        root_folder_id = find_or_create_folder('Doomsday Arena 2026', events_folder_id)

        # Create subfolders
        for sub in SUBFOLDERS:
            folder_ids[sub] = find_or_create_folder(sub, root_folder_id)

        gdrive_initialized = True
        print('  ✓  Google Drive sync enabled')
        return True
    except Exception as e:
        print(f'  ✗  Google Drive init failed: {e}')
        return False

def find_or_create_folder(name, parent_id):
    query = f"name='{name}' and mimeType='application/vnd.google-apps.folder' and '{parent_id}' in parents and trashed=false"
    response = drive_service.files().list(q=query, fields='files(id, name)', spaces='drive').execute()
    files = response.get('files', [])

    if len(files) > 0:
        return files[0].get('id')

    # Create the folder
    file_metadata = {
        'name': name,
        'mimeType': 'application/vnd.google-apps.folder',
        'parents': [parent_id]
    }
    folder = drive_service.files().create(body=file_metadata, fields='id').execute()
    return folder.get('id')

def sanitize(s):
    if not s:
        return 'Unknown'
    s = str(s)
    s = re.sub(r'[<>:"/\\|?*]', '_', s)
    return s[:100]  # type: ignore

def esc(s):
    if s is None:
        return ''
    return str(s).replace('"', '""')

def upload_submission_file(file_obj, original_filename, mime_type, team_name, question_title):
    if not gdrive_initialized:
        return None
    try:
        safe_name = sanitize(team_name)
        team_folder_id = find_or_create_folder(safe_name, folder_ids['Submissions'])

        safe_question = sanitize(question_title)
        question_folder_id = find_or_create_folder(safe_question, team_folder_id)

        file_metadata = {
            'name': original_filename,
            'parents': [question_folder_id]
        }
        
        # Rewind file object for reading
        file_obj.seek(0)
        media = MediaIoBaseUpload(file_obj, mimetype=mime_type or 'application/octet-stream', resumable=True)
        
        res = drive_service.files().create(body=file_metadata, media_body=media, fields='id, name, webViewLink').execute()
        print(f"  📁 Drive: Uploaded submission → {safe_name}/{safe_question}/{original_filename}")
        return res
    except Exception as e:
        print(f"  ✗  Drive upload failed: {e}")
        return None

def sync_activity_log():
    from database import query_db
    if not gdrive_initialized:
        return
    try:
        rows = query_db('''
            SELECT al.created_at, al.team_id, t.team_name, al.category,
                   q.title AS question_title, al.activity_type, al.submitted_value
            FROM activity_log al
            LEFT JOIN teams t ON al.team_id = t.id
            LEFT JOIN questions q ON al.question_id = q.id
            ORDER BY al.created_at DESC
        ''')

        csv = 'Timestamp,Team #,Team Name,Category,Question,Activity Type,Submitted Value\n'
        for r in rows:
            csv += f'"{r["created_at"]}","{r["team_id"]}","{esc(r["team_name"])}","{esc(r["category"])}","{esc(r["question_title"])}","{r["activity_type"]}","{esc(r["submitted_value"])}"\n'

        upload_or_update('activity_log.csv', csv, folder_ids['Activity_Log'], 'text/csv')
        print(f"  📁 Drive: Synced activity log ({len(rows)} entries)")
    except Exception as e:
        print(f"  ✗  Drive activity sync failed: {e}")

def sync_submissions_log():
    from database import query_db
    if not gdrive_initialized:
        return
    try:
        rows = query_db('''
            SELECT s.id, s.submitted_at, s.team_id, t.team_name, q.category, q.title AS question_title,
                   s.submitted_value
            FROM submissions s
            LEFT JOIN teams t ON s.team_id = t.id
            LEFT JOIN questions q ON s.question_id = q.id
            ORDER BY s.submitted_at DESC
        ''')

        csv = 'Submission ID,Timestamp,Team #,Team Name,Category,Question,Submission Link\n'
        for r in rows:
            csv += f'"{r["id"]}","{r["submitted_at"]}","{r["team_id"]}","{esc(r["team_name"])}","{esc(r["category"])}","{esc(r["question_title"])}","{esc(r["submitted_value"])}"\n'

        upload_or_update('submissions_log.csv', csv, folder_ids['Activity_Log'], 'text/csv')
        print(f"  📁 Drive: Synced submissions log ({len(rows)} entries)")
    except Exception as e:
        print(f"  ✗  Drive submissions sync failed: {e}")

def backup_database():
    if not gdrive_initialized:
        return
    try:
        db_path = os.path.join(os.path.dirname(__file__), '..', 'doomsday.db')
        if not os.path.exists(db_path):
            return

        timestamp = datetime.datetime.now().isoformat().replace(':', '-').replace('.', '-')[:19]  # type: ignore
        backup_name = f"doomsday_backup_{timestamp}.db"

        upload_or_update('doomsday_latest.db', None, folder_ids['Database_Backups'], 'application/octet-stream', file_path=db_path)
        print(f"  📁 Drive: Database backup synced")
    except Exception as e:
        print(f"  ✗  Drive DB backup failed: {e}")

def upload_or_update(filename, content, folder_id, mime_type, file_path=None):
    query = f"name='{filename}' and '{folder_id}' in parents and trashed=false"
    response = drive_service.files().list(q=query, fields='files(id)', spaces='drive').execute()
    existing = response.get('files', [])

    if file_path:
        media = MediaFileUpload(file_path, mimetype=mime_type, resumable=True)
    else:
        # File object from string
        media = MediaIoBaseUpload(io.BytesIO(content.encode('utf-8')), mimetype=mime_type, resumable=True)

    if len(existing) > 0:
        drive_service.files().update(fileId=existing[0]['id'], media_body=media).execute()
    else:
        file_metadata = {'name': filename, 'parents': [folder_id]}
        drive_service.files().create(body=file_metadata, media_body=media, fields='id').execute()

def full_sync():
    if not gdrive_initialized:
        return
    try:
        sync_activity_log()
        sync_submissions_log()
        backup_database()
    except Exception as e:
        print(f"  ✗  Drive full sync failed: {e}")
