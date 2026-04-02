import os
import sys

# Scheduled task to run every n minutes for syncing to Google Drive fully
# Set this up in the "Tasks" tab on PythonAnywhere.

project_home = os.path.dirname(os.path.abspath(__file__))
if project_home not in sys.path:
    sys.path.insert(0, project_home)

from dotenv import load_dotenv
load_dotenv(os.path.join(project_home, '.env'))

from services.gdrive import init_gdrive, full_sync

if __name__ == '__main__':
    if init_gdrive():
        print("Starting full sync...")
        full_sync()
        print("Sync complete.")
    else:
        print("Failed to initialize Google Drive sync.")
