// tinyTouch web config over WebHID. The config channel is a HID feature report
// (report ID 2) on the device's HID interface — a different USB interface from
// the CDC the macOS helper holds, so the browser and the helper never contend
// for a port. Feature reports ride the control endpoint, so this needs no extra
// USB endpoints (the ESP32-S3 OTG core has none to spare).

import { ESPLoader, Transport } from "./vendor/esptool-js.js";

const $ = (sel) => document.querySelector(sel);
const message = $("#message");
const log = $("#log");
const panel = $("#panel");
const controls = $("#controls");
const connPill = $("#conn-pill");
const connText = $("#conn-text");
const lockbar = $("#lockbar");
const lockText = $("#lock-text");

function parseKV(text) {
  const out = {};
  for (const tok of text.trim().split(/\s+/)) {
    const i = tok.indexOf("=");
    if (i > 0) out[tok.slice(0, i)] = tok.slice(i + 1);
  }
  return out;
}
let autoRefreshTimer = null;
function startAutoRefresh() {
  stopAutoRefresh();
  // Light poll so the summary (esp. last-touched slot) stays live.
  autoRefreshTimer = setInterval(() => { if (device) refreshStatus().catch(() => {}); }, 3000);
}
function stopAutoRefresh() { if (autoRefreshTimer) { clearInterval(autoRefreshTimer); autoRefreshTimer = null; } }
function markDisconnected() {
  stopAutoRefresh();
  connPill.classList.remove("on"); connText.textContent = "Disconnected";
  controls.disabled = true; lockbar.classList.remove("unlocked");
  device = null;
}
function setDot(id, cls) { const el = $(id); if (el) el.className = "sdot " + (cls || ""); }
function setText(id, v) { const el = $(id); if (el) { el.textContent = v; el.classList.remove("skeleton"); } }
const hidSupported = "hid" in navigator;

const USB_VID = 0x303a;
const USB_PID = 0x4001;
const REPORT_ID = 2;
let REPORT_SIZE = 63;   // chunk-transport report payload; refined from descriptor on connect

if (!hidSupported) {
  $("#browser-note").textContent = "Open this page in Google Chrome or Microsoft Edge (WebHID required).";
  $("#connect").disabled = true;
}

const toasts = $("#toasts");
const TOAST_ICON = {
  success: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12l5 5L20 6"/></svg>',
  error: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M12 8h.01M11 12h1v4h1"/></svg>',
};
function toast(text, kind = "info") {
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.innerHTML = `<span class="ic">${TOAST_ICON[kind] || TOAST_ICON.info}</span><span></span>`;
  el.lastChild.textContent = text;
  toasts.appendChild(el);
  setTimeout(() => { el.classList.add("out"); setTimeout(() => el.remove(), 260); }, 3400);
}
// Pre-connect hint line only; all action feedback goes through toasts.
function show(text, kind = "") {
  if (kind) { toast(text, kind === "success" ? "success" : "error"); }
  else if (message) message.textContent = text;
}
// Run an async action with inline button feedback (spinner -> Saved/Failed).
async function withButton(button, fn, okLabel = "Saved") {
  if (!button) return fn();
  const original = button.textContent;
  button.disabled = true;
  button.innerHTML = '<span class="spinner"></span>';
  try {
    const r = await fn();
    button.classList.add("saved");
    button.textContent = okLabel + " ✓";
    setTimeout(() => { button.classList.remove("saved"); button.textContent = original; button.disabled = false; }, 1600);
    return r;
  } catch (e) {
    button.classList.add("failed");
    button.textContent = "Failed";
    setTimeout(() => { button.classList.remove("failed"); button.textContent = original; button.disabled = false; }, 1800);
    throw e;
  }
}
function writeLog(value) {
  const line = String(value).trim();
  if (!line) return;
  log.hidden = false;
  log.textContent = log.textContent === "No device activity yet." ? line : `${log.textContent}\n${line}`;
  log.scrollTop = log.scrollHeight;
}

let device = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function decodeReport(view) {
  const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  let end = bytes.indexOf(0);
  if (end < 0) end = bytes.length;
  return new TextDecoder().decode(bytes.subarray(0, end));
}

// Send a command as a feature report, then poll until a terminal (non-PENDING)
// response comes back. The device rejects a new command while one is pending,
// so callers must await this before sending the next.
const CHUNK_DATA = () => REPORT_SIZE - 2;

