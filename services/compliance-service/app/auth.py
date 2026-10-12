"""API keys locally; Cognito ID tokens on AWS (also verified by API Gateway)."""
from __future__ import annotations

from dataclasses import dataclass, field

import jwt
from fastapi import Header, HTTPException

from . import config


@dataclass
class Principal:
    subject: str
    roles: set[str] = field(default_factory=set)
    account_id: str | None = None


API_KEYS = {
    "local-admin-key": Principal("local-admin", {"admin"}),
    "local-rep-key": Principal("local-sales-rep", {"sales_rep"}),
    "local-retailer-key": Principal("local-retailer", {"retailer"}, "ACC-FL-1001"),
}

_jwks = jwt.PyJWKClient(f"{config.COGNITO_ISSUER}/.well-known/jwks.json") if config.COGNITO_ISSUER else None


def _from_jwt(token: str) -> Principal:
    if _jwks is None:
        raise HTTPException(401, "JWT auth is not configured")
    key = _jwks.get_signing_key_from_jwt(token).key
    claims = jwt.decode(token, key, algorithms=["RS256"], issuer=config.COGNITO_ISSUER, audience=config.COGNITO_CLIENT_ID)
    roles = set(claims.get("cognito:groups", [])) & {"admin", "sales_rep", "retailer"}
    return Principal(claims.get("email", claims["sub"]), roles, claims.get("custom:account_id"))


def principal(x_api_key: str | None = Header(default=None), authorization: str | None = Header(default=None)) -> Principal:
    if config.AUTH_MODE == "api-key":
        p = API_KEYS.get(x_api_key or "")
        if p is None:
            raise HTTPException(401, "Send a valid X-API-Key header")
        return p
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(401, "Send a Cognito ID token as a Bearer token")
    try:
        return _from_jwt(authorization[7:])
    except jwt.PyJWTError as err:
        raise HTTPException(401, "Token is invalid or expired") from err


def require(p: Principal, *roles: str) -> None:
    if not p.roles & set(roles):
        raise HTTPException(403, f"Requires one of the roles: {', '.join(roles)}")
