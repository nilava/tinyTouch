// tinyTouch web config: drives the running firmware's USB CDC console over
// Web Serial. Unlike the flasher/recovery pages (which use esptool-js in
// download mode), this speaks the line protocol to already-running firmware:
// PING/PONG, STATUS, CONFIG_UNLOCK, WIFI_SET, MQTT_SET, PIN_SET, DURESS_SLOT,
// MODE, NET_STATUS, REBOOT.

import { ESPLoader, Transport } from "./vendor/esptool-js.js";

const $ = (sel) => document.querySelector(sel);
const message = $("#message");
const log = $("#log");
const panel = $("#panel");
const controls = $("#controls");
const serialSupported = "serial" in navigator;

if (!serialSupported) {
  $("#browser-note").textContent = "Open this page in Google Chrome or Microsoft Edge.";
  $("#connect").disabled = true;
}

function show(text, kind = "") {
  message.textContent = text;
  message.className = `message ${kind}`.trim();
}

function writeLog(value) {
  const line = value.trim();
  if (!line) return;
  log.hidden = false;
  log.textContent = log.textContent === "No device activity yet." ? line : `${log.textContent}\n${line}`;
  log.scrollTop = log.scrollHeight;
}

let port = null;
let writer = null;
let lineWaiters = [];
let lineBuffer = "";

// Resolve the next console line that satisfies match(line).
function waitForLine(match, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const waiter = { match, resolve, reject };
    lineWaiters.push(waiter);
    waiter.timer = setTimeout(() => {
      lineWaiters = lineWaiters.filter((w) => w !== waiter);
      reject(new Error("Timed out waiting for the device."));
    }, timeoutMs);
  });
}

function dispatchLine(line) {
  writeLog(`← ${line}`);
  for (const waiter of [...lineWaiters]) {
    if (waiter.match(line)) {
      clearTimeout(waiter.timer);
      lineWaiters = lineWaiters.filter((w) => w !== waiter);
      waiter.resolve(line);
    }
  }
}

async function readLoop(reader) {
  const decoder = new TextDecoder();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      lineBuffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = lineBuffer.indexOf("\n")) >= 0) {
        const line = lineBuffer.slice(0, idx).replace(/\r$/, "");
        lineBuffer = lineBuffer.slice(idx + 1);
        if (line) dispatchLine(line);
      }
    }
  } catch (error) {
    writeLog(`serial read ended: ${error.message}`);
  }
}

async function sendCommand(command, { expect, timeoutMs } = {}) {
  writeLog(`→ ${command}`);
  await writer.write(new TextEncoder().encode(`${command}\r\n`));
  if (!expect) return null;
  return waitForLine(expect, timeoutMs);
}

async function refreshStatus() {
  try {
    const status = await sendCommand("STATUS", { expect: (l) => /^OK STATUS/.test(l) });
    $("#status").textContent = status.replace(/^OK STATUS /, "");
  } catch { $("#status").textContent = "unavailable"; }
  try {
    const net = await sendCommand("NET_STATUS", { expect: (l) => /^OK NET_STATUS/.test(l) });
    $("#netstatus").textContent = net.replace(/^OK NET_STATUS /, "");
  } catch { $("#netstatus").textContent = "unavailable"; }
}

$("#connect").addEventListener("click", async () => {
  try {
    show("Select the tinyTouch serial port…");
    port = await navigator.serial.requestPort();
    await port.open({ baudRate: 115200 });
    writer = port.writable.getWriter();
    readLoop(port.readable.getReader());

    try {
      await sendCommand("PING", { expect: (l) => l === "PONG", timeoutMs: 3000 });
    } catch {
      // tinyTouch exposes two serial ports: a config console (answers PING) and
      // a helper channel (silent). A timeout almost always means the wrong one.
      try { await writer.close(); } catch {}
      try { await port.close(); } catch {}
      port = null; writer = null;
      throw new Error("That port didn't respond. tinyTouch has two ports — reconnect and pick the other (the \"config\" one).");
    }
    show("Connected.", "success");
    panel.hidden = false;
    await refreshStatus();
  } catch (error) {
    show(/no port selected|cancelled/i.test(error.message)
      ? "Connection cancelled."
      : error.message, "error");
  }
});

$("#unlock").addEventListener("click", async () => {
  try {
    show("Touch the sensor to unlock configuration…");
    await sendCommand("CONFIG_UNLOCK", {
      expect: (l) => /^OK CONFIG_UNLOCK/.test(l) || /^ERR CONFIG_UNLOCK/.test(l),
      timeoutMs: 30000,
    }).then((line) => {
      if (line.startsWith("ERR")) throw new Error("Fingerprint not recognized.");
    });
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
  if (!button) return;
  try {
    const command = actions[button.dataset.cmd]();
    const response = await sendCommand(command, {
      expect: (l) => /^OK /.test(l) || /^ERR /.test(l),
    });
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


// Firmware flashing: reboot the running device into ROM download mode via the
// BOOTLOADER console command, let it re-enumerate, then drive esptool-js to
// write a merged image over USB. Replaces device-side OTA entirely, so the
// firmware carries no TLS/HTTP/OTA stack.
$("#flash-fw").addEventListener("click", async () => {
  const file = $("#fw-file").files[0];
  if (!file) { show("Choose a merged .bin file first.", "error"); return; }
  if (controls.disabled) { show("Unlock configuration first.", "error"); return; }
  try {
    show("Rebooting device into download mode…");
    await sendCommand("BOOTLOADER", { expect: (l) => /^OK BOOTLOADER/.test(l), timeoutMs: 4000 });

    // The console port drops as the device re-enumerates in download mode.
    try { await writer.close(); } catch {}
    try { await port.close(); } catch {}
    port = null; writer = null;

    show("Select the device again (now in download mode)…");
    const dlPort = await navigator.serial.requestPort();
    const transport = new Transport(dlPort, false);
    const terminal = { clean(){}, write:writeLog, writeLine:writeLog };
    const loader = new ESPLoader({ transport, baudrate: 460800, terminal, debugLogging: false });
    await loader.main("no_reset");

    const buffer = await file.arrayBuffer();
    let binary = "";
    const bytes = new Uint8Array(buffer);
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);

    const wrap = $("#flash-progress");
    wrap.hidden = false;
    await loader.writeFlash({
      fileArray: [{ data: binary, address: 0 }],
      flashSize: "keep",
      eraseAll: false,
      compress: true,
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
