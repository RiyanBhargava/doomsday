import os
import sys

# Add your project directory to the sys.path
project_home = u'/home/acmdoomsday2026/doomsday'
if project_home not in sys.path:
    sys.path = [project_home] + sys.path

# Load environment variables
from dotenv import load_dotenv
load_dotenv(os.path.join(project_home, '.env'))

# import flask app but need to call it "application" for WSGI to work
from app import app as application
