"""
esi_client.py — Shared async HTTP client for all ESI calls
===========================================================
Single aiohttp.ClientSession shared across the entire app lifetime.
Provides:
  - Concurrency cap via asyncio.Semaphore (default 30 in-flight requests)
  - ETag caching: if ESI returns 304 Not Modified, the cached body is returned
    without any JSON parsing or processing — zero CPU cost on a cache hit
  - Transparent retry with exponential backoff (3 attempts)
  - ESI 429 / error-limit handling: waits out the Retry-After header

Usage:
    from esi_client import esi

    # In any async function:
    data, status = await esi.get(url, headers={"Authorization": "Bearer ..."})
    data, status = await esi.get(url, params={"page": 2})
    data, status = await esi.post(url, json=[12345, 67890])

    # Parallel fetch:
    results = await asyncio.gather(
        esi.get(url_a, headers=h),
        esi.get(url_b, headers=h),
    )

    # Get paginated endpoint — auto-fetches all pages, returns list of all items:
    items, total_pages = await esi.get_all_pages(url, headers=h, max_pages=10)

    # Startup / shutdown (called by server.py):
    await esi.start()
    await esi.close()
"""

import asyncio
import time
import json
import logging
from typing import Any

import aiohttp

log = logging.getLogger(__name__)

# ── Constants ─────────────────────────────────────────────────────────────────
ESI_BASE        = "https://esi.evetech.net/latest"
_DEFAULT_SEM    = 30       # max concurrent in-flight ESI requests
_MAX_RETRIES    = 3
_BACKOFF_BASE   = 1.5      # seconds; doubles each attempt: 1.5 → 3 → 6
_REQUEST_TIMEOUT = aiohttp.ClientTimeout(total=20, connect=8)


class _ETagEntry:
    __slots__ = ("etag", "data", "ts")
    def __init__(self, etag: str, data: Any):
        self.etag = etag
        self.data = data
        self.ts   = time.monotonic()


