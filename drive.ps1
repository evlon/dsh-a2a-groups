# Drive the page entirely inside one browser session so the screenshot matches the action.
$s = "pb3091"
$inject = @"
import { readFileSync } from 'node:fs';
const home = 'C:/Users/niukl/.dsh-a2a-dev';
const log = readFileSync(home + '/out.log', 'utf8');
const m = /token=([A-Za-z0-9_-]+)/.exec(log);
console.log(m ? m[1] : '');
"@
$inject | Out-File -FilePath "$env:TEMP\tok.mjs" -Encoding utf8
$token = (node "$env:TEMP\tok.mjs").Trim()
if(-not $token){ "未取到 token"; exit 1 }
"token 长度: $($token.Length)"
& 'C:\Program Files\Git\bin\bash.exe' @('-c',"cd /e/dsh-a2a-bus && opencli browser $s open 'http://127.0.0.1:3091/?token=$token' 2>&1 | tail -2") 2>&1
