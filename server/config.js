import 'dotenv/config'

export const config = {
  port: Number(process.env.PORT || 3000),
  host: process.env.HOST || '127.0.0.1',
  frontendOrigin: process.env.FRONTEND_ORIGIN || 'http://127.0.0.1:5173',
  kiwoomHost: process.env.KIWOOM_API_HOST || 'https://api.kiwoom.com',
  kiwoomAppKey: process.env.KIWOOM_APP_KEY || process.env.kiwoom_app_key || '',
  kiwoomSecretKey: process.env.KIWOOM_SECRET_KEY || process.env.kiwoom_secret_key || '',
  kiwoomOrdersEnabled: process.env.KIWOOM_ORDERS_ENABLED === 'true',
  tossApiKey: process.env.TOSS_API_KEY || process.env.toss_api_key || '',
  tossSecretKey: process.env.TOSS_SECRET_KEY || process.env.toss_secret_key || '',
  naverClientId: process.env.NAVER_CLIENT_ID || process.env.client_id || '',
  naverClientSecret: process.env.NAVER_CLIENT_SECRET || process.env.client_secret || '',
  supabaseUrl: process.env.SUPABASE_URL || '',
  supabasePublishableKey: process.env.SUPABASE_PUBLISHABLE_KEY || '',
  supabaseSecretKey: process.env.SUPABASE_SECRET_KEY || '',
  credentialEncryptionKey: process.env.ATLAS_CREDENTIAL_ENCRYPTION_KEY || '',
}

export function publicConfigurationStatus() {
  return {
    kiwoomConfigured: Boolean(config.kiwoomAppKey && config.kiwoomSecretKey),
    kiwoomOrdersEnabled: config.kiwoomOrdersEnabled,
    tossConfigured: Boolean(config.tossApiKey && config.tossSecretKey),
    naverConfigured: Boolean(config.naverClientId && config.naverClientSecret),
    accountSettingsConfigured: Boolean(
      config.supabaseUrl
      && config.supabasePublishableKey
      && config.supabaseSecretKey
      && config.credentialEncryptionKey
    ),
  }
}
