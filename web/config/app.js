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
const hidSupported = "hid" in navigator;

const USB_VID = 0x303a;
const USB_PID = 0x4001;
const REPORT_ID = 2;
let REPORT_SIZE = 63;   // chunk-transport report payload; refined from descriptor on connect

if (!hidSupported) {
  $("#browser-note").textContent = "Open this page in Google Chrome or Microsoft Edge (WebHID required).";
  $("#connect").disabled = true;
}

function show(text, kind = "") {
  message.textContent = text;
  message.className = `message ${kind}`.trim();
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
  try {
    const status = await sendCommand("STATUS");
    $("#status").textContent = status.replace(/^OK STATUS /, "");
  } catch { $("#status").textContent = "unavailable"; }
  try {
    const net = await sendCommand("NET_STATUS");
    $("#netstatus").textContent = net.replace(/^OK NET_STATUS /, "");
  } catch { $("#netstatus").textContent = "unavailable"; }
}

$("#connect").addEventListener("click", async () => {
  try {
    show("Select the tinyTouch device…");
    const filters = [{ vendorId: USB_VID, productId: USB_PID }];
    const devices = await navigator.hid.requestDevice({ filters });
    if (!devices.length) { show("No device selected.", ""); return; }
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
    show("Connected.", "success");
    panel.hidden = false;
    await refreshStatus();
  } catch (error) {
    show(/no device selected|cancelled/i.test(error.message) ? "Connection cancelled." : error.message, "error");
  }
});

$("#unlock").addEventListener("click", async () => {
  try {
    show("Touch the sensor to unlock configuration…");
    const line = await sendCommand("CONFIG_UNLOCK", { timeoutMs: 30000 });
    if (line.startsWith("ERR")) throw new Error("Fingerprint not recognized.");
    show("Configuration unlocked for 120 seconds.", "success");
    controls.disabled = false;
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
  mode: () => `MODE ${$("#mode").value}`,
  reboot: () => "REBOOT",
};

controls.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-cmd]");
  if (!button || !actions[button.dataset.cmd]) return;
  try {
    const response = await sendCommand(actions[button.dataset.cmd]());
    if (response.startsWith("ERR")) {
      show(response, "error");
    } else {
      show(response, "success");
      if (button.dataset.cmd !== "reboot") await refreshStatus();
    }
  } catch (error) {
    show(error.message, "error");
  }
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
