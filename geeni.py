#!/usr/bin/env python3
"""Control Merkury/Geeni smart bulbs via the Pepper SDK API."""

import hashlib
import hmac
import json
import sys
from datetime import datetime, timezone

import requests

BASE_URL = "https://api.pepperos.io"
BRAND = "geeni"
PEPPER_TOKEN = "69a62fdc-795f-4ec7-9e84-568d0b560215"

DEVICE_IDS = {
    "1": "1a0646bf-39e8-41af-b215-6640df3b70ba",
    "2": "86d6d6a4-797c-4a47-aaa8-f8fe67a220d9",
}


def get_aws_credentials():
    import base64
    basic = base64.b64encode(f"{BRAND}:{PEPPER_TOKEN}".encode()).decode()
    r = requests.post(
        f"{BASE_URL}/authentication/byToken",
        headers={
            "Authorization": f"Basic {basic}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        },
    )
    r.raise_for_status()
    data = r.json()
    creds = data["pepperUser"]["awsUserCredentials"]
    return {
        "access_key": creds["AccessKeyId"],
        "secret_key": creds["SecretAccessKey"],
        "session_token": creds["SessionToken"],
        "pepper_jwt": data["token"],
    }


def _sign(key, msg):
    return hmac.new(key, msg.encode("utf-8"), hashlib.sha256).digest()


def _make_headers(creds, method, path, body=b""):
    access_key = creds["access_key"]
    secret_key = creds["secret_key"]
    session_token = creds["session_token"]
    pepper_jwt = creds["pepper_jwt"]

    service = "execute-api"
    region = "us-east-1"
    host = "api.pepperos.io"
    now = datetime.now(timezone.utc)
    amzdate = now.strftime("%Y%m%dT%H%M%SZ")
    datestamp = now.strftime("%Y%m%d")

    payload_hash = hashlib.sha256(body).hexdigest()

    # Must match exactly what we sign
    signed_headers = "accept;host;peppertoken;x-amz-date;x-amz-security-token"
    canonical_headers = (
        f"accept:application/json\n"
        f"host:{host}\n"
        f"peppertoken:{pepper_jwt}\n"
        f"x-amz-date:{amzdate}\n"
        f"x-amz-security-token:{session_token}\n"
    )

    canonical_request = "\n".join([
        method, path, "",
        canonical_headers, signed_headers, payload_hash,
    ])

    credential_scope = f"{datestamp}/{region}/{service}/aws4_request"
    string_to_sign = "\n".join([
        "AWS4-HMAC-SHA256", amzdate, credential_scope,
        hashlib.sha256(canonical_request.encode("utf-8")).hexdigest(),
    ])

    signing_key = _sign(
        _sign(_sign(_sign(f"AWS4{secret_key}".encode("utf-8"), datestamp), region), service),
        "aws4_request",
    )
    signature = hmac.new(signing_key, string_to_sign.encode("utf-8"), hashlib.sha256).hexdigest()

    auth = (
        f"AWS4-HMAC-SHA256 Credential={access_key}/{credential_scope}, "
        f"SignedHeaders={signed_headers}, Signature={signature}"
    )

    headers = {
        "Authorization": auth,
        "Accept": "application/json",
        "peppertoken": pepper_jwt,
        "x-amz-date": amzdate,
        "x-amz-security-token": session_token,
    }
    if body:
        headers["Content-Type"] = "application/json"
    return headers


def list_devices(creds):
    path = "/account/devices"
    r = requests.get(f"{BASE_URL}{path}", headers=_make_headers(creds, "GET", path))
    print(f"Status: {r.status_code}")
    try:
        data = r.json()
        devices = data if isinstance(data, list) else data.get("devices", data)
        for d in (devices if isinstance(devices, list) else [data]):
            print(f"  {d.get('id') or d.get('deviceId')}  {d.get('name', '?')!r}  [{d.get('type', '?')}]")
    except Exception:
        print(r.text)


def set_setting(creds, device_id, setting_id, value):
    path = f"/account/devices/{device_id}/settings/{setting_id}"
    body = json.dumps({"valueJson": json.dumps(value)}).encode()
    r = requests.put(f"{BASE_URL}{path}", headers=_make_headers(creds, "PUT", path, body), data=body)
    print(f"Status: {r.status_code}  {r.text}")
    return r



SCENES = ["night", "rainbow", "reading", "cocktail", "leisure",
          "soft", "blinking", "rave", "nature", "custom"]


def resolve_devices(arg):
    """Return list of device IDs. 'all' expands to all known devices."""
    if arg == "all":
        return list(DEVICE_IDS.values())
    return [DEVICE_IDS.get(arg, arg)]


def usage():
    print(f"""Usage:
  python3 geeni.py devices
  python3 geeni.py on         <1|2|all|device_id>
  python3 geeni.py off        <1|2|all|device_id>
  python3 geeni.py brightness <1|2|all|device_id> <0-100>
  python3 geeni.py color      <1|2|all|device_id> <RRGGBB>
  python3 geeni.py colortemp  <1|2|all|device_id> <2700-6500>
  python3 geeni.py scene      <1|2|all|device_id> <{'|'.join(SCENES)}>

Known devices:""")
    for k, v in DEVICE_IDS.items():
        print(f"  {k} = {v}")
    sys.exit(1)


def main():
    if len(sys.argv) < 2:
        usage()

    cmd = sys.argv[1]
    print("Authenticating...")
    creds = get_aws_credentials()
    print("OK")

    if cmd == "devices":
        list_devices(creds)
    elif cmd in ("on", "off"):
        val = 1 if cmd == "on" else 0
        for did in resolve_devices(sys.argv[2]):
            set_setting(creds, did, "light.stateOn", val)
    elif cmd == "brightness":
        for did in resolve_devices(sys.argv[2]):
            set_setting(creds, did, "light.brightness", int(sys.argv[3]))
    elif cmd == "color":
        for did in resolve_devices(sys.argv[2]):
            set_setting(creds, did, "light.color", sys.argv[3].lstrip("#"))
    elif cmd == "colortemp":
        for did in resolve_devices(sys.argv[2]):
            set_setting(creds, did, "light.colorTemp", int(sys.argv[3]))
    elif cmd == "scene":
        scene = sys.argv[3].lower()
        if scene not in SCENES:
            print(f"Unknown scene '{scene}'. Valid: {', '.join(SCENES)}")
            sys.exit(1)
        for did in resolve_devices(sys.argv[2]):
            set_setting(creds, did, "light.scene", scene)
            set_setting(creds, did, "light.mode", "scene")
    else:
        usage()


if __name__ == "__main__":
    main()
