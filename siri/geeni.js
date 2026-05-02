// Geeni bulb controller for Scriptable + Siri Shortcuts
// -------------------------------------------------------
// Usage: call from a Shortcut with "Run Scriptable Script"
// Pass a parameter like:  on:1  |  off:all  |  scene:all:leisure  |  brightness:1:70  |  color:2:FF6A00
//
// Scenes: night, rainbow, reading, cocktail, leisure, soft, blinking, rave, nature

const BASE_URL = "https://api.pepperos.io";
const BRAND    = "geeni";
const TOKEN    = "69a62fdc-795f-4ec7-9e84-568d0b560215";

const DEVICE_IDS = {
  "1": "1a0646bf-39e8-41af-b215-6640df3b70ba",
  "2": "86d6d6a4-797c-4a47-aaa8-f8fe67a220d9",
};

// ── helpers ──────────────────────────────────────────────────────────────────

function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2)
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  return bytes;
}

function bytesToHex(buf) {
  return Array.from(new Uint8Array(buf))
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
}

async function sha256(data) {
  const buf = typeof data === "string"
    ? new TextEncoder().encode(data)
    : data;
  return bytesToHex(await crypto.subtle.digest("SHA-256", buf));
}

async function hmacSha256(keyBytes, msg) {
  const key = await crypto.subtle.importKey(
    "raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  return new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg))
  );
}

function utcNow() {
  const d = new Date();
  const pad = n => String(n).padStart(2, "0");
  const date = `${d.getUTCFullYear()}${pad(d.getUTCMonth()+1)}${pad(d.getUTCDate())}`;
  const time = `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
  return { amzdate: `${date}T${time}Z`, datestamp: date };
}

// ── auth ─────────────────────────────────────────────────────────────────────

async function getCredentials() {
  const basic = btoa(`${BRAND}:${TOKEN}`);
  const res = await fetch(`${BASE_URL}/authentication/byToken`, {
    method: "POST",
    headers: {
      "Authorization": `Basic ${basic}`,
      "Content-Type": "application/json",
      "Accept": "application/json",
    },
  });
  if (!res.ok) throw new Error(`Auth failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  const aws = data.pepperUser.awsUserCredentials;
  return {
    accessKey:    aws.AccessKeyId,
    secretKey:    aws.SecretAccessKey,
    sessionToken: aws.SessionToken,
    pepperJwt:    data.token,
  };
}

// ── SigV4 signing ─────────────────────────────────────────────────────────────

