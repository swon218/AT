import { getKiwoomStockCatalog } from './kiwoomMarketApi'
import { createStockCatalogCache } from '../utils/stockCatalogCache.js'

export const stockCatalog = createStockCatalogCache({ fetchCatalog: getKiwoomStockCatalog })