// Strip a leading report-ID byte if the platform includes it.
function reportBody(view) {
  return view.byteLength === REPORT_SIZE + 1
    ? new Uint8Array(view.buffer, view.byteOffset + 1, REPORT_SIZE)
    : new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
}

// Read a full (possibly multi-chunk) response: each report is [flag][len][data],
// flag=1 means more chunks follow. Returns null while the device reports PENDING.
async function readResponse() {
  let out = "";
  for (let i = 0; i < 64; i++) {  // hard cap on chunks
    const body = reportBody(await device.receiveFeatureReport(REPORT_ID));
    const flag = body[0], len = body[1];
    out += new TextDecoder().decode(body.subarray(2, 2 + len));
    if (flag === 0) break;
  }
  if (out === "PENDING" || out === "IDLE" || out === "") return null;
  return out;
}

async function sendCommand(command, { timeoutMs = 8000 } = {}) {
  writeLog(`→ ${command}`);
  const bytes = new TextEncoder().encode(command);
  const size = CHUNK_DATA();
  // Write the command in [flag][len][data] chunks.
  for (let off = 0; off < bytes.length || off === 0; off += size) {
    const slice = bytes.subarray(off, off + size);
    const last = off + size >= bytes.length;
    const payload = new Uint8Array(REPORT_SIZE);
    payload[0] = last ? 0 : 1;
    payload[1] = slice.length;
    payload.set(slice, 2);
    await device.sendFeatureReport(REPORT_ID, payload);
    if (last) break;
  }

  const deadline = Date.now() + timeoutMs;
  await sleep(60);
  while (Date.now() < deadline) {
    const text = await readResponse();
    if (text !== null) { writeLog(`← ${text}`); return text; }
    await sleep(120);
  }
  throw new Error("Timed out waiting for the device.");
}

async function refreshStatus() {
  let mode = null;
  try {
    const s = parseKV((await sendCommand("STATUS")).replace(/^OK STATUS /, ""));
    mode = s.mode;
    setText("#sum-mode", s.mode === "hid" ? "HID password" : "PIV smartcard");
    setDot("#sd-mode", "ok");
    const sensorOk = s.sensor === "ok";
    setText("#sum-sensor", sensorOk ? "OK" : (s.sensor || "—"));
    setDot("#sd-sensor", sensorOk ? "ok" : "warn");
    setText("#sum-fp", s.fingerprints ?? "—");
    setText("#sum-last", (s.lastmatch && s.lastmatch !== "0") ? ("slot " + s.lastmatch) : "—");
    // reflect mode in the segmented control
    document.querySelectorAll("#mode-seg button").forEach((b) =>
      b.classList.toggle("active", b.dataset.mode === s.mode));
    const seg = $("#mode-seg"); if (seg) seg.classList.toggle("hid", s.mode === "hid");
  } catch {}
  try {
    const n = parseKV((await sendCommand("NET_STATUS")).replace(/^OK NET_STATUS /, ""));
    const wifi = (n.wifi || "").split("/");
    setText("#sum-wifi", wifi[0] === "configured" ? (wifi[1] === "up" ? "Connected" : "Configured") : "Not set");
    setDot("#sd-wifi", wifi[1] === "up" ? "ok" : (wifi[0] === "configured" ? "warn" : "off"));
    setText("#sum-mqtt", n.mqtt === "connected" ? "Connected" : (n.mqtt === "configured" ? "Configured" : "Not set"));
    setDot("#sd-mqtt", n.mqtt === "connected" ? "ok" : (n.mqtt === "configured" ? "warn" : "off"));
  } catch {}
  try {
    const b = parseKV((await sendCommand("BLE_STATUS")).replace(/^OK BLE_STATUS /, ""));
    const on = b.enabled === "yes";
    setText("#sum-ble", on ? (b.state === "connected" ? "Connected" : "On") : "Off");
    setDot("#sd-ble", b.state === "connected" ? "ok" : (on ? "warn" : "off"));
    if ($("#ble-enable")) $("#ble-enable").value = on ? "on" : "off";
    if ($("#ble-slot")) $("#ble-slot").value = (b.slot && b.slot !== "0") ? b.slot : "off";
  } catch {}
}

