"""Reviewed exchange closures, not inferred missing-data exceptions.

KRX notice, 2026-05-20 (official KIND disclosure and its original document):
https://kind.krx.co.kr/common/disclsviewer.do?acptNo=20260520000110&docno=20260520000197&method=searchInitInfo
https://kind.krx.co.kr/external/2026/05/20/000110/20260520000197/32154.htm
The KIND document covers KONEX; the KRX all-markets announcement is also reported at:
https://www.yna.co.kr/view/AKR20260520064251008

These two known omissions in pinned exchange_calendars 4.13.2 are applied to the
calendar itself, so session navigation and gap validation always share one rule.
No candles, quality decisions or ordinary missing sessions are changed.
"""
VERSION = 'atlas-krx-closures-2026-v1'
CLOSURES = {'2026-06-03': '지방선거일', '2026-07-17': '제헌절'}
