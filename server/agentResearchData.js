import { agentMarketData } from './agentMarketData.js'
import { agentFundamentalData } from './agentFundamentalData.js'

export function createAgentResearchData({market=agentMarketData,fundamental=agentFundamentalData}={}) {
  return {
    status:()=>({...market.status(),...fundamental.status()}),
    read:(tool,args,permit)=>typeof tool!=='string'?{status:'error',code:'invalid_arguments'}:tool.startsWith('get_company_')?fundamental.read(tool,args,permit):market.read(tool,args,permit),
  }
}
export const agentResearchData=createAgentResearchData()