class ESIClient:
    """
    Reusable async ESI client.

    One instance (`esi`) is module-level so all code shares a single
    aiohttp.ClientSession (connection pool) and ETag dict.
    """

    def __init__(self, max_concurrent: int = _DEFAULT_SEM):
        self._sem     = asyncio.Semaphore(max_concurrent)
        self._session: aiohttp.ClientSession | None = None
        # Keys: (url, frozenset of relevant headers like Authorization)
        self._etags: dict[str, _ETagEntry] = {}

    # ── Lifecycle ─────────────────────────────────────────────────────────────

    async def start(self):
        """Create the shared session. Call once at app startup."""
        if self._session is None or self._session.closed:
            connector = aiohttp.TCPConnector(
                limit=_DEFAULT_SEM + 10,   # connection pool slightly above sem
                ssl=True,
                enable_cleanup_closed=True,
            )
            self._session = aiohttp.ClientSession(
                connector=connector,
                timeout=_REQUEST_TIMEOUT,
                headers={"User-Agent": "CREST-Dashboard/2.0 (+github)"},
                json_serialize=json.dumps,
            )
            log.info("[esi_client] Session started (max_concurrent=%d)", _DEFAULT_SEM)

    async def close(self):
        """Gracefully close the session. Call at app shutdown."""
        if self._session and not self._session.closed:
            await self._session.close()
            log.info("[esi_client] Session closed.")

    # ── Internal request helper ───────────────────────────────────────────────

    def _etag_key(self, method: str, url: str, headers: dict | None) -> str:
        auth = (headers or {}).get("Authorization", "")
        return f"{method}||{url}||{auth}"

    async def _request(
        self,
        method: str,
        url: str,
        *,
        headers: dict | None = None,
        params: dict | None = None,
        json_body: Any = None,
        use_etag: bool = True,
    ) -> tuple[Any, int]:
        """
        Make one ESI request, honouring ETags and retrying on transient errors.

        Returns (parsed_json_body, http_status_code).
        On total failure returns (None, 0).
        """
        if self._session is None:
            await self.start()

        req_headers = dict(headers or {})
        ekey = self._etag_key(method, url, headers) if use_etag else None

        if use_etag and ekey in self._etags:
            req_headers["If-None-Match"] = self._etags[ekey].etag

        async with self._sem:
            for attempt in range(_MAX_RETRIES):
                try:
                    async with self._session.request(
                        method, url,
                        headers=req_headers,
                        params=params,
                        json=json_body,
                    ) as resp:
                        status = resp.status

                        # ── ETag hit — no body to parse ──────────────────────
                        if status == 304 and use_etag and ekey in self._etags:
                            return self._etags[ekey].data, 304

                        # ── Rate limited — honour Retry-After ────────────────
                        if status == 429:
                            retry_after = float(resp.headers.get("Retry-After", "5"))
                            log.warning("[esi_client] 429 from %s, waiting %.1fs", url, retry_after)
                            await asyncio.sleep(retry_after)
                            continue

                        # ── Server errors — retry with backoff ───────────────
                        if status >= 500 and attempt < _MAX_RETRIES - 1:
                            delay = _BACKOFF_BASE * (2 ** attempt)
                            log.warning("[esi_client] %d from %s, retry %d in %.1fs", status, url, attempt + 1, delay)
                            await asyncio.sleep(delay)
                            continue

                        # ── Success ──────────────────────────────────────────
                        if status in (200, 201):
                            data = await resp.json(content_type=None)
                            if use_etag:
                                etag = resp.headers.get("ETag")
                                if etag:
                                    self._etags[ekey] = _ETagEntry(etag, data)
                            return data, status

                        # ── Other non-success (403, 404, etc.) ───────────────
                        return None, status

                except (aiohttp.ClientError, asyncio.TimeoutError) as exc:
                    if attempt < _MAX_RETRIES - 1:
                        delay = _BACKOFF_BASE * (2 ** attempt)
                        log.warning("[esi_client] Network error on %s: %s — retry in %.1fs", url, exc, delay)
                        await asyncio.sleep(delay)
                    else:
                        log.error("[esi_client] Giving up on %s after %d attempts: %s", url, _MAX_RETRIES, exc)

        return None, 0

    # ── Public API ────────────────────────────────────────────────────────────

    async def get(
        self,
        url: str,
        *,
        headers: dict | None = None,
        params: dict | None = None,
        use_etag: bool = True,
    ) -> tuple[Any, int]:
        return await self._request("GET", url, headers=headers, params=params, use_etag=use_etag)

    async def post(
        self,
        url: str,
        *,
        headers: dict | None = None,
        json_body: Any = None,
    ) -> tuple[Any, int]:
        return await self._request("POST", url, headers=headers, json_body=json_body, use_etag=False)

    async def get_pages(
        self,
        url: str,
        *,
        headers: dict | None = None,
        extra_params: dict | None = None,
        max_pages: int = 50,
        filter_fn=None,
    ) -> tuple[list, int]:
        """
        Fetch all pages of a paginated ESI endpoint concurrently.

        1. Fetches page 1 to discover X-Pages header.
        2. Fetches remaining pages in parallel (bounded by the semaphore).
        3. Applies optional filter_fn(item) → bool to each individual item.

        Returns (all_items, total_pages_fetched).
        """
        # Page 1 to get total_pages
        first_data, status = await self._request(
            "GET", url, headers=headers,
            params={**(extra_params or {}), "page": 1},
            use_etag=False,  # pagination responses aren't ETagged individually
        )
        if status not in (200, 304) or first_data is None:
            return [], 0

        # Discover total pages from first response's headers — we need to re-request
        # with the aiohttp response available so we inspect headers there.
        # We do this with a direct request instead of _request().
        async with self._session.get(
            url, headers=headers,
            params={**(extra_params or {}), "page": 1},
        ) as probe:
            total_pages = min(int(probe.headers.get("X-Pages", 1)), max_pages)
            probe_data  = await probe.json(content_type=None) if probe.status == 200 else first_data

        all_items = list(probe_data) if probe_data else []
        if filter_fn:
            all_items = [i for i in all_items if filter_fn(i)]

        if total_pages > 1:
            tasks = [
                self._request("GET", url, headers=headers,
                              params={**(extra_params or {}), "page": p},
                              use_etag=False)
                for p in range(2, total_pages + 1)
            ]
            for data, st in await asyncio.gather(*tasks):
                if data:
                    items = data if filter_fn is None else [i for i in data if filter_fn(i)]
                    all_items.extend(items)

        return all_items, total_pages


# ── Module-level singleton ─────────────────────────────────────────────────────
# Import this everywhere:  from esi_client import esi
esi = ESIClient()
