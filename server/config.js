import 'dotenv/config'

export const config = {
  port: Number(process.env.PORT || 3000),
  host: process.env.HOST || '127.0.0.1',
  frontendOrigin: process.env.FRONTEND_ORIGIN || 'http://127.0.0.1:5173',
  kiwoomHost: process.env.KIWOOM_API_HOST || 'https://api.kiwoom.com',
  kiwoomAppKey: process.env.KIWOOM_APPKEY || process.env.app_key || '',
  kiwoomSecretKey: process.env.KIWOOM_SECRETKEY || process.env.secret_key || '',
  naverClientId: process.env.NAVER_CLIENT_ID || process.env.client_id || '',
  naverClientSecret: process.env.NAVER_CLIENT_SECRET || process.env.client_secret || '',
}

export function publicConfigurationStatus() {
  return {
    kiwoomConfigured: Boolean(config.kiwoomAppKey && config.kiwoomSecretKey),
    naverConfigured: Boolean(config.naverClientId && config.naverClientSecret),
  }
}
