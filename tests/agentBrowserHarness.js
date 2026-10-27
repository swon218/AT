// Explicit test launcher; no real provider, Supabase, broker or Naver credentials are read.
import { startHarness } from './support/agentHarness.js'
const harness = await startHarness()
console.log('Local fixture API ready at ' + harness.base)
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { void harness.close().then(() => process.exit(0)) })
