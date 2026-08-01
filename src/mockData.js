// 비로그인 첫 화면에는 사용자 자산이나 시장 데이터를 하드코딩하지 않습니다.
// 실시간 종목과 캔들은 VPS API, 뉴스는 추후 VPS의 네이버 뉴스 API를 통해 받습니다.
export const rankingStocks = {
  realtime: [], rising: [], falling: [], volume: [], surge: [], favorites: [],
}
export const positions = []
export const news = []