$("#connect").addEventListener("click", async () => {
  const cbtn = $("#connect");
  const cprev = cbtn.innerHTML;
  try {
    const filters = [{ vendorId: USB_VID, productId: USB_PID }];
    const devices = await navigator.hid.requestDevice({ filters });
    if (!devices.length) { return; }
    cbtn.disabled = true; cbtn.innerHTML = '<span class="spinner"></span> Connecting…';
    device = devices[0];
    if (!device.opened) await device.open();

    // Diagnostic: log the feature reports Chrome parsed, so a write failure is
    // debuggable (report ID mismatch vs. transport error).
    try {
      const feats = (device.collections || []).flatMap((c) =>
        (c.featureReports || []).map((r) => `id=${r.reportId} usagePage=0x${(c.usagePage||0).toString(16)}`));
      writeLog(`feature reports: ${feats.join(", ") || "none"}`);
      // Size our writes to match the device's actual feature report length.
      for (const c of device.collections || []) {
        for (const r of c.featureReports || []) {
          if (r.reportId !== REPORT_ID) continue;
          const bits = (r.items || []).reduce((n, it) => n + (it.reportSize || 0) * (it.reportCount || 0), 0);
          if (bits > 0) { REPORT_SIZE = Math.ceil(bits / 8); writeLog(`report size: ${REPORT_SIZE} bytes`); }
        }
      }
    } catch {}

    // Probe READ independently of WRITE. If read works but write fails, macOS is
    // blocking SetReport to this device (it also presents a keyboard) — a WebHID
    // platform limitation, not a firmware bug.
    try {
      const v = await device.receiveFeatureReport(REPORT_ID);
      writeLog(`read probe OK: ${v.byteLength} bytes`);
    } catch (e) {
      writeLog(`read probe FAILED: ${e.message}`);
    }

    const pong = await sendCommand("PING", { timeoutMs: 3000 });
    if (pong !== "PONG") throw new Error("Unexpected reply: " + pong);
    connPill.classList.add("on");
    connText.textContent = "Connected";
    $("#hero").hidden = true;
    panel.hidden = false;
    toast("Device connected", "success");
    await refreshStatus();
    startAutoRefresh();
  } catch (error) {
    cbtn.disabled = false; cbtn.innerHTML = cprev;
    if (!/no device selected|cancelled|null/i.test(error.message || "")) toast(error.message, "error");
  }
});

$("#unlock").addEventListener("click", async () => {
  const ubtn = $("#unlock");
  try {
    toast("Touch the sensor to unlock…", "info");
    const line = await sendCommand("CONFIG_UNLOCK", { timeoutMs: 30000 });
    if (line.startsWith("ERR")) throw new Error("Fingerprint not recognized.");
    toast("Unlocked for 120 seconds", "success");
    controls.disabled = false;
    lockbar.classList.add("unlocked");
    lockText.textContent = "🔓 Unlocked — settings can be changed for 120s";
    ubtn.textContent = "Re-unlock";
  } catch (error) {
    show(error.message, "error");
  }
});

const actions = {
  wifi: () => {
    const ssid = $("#wifi-ssid").value.trim();
    if (!ssid) throw new Error("Enter an SSID.");
    return `WIFI_SET ${ssid} ${$("#wifi-psk").value}`;
  },
  mqtt: () => {
    const uri = $("#mqtt-uri").value.trim();
    if (!uri) throw new Error("Enter a broker URI.");
    return `MQTT_SET ${uri} ${$("#mqtt-prefix").value.trim()}`.trimEnd();
  },
  pin: () => {
    const pin = $("#pin").value.trim();
    if (!/^\d{6,8}$/.test(pin)) throw new Error("PIN must be 6–8 digits.");
    return `PIN_SET ${pin}`;
  },
  duress: () => `DURESS_SLOT ${$("#duress").value}`,
  "ble-enable": () => `BLE_ENABLE ${$("#ble-enable").value}`,
  "ble-slot": () => `BLE_SLOT ${$("#ble-slot").value}`,
  "ble-text": () => {
    const t = $("#ble-text").value;
    if (!t) throw new Error("Enter text to type.");
    return `BLE_TEXT ${t}`;
  },
  reboot: () => "REBOOT",
  bootloader: () => "BOOTLOADER",
  "ble-start": () => "BLE_START",
};

