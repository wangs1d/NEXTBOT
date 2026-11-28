# 直接向 ComfyUI 提交 MuseTalk 工作流（验证生成层）
$ErrorActionPreference = "Stop"
$avatarDir = "E:/ws-project/NextBot/avatar-talk-service/assets/avatar_frames"
$audioPath = "E:/ws-project/NextBot/avatar-talk-service/data/tts/tts.wav"
$tpl = Get-Content "E:\ws-project\NextBot\avatar-talk-service\workflows\musetalk_s2v_api.json" -Raw -Encoding UTF8
$wf = $tpl.Replace("{{AVATAR_DIR}}", $avatarDir).Replace("{{AUDIO_PATH}}", $audioPath)
$body = '{"prompt": ' + $wf + '}'
$body | Out-File -Encoding utf8 "$env:TEMP\wf_submit.json"
$resp = curl.exe -s -X POST -H "Content-Type: application/json" --data-binary "@$env:TEMP\wf_submit.json" "http://127.0.0.1:8188/prompt"
echo "SUBMIT => $resp"
