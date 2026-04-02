import os
from dotenv import load_dotenv
load_dotenv()
import services.gdrive as gdrive

if gdrive.init_gdrive():
    try:
        about = gdrive.drive_service.about().get(fields="user").execute()
        print(f"\n--- AUTHENTICATED DRIVE ACCOUNT ---")
        print(f"Email: {about['user']['emailAddress']}")
        print(f"Name: {about['user']['displayName']}")
        
        print(f"\n--- LOCATING FILES ---")
        res = gdrive.drive_service.files().list(q="trashed=false", fields="files(id, name, webViewLink, parents, mimeType)").execute()
        files = res.get('files', [])
        
        found = False
        for f in files:
            if f['name'] in ['activity_log.csv', 'submissions_log.csv', 'Events', 'Doomsday Arena 2026']:
                print(f"- {f['name']} \n  Link: {f.get('webViewLink', 'N/A')}")
                found = True
                
        if not found:
            print("No Doomsday Arena files found in this Drive.")
        print("-----------------------------------")
    except Exception as e:
        print("Error checking Drive:", e)
