# Stock search deployment

The global header uses one search component on Dashboard, Stock Orders, and Assets.
It searches all KOSPI/KOSDAQ names and codes through the VPS, independently of the
20-stock ranking list. Lab keeps its separate historical-data search.

## VPS update

Use the existing installation and service account. Check for local changes before
pulling; preserve them if present. No schema, environment, or Python changes are
required. Do not stop or restart `atlas-lab-collect.service` or its timer.

```sh
cd /opt/atlas
git status --short
# Run the pull as the existing repository owner (atlas).
sudo -u atlas git pull --ff-only origin main
npm run test:server
sudo systemctl restart atlas-api.service
sudo systemctl status atlas-api.service --no-pager
curl --fail --get --data-urlencode 'q=삼성' 'http://127.0.0.1:3000/api/public/market/kiwoom/search'
curl --fail 'http://127.0.0.1:3000/api/public/market/kiwoom/search?q=005930'
curl --fail 'http://127.0.0.1:3000/api/public/market/kiwoom/quote?symbol=005930'
```

Use the API service's existing port if it is not 3000. Frontend deployment is
separate: verify Vercel has deployed the same commit and reload the browser.
Deploy the API before relying on the new frontend search.

## Credential selection and verification

- Guest, or logged-in user without both personal Kiwoom keys: operator Kiwoom API.
- A Toss key does not affect search credential selection.
- User with personal Kiwoom keys: their Kiwoom API. Invalid personal credentials
  return an error; there is no silent fallback to the operator.
- Browser sends its Supabase session token only. Broker keys stay on the VPS.
- `ka10099`: market `0` (KOSPI), `10` (KOSDAQ), including continuation pages.
- Server caches the complete catalog for 30 minutes separately for operator and
  each user/key version. Repeated typing searches that catalog. First load or
  expiry calls Kiwoom using the resolved credentials. No SQLite/Supabase table.
- `ka10001`: load the selected stock's current quote. Catalog previous-close
  prices are not displayed as current prices.

In the browser, test `삼성`, an exact code (`005930`), a KOSDAQ stock, and no match.
Enter selects the first result by default; arrows change selection; click selects
directly. Each selection opens Stock Orders in Kiwoom mode. No order is sent by
search. Operator credentials are used only for market data, never for orders.
The existing ability to manually select a personal Toss account is separate.

For logged-in cases, verify using the user's own session in the browser; never
paste or report API keys or session tokens in deployment logs or chat.

Official contract used:
https://github.com/Kiwoom-Securities/Kiwoom-REST-API/blob/main/examples/국내주식/종목정보/list_domestic_stocks.py
