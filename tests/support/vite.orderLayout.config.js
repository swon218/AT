import {defineConfig} from 'vite'
import react from '@vitejs/plugin-react'
import {fileURLToPath} from 'node:url'
const fixture=fileURLToPath(new URL('./orderLayoutApi.js',import.meta.url))
export default defineConfig({envDir:false,plugins:[react(),{name:'block-layout-network',configureServer(server){server.middlewares.use((req,res,next)=>{if(req.url.startsWith('/api/')){res.statusCode=403;res.end('Fixture only');return}next()})}}],
  resolve:{alias:[{find:'../services/openOrdersApi',replacement:fixture},{find:'../services/orderApi',replacement:fixture}]},server:{host:'127.0.0.1',port:5182,strictPort:true}})
