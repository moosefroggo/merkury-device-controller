#!/usr/bin/env python3
"""Fire animation with smooth color transitions for Merkury/Geeni smart bulbs."""

import base64
import hashlib
import hmac
import json
import random
import time
from datetime import datetime, timezone

import requests

BASE_URL = "https://api.pepperos.io"
BRAND = "geeni"
PEPPER_TOKEN = "69a62fdc-795f-4ec7-9e84-568d0b560215"

DEVICE_IDS = [
    "1a0646bf-39e8-41af-b215-6640df3b70ba",
    "86d6d6a4-797c-4a47-aaa8-f8fe67a220d9",
]

# Fire palette: (R, G, B, brightness%)
FIRE_STATES = [
    (255, 20,  0,  35),   # deep ember
    (255, 50,  0,  50),   # low flame
    (255, 80,  0,  60),   # orange flame
    (255, 120, 5,  75),   # bright orange
    (255, 150, 10, 85),   # hot flame
    (255, 170, 20, 95),   # peak flame
    (255, 140, 10, 80),   # settling
    (255, 100, 0,  65),   # dying down
    (200, 30,  0,  45),   # ember
    (180, 15,  0,  38),   # low ember
]


def get_creds():
    basic = base64.b64encode(f"{BRAND}:{PEPPER_TOKEN}".encode()).decode()
    r = requests.post(
        f"{BASE_URL}/authentication/byToken",
        headers={"Authorization": f"Basic {basic}", "Accept": "application/json"},
    )
    r.raise_for_status()
    data = r.json()
    c = data["pepperUser"]["awsUserCredentials"]
    return {
        "access_key": c["AccessKeyId"],
        "secret_key": c["SecretAccessKey"],
        "session_token": c["SessionToken"],
        "pepper_jwt": data["token"],
    }


def _sign(key, msg):
    return hmac.new(key, msg.encode(), hashlib.sha256).digest()


def _make_headers(creds, method, path, body=b""):
    now = datetime.now(timezone.utc)
    amzdate = now.strftime("%Y%m%dT%H%M%SZ")
    datestamp = now.strftime("%Y%m%d")
    pepper_jwt = creds["pepper_jwt"]

    signed_headers = "accept;host;peppertoken;x-amz-date;x-amz-security-token"
    canonical_headers = (
        f"accept:application/json\n"
        f"host:api.pepperos.io\n"
        f"peppertoken:{pepper_jwt}\n"
        f"x-amz-date:{amzdate}\n"
        f"x-amz-security-token:{creds['session_token']}\n"
    )
    payload_hash = hashlib.sha256(body).hexdigest()
    canonical_request = "\n".join([method, path, "", canonical_headers, signed_headers, payload_hash])
    credential_scope = f"{datestamp}/us-east-1/execute-api/aws4_request"
    string_to_sign = "\n".join([
        "AWS4-HMAC-SHA256", amzdate, credential_scope,
        hashlib.sha256(canonical_request.encode()).hexdigest(),
    ])
    signing_key = _sign(
        _sign(_sign(_sign(f"AWS4{creds['secret_key']}".encode(), datestamp), "us-east-1"), "execute-api"),
        "aws4_request",
    )
    signature = hmac.new(signing_key, string_to_sign.encode(), hashlib.sha256).hexdigest()

    headers = {
        "Authorization": f"AWS4-HMAC-SHA256 Credential={creds['access_key']}/{credential_scope}, SignedHeaders={signed_headers}, Signature={signature}",
        "Accept": "application/json",
        "peppertoken": pepper_jwt,
        "x-amz-date": amzdate,
        "x-amz-security-token": creds["session_token"],
    }
    if body:
        headers["Content-Type"] = "application/json"
    return headers


def set_setting(creds, device_id, setting_id, value):
    path = f"/account/devices/{device_id}/settings/{setting_id}"
    body = json.dumps({"valueJson": json.dumps(value)}).encode()
    requests.put(f"{BASE_URL}{path}", headers=_make_headers(creds, "PUT", path, body), data=body)


def lerp(a, b, t):
    return int(a + (b - a) * t)


def set_color_brightness(creds, device_id, r, g, b, brightness):
    hex_color = f"{r:02X}{g:02X}{b:02X}"
    set_setting(creds, device_id, "light.color", hex_color)
    set_setting(creds, device_id, "light.brightness", brightness)


def transition(creds, device_id, from_state, to_state, steps=8, step_delay=0.06):
    fr, fg, fb, fbr = from_state
    tr, tg, tb, tbr = to_state
    for i in range(1, steps + 1):
        t = i / steps
        r = lerp(fr, tr, t)
        g = lerp(fg, tg, t)
        b = lerp(fb, tb, t)
        br = lerp(fbr, tbr, t)
        set_color_brightness(creds, device_id, r, g, b, br)
        time.sleep(step_delay)


def main():
    print("Authenticating...")
    creds = get_creds()
    print("Starting fire animation. Press Ctrl+C to stop.\n")

    for did in DEVICE_IDS:
        set_setting(creds, did, "light.stateOn", 1)
        set_color_brightness(creds, did, *FIRE_STATES[0][:3], FIRE_STATES[0][3])

    # each bulb tracks its own current state independently
    current = [random.choice(FIRE_STATES) for _ in DEVICE_IDS]

    try:
        while True:
            for i, did in enumerate(DEVICE_IDS):
                target = random.choice(FIRE_STATES)
                # add subtle noise to the target so each flicker is unique
                tr, tg, tb, tbr = target
                tr = min(255, max(0, tr + random.randint(-15, 15)))
                tg = min(255, max(0, tg + random.randint(-8, 8)))
                tb = min(255, max(0, tb + random.randint(-3, 3)))
                tbr = min(100, max(20, tbr + random.randint(-10, 10)))
                noisy_target = (tr, tg, tb, tbr)

                steps = random.randint(5, 12)
                step_delay = random.uniform(0.04, 0.09)
                transition(creds, did, current[i], noisy_target, steps=steps, step_delay=step_delay)
                current[i] = noisy_target

    except KeyboardInterrupt:
        print("\nStopped. Restoring warm white...")
        for did in DEVICE_IDS:
            set_setting(creds, did, "light.color", "FF6A00")
            set_setting(creds, did, "light.brightness", 80)


if __name__ == "__main__":
    main()
