import re

with open('routes/api.py', 'r', encoding='utf-8') as f:
    lines = f.readlines()

new_lines = []
for line in lines:
    new_lines.append(line)
    if "return jsonify({'error': 'Provide an answer'}), 400" in line:
        new_lines.append("\n    answer = data.get('answer', '').strip()\n")    
    if "return jsonify({'success': True, 'submissionId': submission_id})" in line:
        # We need to insert the sync code BEFORE this return
        # So we pop the return, add the sync, and add the return back
        ret = new_lines.pop()
        new_lines.append("    try:\n        gdrive.sync_activity_log()\n        gdrive.sync_submissions_log()\n    except Exception as e:\n        print('Drive sync error:', e)\n\n")
        new_lines.append(ret)

with open('routes/api.py', 'w', encoding='utf-8') as f:
    f.writelines(new_lines)

print("Done")