async function makeHeaders(creds, method, path, body = "") {
  const { accessKey, secretKey, sessionToken, pepperJwt } = creds;
  const service = "execute-api";
  const region  = "us-east-1";
  const host    = "api.pepperos.io";
  const { amzdate, datestamp } = utcNow();

  const bodyBytes  = new TextEncoder().encode(body);
  const bodyHash   = await sha256(bodyBytes.length ? bodyBytes : new Uint8Array(0));

  const signedHeaders  = "accept;host;peppertoken;x-amz-date;x-amz-security-token";
  const canonicalHeaders =
    `accept:application/json\n` +
    `host:${host}\n` +
    `peppertoken:${pepperJwt}\n` +
    `x-amz-date:${amzdate}\n` +
    `x-amz-security-token:${sessionToken}\n`;

  const canonicalRequest = [method, path, "", canonicalHeaders, signedHeaders, bodyHash].join("\n");
  const credentialScope  = `${datestamp}/${region}/${service}/aws4_request`;
  const stringToSign     = ["AWS4-HMAC-SHA256", amzdate, credentialScope,
                             await sha256(canonicalRequest)].join("\n");

  let signingKey = new TextEncoder().encode(`AWS4${secretKey}`);
  signingKey = await hmacSha256(signingKey, datestamp);
  signingKey = await hmacSha256(signingKey, region);
  signingKey = await hmacSha256(signingKey, service);
  signingKey = await hmacSha256(signingKey, "aws4_request");

  const signature = bytesToHex(await hmacSha256(signingKey, stringToSign));
  const auth = `AWS4-HMAC-SHA256 Credential=${accessKey}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const headers = {
    "Authorization":        auth,
    "Accept":               "application/json",
    "peppertoken":          pepperJwt,
    "x-amz-date":           amzdate,
    "x-amz-security-token": sessionToken,
  };
  if (body) headers["Content-Type"] = "application/json";
  return headers;
}

// ── API calls ─────────────────────────────────────────────────────────────────

async function setSetting(creds, deviceId, settingId, value) {
  const path = `/account/devices/${deviceId}/settings/${settingId}`;
  const body = JSON.stringify({ valueJson: JSON.stringify(value) });
  const headers = await makeHeaders(creds, "PUT", path, body);
  const res = await fetch(`${BASE_URL}${path}`, { method: "PUT", headers, body });
  if (!res.ok) throw new Error(`API error ${res.status}: ${await res.text()}`);
  return res.status;
}

async function setScene(creds, deviceId, sceneName) {
  await setSetting(creds, deviceId, "light.scene", sceneName);
  await setSetting(creds, deviceId, "light.mode",  "scene");
}

// ── command dispatch ──────────────────────────────────────────────────────────

function resolveDevices(bulb) {
  if (bulb === "all") return Object.values(DEVICE_IDS);
  if (DEVICE_IDS[bulb]) return [DEVICE_IDS[bulb]];
  return [bulb]; // raw UUID
}

async function run(paramStr) {
  const parts = (paramStr || "").trim().split(":");
  const cmd   = parts[0].toLowerCase();

  const creds = await getCredentials();
  const results = [];

  if (cmd === "on" || cmd === "off") {
    const devices = resolveDevices(parts[1] || "all");
    const val = cmd === "on" ? 1 : 0;
    for (const id of devices) {
      await setSetting(creds, id, "light.stateOn", val);
      results.push(`${cmd} → ${id.slice(0,8)}…`);
    }

  } else if (cmd === "scene") {
    const devices   = resolveDevices(parts[1] || "all");
    const sceneName = (parts[2] || "leisure").toLowerCase();
    const validScenes = ["night","rainbow","reading","cocktail","leisure",
                         "soft","blinking","rave","nature","custom"];
    if (!validScenes.includes(sceneName))
      throw new Error(`Unknown scene "${sceneName}". Valid: ${validScenes.join(", ")}`);
    for (const id of devices) {
      await setScene(creds, id, sceneName);
      results.push(`scene:${sceneName} → ${id.slice(0,8)}…`);
    }

  } else if (cmd === "brightness") {
    const devices = resolveDevices(parts[1] || "all");
    const value   = Math.max(0, Math.min(100, parseInt(parts[2] || "70")));
    for (const id of devices) {
      await setSetting(creds, id, "light.brightness", value);
      results.push(`brightness:${value} → ${id.slice(0,8)}…`);
    }

  } else if (cmd === "color") {
    const devices = resolveDevices(parts[1] || "all");
    const hex     = (parts[2] || "FF6A00").replace("#", "").toUpperCase();
    for (const id of devices) {
      await setSetting(creds, id, "light.color", hex);
      results.push(`color:#${hex} → ${id.slice(0,8)}…`);
    }

  } else {
    throw new Error(`Unknown command "${cmd}". Use: on, off, scene, brightness, color`);
  }

  return results.join("\n");
}

// ── entry point ───────────────────────────────────────────────────────────────

(async () => {
  const param = args.shortcutParameter;
  try {
    const result = await run(param);
    Script.setShortcutOutput(result);
    console.log("OK: " + result);
  } catch (e) {
    Script.setShortcutOutput("ERROR: " + e.message);
    console.error("ERROR: " + e.message);
  }
  Script.complete();
})();