const OK_LABELS = { reboot: "Rebooting", "ble-enable": "Saved", pin: "Set", "ble-start": "Pairing" };
controls.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-cmd]");
  if (!button || !actions[button.dataset.cmd]) return;
  const cmd = button.dataset.cmd;
  // These reboot the device, which drops the USB/HID link — don't expect a reply.
  const reboots = cmd === "reboot" || cmd === "bootloader";
  try {
    await withButton(button, async () => {
      try {
        const response = await sendCommand(actions[cmd](), { timeoutMs: reboots ? 2500 : 8000 });
        if (response.startsWith("ERR")) throw new Error(friendlyError(cmd, response));
        return response;
      } catch (e) {
        if (reboots) return "ok";  // link dropped on reboot, expected
        throw e;
      }
    }, OK_LABELS[cmd] || "Saved");
    toast(successMessage(cmd), reboots ? "info" : "success");
    if (reboots) { markDisconnected(); }
    else await refreshStatus();
  } catch (error) {
    toast(error.message, "error");
  }
});

function successMessage(cmd) {
  return {
    wifi: "Wi-Fi saved — reboot to connect",
    mqtt: "MQTT broker saved — reboot to connect",
    pin: "PIN updated",
    duress: "Duress slot saved",
    reboot: "Device rebooting…",
    bootloader: "Rebooting into flash mode — reconnect after flashing",
    "ble-enable": "BLE setting saved — reboot to apply",
    "ble-slot": "BLE trigger slot saved",
    "ble-text": "BLE text saved",
    "ble-start": "Pairing mode on — open Bluetooth on your iPad/phone",
  }[cmd] || "Saved";
}
function friendlyError(cmd, resp) {
  if (/format/.test(resp) && cmd === "pin") return "PIN must be 6–8 digits.";
  if (/too_long/.test(resp)) return "That value is too long.";
  return resp.replace(/^ERR \S+ ?/, "") || "The device rejected that.";
}


// Mode segmented control: send MODE and reflect the new active state.
document.querySelectorAll("#mode-seg button").forEach((btn) => {
  btn.addEventListener("click", async () => {
    if (controls.disabled) { toast("Unlock configuration first.", "error"); return; }
    try {
      const resp = await sendCommand(`MODE ${btn.dataset.mode}`);
      if (resp.startsWith("ERR")) { toast("Could not switch mode.", "error"); return; }
      toast(`Switched to ${btn.dataset.mode === "hid" ? "HID password" : "PIV smartcard"} mode`, "success");
      await refreshStatus();
    } catch (e) { toast(e.message, "error"); }
  });
});

// Firmware flashing: send BOOTLOADER over the HID config channel to reboot the
// S3 into ROM download mode, then drive esptool-js over Web Serial to write a
// merged image. Config uses WebHID; flashing uses Web Serial + the ROM.
$("#flash-fw").addEventListener("click", async () => {
  const file = $("#fw-file").files[0];
  if (!file) { show("Choose a merged .bin file first.", "error"); return; }
  if (controls.disabled) { show("Unlock configuration first.", "error"); return; }
  try {
    show("Rebooting device into download mode…");
    try { await sendCommand("BOOTLOADER", { timeoutMs: 4000 }); } catch {}
    // Device re-enumerates in download mode; the HID handle is now stale.
    try { if (device && device.opened) await device.close(); } catch {}
    device = null;

    show("Select the device again (now in download mode)…");
    const dlPort = await navigator.serial.requestPort();
    const transport = new Transport(dlPort, false);
    const terminal = { clean(){}, write: writeLog, writeLine: writeLog };
    const loader = new ESPLoader({ transport, baudrate: 460800, terminal, debugLogging: false });
    await loader.main("no_reset");

    const bytes = new Uint8Array(await file.arrayBuffer());
    let binary = "";
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);

    $("#flash-progress").hidden = false;
    await loader.writeFlash({
      fileArray: [{ data: binary, address: 0 }],
      flashSize: "keep", eraseAll: false, compress: true,
      reportProgress: (_i, written, total) => {
        const pct = Math.round((written / total) * 100);
        $("#flash-bar").value = pct;
        $("#flash-percent").textContent = `${pct}%`;
      },
    });
    await loader.after("hard_reset");
    show("Firmware flashed. Device rebooting — reconnect to continue.", "success");
  } catch (error) {
    show(/download mode|sync|connect|timeout/i.test(error.message)
      ? "The board did not enter download mode. Unplug/replug, or hold BOOT + tap RESET, then retry."
      : error.message, "error");
  }
});
