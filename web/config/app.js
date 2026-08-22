// tinyTouch web config: drives the running firmware's USB CDC console over
// Web Serial. Unlike the flasher/recovery pages (which use esptool-js in
// download mode), this speaks the line protocol to already-running firmware:
// PING/PONG, STATUS, CONFIG_UNLOCK, WIFI_SET, MQTT_SET, PIN_SET, DURESS_SLOT,
// MODE, NET_STATUS, REBOOT.

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

    await sendCommand("PING", { expect: (l) => l === "PONG", timeoutMs: 3000 });
    show("Connected.", "success");
    panel.hidden = false;
    await refreshStatus();
  } catch (error) {
    show(error.message.includes("PONG") || /Timed out/.test(error.message)
      ? "No response. Make sure the device is running (not in download mode) and no other app holds the port."
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
  "ota-url": () => {
    const url = $("#ota-url").value.trim();
    if (!/^https:\/\//.test(url)) throw new Error("Enter an https:// image URL.");
    return `OTA_URL ${url}`;
  },
  "ota-check": () => "OTA_CHECK",
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
