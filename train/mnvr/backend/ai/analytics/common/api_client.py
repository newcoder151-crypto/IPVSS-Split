"""Authenticated client for the Node API.

Fixes the two problems that currently stop indexer.py:
  * the login JWT lasts 8h — we read its real `exp` and re-login early, and
    re-login once on any 401, instead of assuming a fixed 20h lifetime;
  * a must_change_password account is detected up front with a clear message
    instead of looping on 403.

Bad credentials are FATAL on the first attempt: the API locks an account
after 5 failed logins, so retrying a wrong password in a loop would lock the
service account out within minutes.
"""
import base64
import json
import logging
import threading
import time

import requests

log = logging.getLogger("analytics.api")


class ApiError(Exception):
    pass


class FatalAuthError(ApiError):
    """Credentials/account state that retrying cannot fix."""


class ApiRejected(ApiError):
    """4xx other than 401 — the payload is wrong; retrying won't help."""


def _jwt_exp(token: str) -> float:
    try:
        payload = token.split(".")[1]
        payload += "=" * (-len(payload) % 4)
        return float(json.loads(base64.urlsafe_b64decode(payload))["exp"])
    except Exception:
        return time.time() + 3600


class ApiClient:
    def __init__(self, base_url, username, password, timeout=15):
        self.base_url = base_url.rstrip("/")
        self.username = username
        self.password = password
        self.timeout = timeout
        self._token = None
        self._exp = 0.0
        self._lock = threading.Lock()
        self._local = threading.local()  # requests.Session isn't thread-safe

    def _session(self):
        s = getattr(self._local, "s", None)
        if s is None:
            s = self._local.s = requests.Session()
        return s

    def _login(self):
        r = self._session().post(
            f"{self.base_url}/api/auth/login",
            json={"username": self.username, "password": self.password},
            timeout=self.timeout,
        )
        if r.status_code == 401:
            raise FatalAuthError("login rejected (bad ANALYTICS_USER / ANALYTICS_PASS?)")
        if r.status_code == 403:
            raise FatalAuthError(f"account locked or disabled: {r.text[:200]}")
        if r.status_code != 200:
            raise ApiError(f"login failed: HTTP {r.status_code}")
        data = r.json()
        if data.get("must_change_password"):
            raise FatalAuthError(
                "this account has must_change_password set — every API call "
                "would return 403. Do not use the seeded admin: create a service "
                "account with  cd backend/api && node create-service-user.js <user> <password>"
            )
        self._token = data["token"]
        self._exp = _jwt_exp(self._token)
        log.info("authenticated as %s", self.username)

    def _ensure_token(self, force=False):
        with self._lock:
            if force or not self._token or time.time() > self._exp - 120:
                self._login()

    def request(self, method, path, **kw):
        self._ensure_token()
        for attempt in (1, 2):
            r = self._session().request(
                method, f"{self.base_url}{path}",
                headers={"Authorization": f"Bearer {self._token}"},
                timeout=self.timeout, **kw,
            )
            if r.status_code == 401 and attempt == 1:
                self._ensure_token(force=True)
                continue
            return r

    def get_config(self) -> dict:
        r = self.request("GET", "/api/analytics/config")
        if r.status_code == 403:
            raise FatalAuthError("403 from /api/analytics/config — is this user's role ADMIN or API_CLIENT?")
        r.raise_for_status()
        return r.json()

    def post_event(self, payload: dict) -> dict:
        r = self.request("POST", "/api/analytics/events", json=payload)
        if 400 <= r.status_code < 500 and r.status_code != 401:
            raise ApiRejected(f"HTTP {r.status_code}: {r.text[:300]}")
        r.raise_for_status()
        return r.json()
