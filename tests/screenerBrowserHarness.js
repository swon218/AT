// Local-only UI QA against the real Node -> FastAPI -> fixture SQLite path.
// No production .env, API keys, personal accounts or external model calls.
import {createServer} from 'vite'
import react from '@vitejs/plugin-react'
import {fileURLToPath} from 'node:url'
import {startHarness} from './support/agentHarness.js'
const root=fileURLToPath(new URL('../',import.meta.url))
const h=await startHarness({port:13180,pythonPort:18180,publicOrigin:'http://127.0.0.1:15180'})
const vite=await createServer({root,configFile:false,envDir:false,plugins:[react()],server:{host:'127.0.0.1',port:15180,strictPort:true,proxy:{'/api':{target:h.base}}}})
await vite.listen()
console.log('SCREENER_UI_FIXTURE_READY http://127.0.0.1:15180/tests/support/screenerBrowser.html')
let closing=false
const close=async()=>{if(closing)return;closing=true;await vite.close();await h.close();process.exit(0)}
process.on('SIGINT',close);process.on('SIGTERM',close)
