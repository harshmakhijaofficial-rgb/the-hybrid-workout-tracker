"""One-time Google Sheets OAuth setup. Nothing is submitted to ChatGPT."""
from pathlib import Path
from server import DATA

ROOT=Path(__file__).resolve().parent
CREDS=ROOT/'credentials.json'
TOKEN=DATA/'token.json'

if not CREDS.exists():
    raise SystemExit('Missing credentials.json. Follow README.md to create a Google Cloud Desktop OAuth client and save its JSON file beside this script.')
try:
    from google_auth_oauthlib.flow import InstalledAppFlow
except ImportError:
    raise SystemExit('First run: python -m pip install -r requirements.txt')

scope=['https://www.googleapis.com/auth/spreadsheets']
flow=InstalledAppFlow.from_client_secrets_file(str(CREDS),scopes=scope)
print('Opening Google login in your browser. Sign in to the account that can edit your workout Sheet.')
creds=flow.run_local_server(port=0,open_browser=True,prompt='consent',access_type='offline',authorization_prompt_message='Please authorize Sheets access in your browser.')
TOKEN.parent.mkdir(parents=True,exist_ok=True)
TOKEN.write_text(creds.to_json(),encoding='utf-8')
print('Google connected. You can now click Sync now in THE HYBRID app.')
