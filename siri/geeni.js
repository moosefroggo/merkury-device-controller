// Geeni bulb controller for Scriptable + Siri Shortcuts
// Usage: call from a Shortcut with "Run Scriptable Script"
// Pass a parameter like:  on:1  |  off:all  |  scene:all:leisure  |  brightness:1:70  |  color:2:FF6A00
// Scenes: night, rainbow, reading, cocktail, leisure, soft, blinking, rave, nature

var BASE_URL = "https://api.pepperos.io";
var BRAND    = "geeni";
var TOKEN    = "69a62fdc-795f-4ec7-9e84-568d0b560215";

var DEVICE_IDS = {
  "1": "1a0646bf-39e8-41af-b215-6640df3b70ba",
  "2": "86d6d6a4-797c-4a47-aaa8-f8fe67a220d9"
};

function bytesToHex(buf) {
  return Array.from(new Uint8Array(buf))
    .map(function(b) { return b.toString(16).padStart(2, "0"); })
    .join("");
}

async function sha256(data) {
  var buf = (typeof data === "string") ? new TextEncoder().encode(data) : data;
  return bytesToHex(await crypto.subtle.digest("SHA-256", buf));
}

async function hmacSha256(keyBytes, msg) {
  var key = await crypto.subtle.importKey(
    "raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg)));
}

function utcNow() {
  var d = new Date();
  var pad = function(n) { return String(n).padStart(2, "0"); };
  var date = "" + d.getUTCFullYear() + pad(d.getUTCMonth() + 1) + pad(d.getUTCDate());
  var time = pad(d.getUTCHours()) + pad(d.getUTCMinutes()) + pad(d.getUTCSeconds());
  return { amzdate: date + "T" + time + "Z", datestamp: date };
}

async function getCredentials() {
  var basic = btoa(BRAND + ":" + TOKEN);
  var res = await fetch(BASE_URL + "/authentication/byToken", {
    method: "POST",
    headers: {
      "Authorization": "Basic " + basic,
      "Content-Type": "application/json",
      "Accept": "application/json"
    }
  });
  if (!res.ok) throw new Error("Auth failed: " + res.status + " " + (await res.text()));
  var data = await res.json();
  var aws = data.pepperUser.awsUserCredentials;
  return {
    accessKey:    aws.AccessKeyId,
    secretKey:    aws.SecretAccessKey,
    sessionToken: aws.SessionToken,
    pepperJwt:    data.token
  };
}

async function makeHeaders(creds, method, path, body) {
  body = body || "";
  var accessKey    = creds.accessKey;
  var secretKey    = creds.secretKey;
  var sessionToken = creds.sessionToken;
  var pepperJwt    = creds.pepperJwt;
  var service  = "execute-api";
  var region   = "us-east-1";
  var host     = "api.pepperos.io";
  var now      = utcNow();
  var amzdate  = now.amzdate;
  var datestamp = now.datestamp;

  var bodyBytes = new TextEncoder().encode(body);
  var bodyHash  = await sha256(bodyBytes.length ? bodyBytes : new Uint8Array(0));

  var signedHeaders = "accept;host;peppertoken;x-amz-date;x-amz-security-token";
  var canonicalHeaders =
    "accept:application/json\n" +
    "host:" + host + "\n" +
    "peppertoken:" + pepperJwt + "\n" +
    "x-amz-date:" + amzdate + "\n" +
    "x-amz-security-token:" + sessionToken + "\n";

  var canonicalRequest = [method, path, "", canonicalHeaders, signedHeaders, bodyHash].join("\n");
  var credentialScope  = datestamp + "/" + region + "/" + service + "/aws4_request";
  var stringToSign     = ["AWS4-HMAC-SHA256", amzdate, credentialScope,
                          await sha256(canonicalRequest)].join("\n");

  var signingKey = new TextEncoder().encode("AWS4" + secretKey);
  signingKey = await hmacSha256(signingKey, datestamp);
  signingKey = await hmacSha256(signingKey, region);
  signingKey = await hmacSha256(signingKey, service);
  signingKey = await hmacSha256(signingKey, "aws4_request");

  var signature = bytesToHex(await hmacSha256(signingKey, stringToSign));
  var auth = "AWS4-HMAC-SHA256 Credential=" + accessKey + "/" + credentialScope +
             ", SignedHeaders=" + signedHeaders + ", Signature=" + signature;

  var headers = {
    "Authorization":        auth,
    "Accept":               "application/json",
    "peppertoken":          pepperJwt,
    "x-amz-date":           amzdate,
    "x-amz-security-token": sessionToken
  };
  if (body) headers["Content-Type"] = "application/json";
  return headers;
}

async function setSetting(creds, deviceId, settingId, value) {
  var path = "/account/devices/" + deviceId + "/settings/" + settingId;
  var body = JSON.stringify({ valueJson: JSON.stringify(value) });
  var headers = await makeHeaders(creds, "PUT", path, body);
  var res = await fetch(BASE_URL + path, { method: "PUT", headers: headers, body: body });
  if (!res.ok) throw new Error("API error " + res.status + ": " + (await res.text()));
  return res.status;
}

async function setScene(creds, deviceId, sceneName) {
  await setSetting(creds, deviceId, "light.scene", sceneName);
  await setSetting(creds, deviceId, "light.mode", "scene");
}

function resolveDevices(bulb) {
  if (bulb === "all") return Object.values(DEVICE_IDS);
  if (DEVICE_IDS[bulb]) return [DEVICE_IDS[bulb]];
  return [bulb];
}

async function run(paramStr) {
  var parts = (paramStr || "").trim().split(":");
  var cmd   = parts[0].toLowerCase();
  var creds = await getCredentials();
  var results = [];

  if (cmd === "on" || cmd === "off") {
    var devices = resolveDevices(parts[1] || "all");
    var val = (cmd === "on") ? 1 : 0;
    for (var i = 0; i < devices.length; i++) {
      await setSetting(creds, devices[i], "light.stateOn", val);
      results.push(cmd + " ok:" + devices[i].slice(0, 8));
    }

  } else if (cmd === "scene") {
    var devices = resolveDevices(parts[1] || "all");
    var sceneName = (parts[2] || "leisure").toLowerCase();
    var validScenes = ["night","rainbow","reading","cocktail","leisure",
                       "soft","blinking","rave","nature","custom"];
    if (validScenes.indexOf(sceneName) === -1)
      throw new Error("Unknown scene: " + sceneName + ". Valid: " + validScenes.join(", "));
    for (var i = 0; i < devices.length; i++) {
      await setScene(creds, devices[i], sceneName);
      results.push("scene " + sceneName + " ok:" + devices[i].slice(0, 8));
    }

  } else if (cmd === "brightness") {
    var devices = resolveDevices(parts[1] || "all");
    var value = Math.max(0, Math.min(100, parseInt(parts[2] || "70")));
    for (var i = 0; i < devices.length; i++) {
      await setSetting(creds, devices[i], "light.brightness", value);
      results.push("brightness " + value + " ok:" + devices[i].slice(0, 8));
    }

  } else if (cmd === "color") {
    var devices = resolveDevices(parts[1] || "all");
    var hex = (parts[2] || "FF6A00").toUpperCase();
    if (hex.charCodeAt(0) === 35) hex = hex.slice(1); // strip leading hex-sign if present
    for (var i = 0; i < devices.length; i++) {
      await setSetting(creds, devices[i], "light.color", hex);
      results.push("color " + hex + " ok:" + devices[i].slice(0, 8));
    }

  } else {
    throw new Error("Unknown command: " + cmd + ". Use: on, off, scene, brightness, color");
  }

  return results.join("\n");
}

(async () => {
  var param = args.shortcutParameter;
  try {
    var result = await run(param);
    Script.setShortcutOutput(result);
    console.log("OK: " + result);
  } catch(e) {
    Script.setShortcutOutput("ERROR: " + e.message);
    console.error("ERROR: " + e.message);
  }
  Script.complete();
})();
