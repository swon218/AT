// Run from repository root with the SAME Node env file as atlas-api. No model invocation.
import 'dotenv/config'
import { createAgentStore } from '../server/agentStore.js'
const store = createAgentStore()
try {
  console.log(JSON.stringify(await store.call('maintenance', '', { guest_days: Number(process.env.AI_GUEST_DAYS || 7) })))
} catch { console.error('AI maintenance failed: database configuration/SQL check required'); process.exitCode = 1 }
