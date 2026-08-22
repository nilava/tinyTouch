#include "ble_hid.h"

#include <string.h>

#include "esp_hidd.h"
#include "esp_hid_gap.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "nvs.h"

static const char *TAG = "ble_hid";

#define BLE_TEXT_CAP 128

static bool cfg_enabled;
static uint8_t cfg_slot;                 // 0 = disabled
static char cfg_text[BLE_TEXT_CAP];
static bool started;
static volatile bool connected;
static esp_hidd_dev_t *hid_dev;

// Standard boot-keyboard report map, report ID 1: [modifier][reserved][6 keys].
static const uint8_t keyboard_report_map[] = {
  0x05, 0x01, 0x09, 0x06, 0xA1, 0x01, 0x85, 0x01,
  0x05, 0x07, 0x19, 0xE0, 0x29, 0xE7, 0x15, 0x00, 0x25, 0x01,
  0x75, 0x01, 0x95, 0x08, 0x81, 0x02,
  0x95, 0x01, 0x75, 0x08, 0x81, 0x03,
  0x95, 0x05, 0x75, 0x01, 0x05, 0x08, 0x19, 0x01, 0x29, 0x05, 0x91, 0x02,
  0x95, 0x01, 0x75, 0x03, 0x91, 0x03,
  0x95, 0x06, 0x75, 0x08, 0x15, 0x00, 0x25, 0x65,
  0x05, 0x07, 0x19, 0x00, 0x29, 0x65, 0x81, 0x00,
  0xC0
};

static esp_hid_raw_report_map_t report_maps[] = {
  {.data = keyboard_report_map, .len = sizeof(keyboard_report_map)},
};

static esp_hid_device_config_t hid_config = {
  .vendor_id = 0x303a,
  .product_id = 0x4002,
  .version = 0x0100,
  .device_name = "tinyTouch",
  .manufacturer_name = "tinyTouch",
  .serial_number = "000000",
  .report_maps = report_maps,
  .report_maps_len = 1,
};

static uint8_t ascii_to_hid(char ch, uint8_t *modifier) {
  *modifier = 0;
  if (ch >= 'a' && ch <= 'z') return 4 + (ch - 'a');
  if (ch >= 'A' && ch <= 'Z') { *modifier = 0x02; return 4 + (ch - 'A'); }
  if (ch >= '1' && ch <= '9') return 30 + (ch - '1');
  if (ch == '0') return 39;
  switch (ch) {
    case ' ': return 0x2C;
    case '\n': return 0x28;
    case '-': return 0x2D;
    case '.': return 0x37;
    case '_': *modifier = 0x02; return 0x2D;
    case '@': *modifier = 0x02; return 0x1F;
    case '!': *modifier = 0x02; return 0x1E;
    default: return 0;
  }
}

static void type_char(char ch) {
  uint8_t report[8] = {0};
  report[0] = 0;
  report[2] = ascii_to_hid(ch, &report[0]);
  if (report[2] == 0 && report[0] == 0) return;
  esp_hidd_dev_input_set(hid_dev, 0, 1, report, sizeof(report));
  vTaskDelay(pdMS_TO_TICKS(12));
  memset(report, 0, sizeof(report));
  esp_hidd_dev_input_set(hid_dev, 0, 1, report, sizeof(report));
  vTaskDelay(pdMS_TO_TICKS(12));
}

static void hidd_event_cb(void *handler_args, esp_event_base_t base, int32_t id, void *event_data) {
  esp_hidd_event_t event = (esp_hidd_event_t)id;
  switch (event) {
    case ESP_HIDD_START_EVENT:
      esp_hid_ble_gap_adv_start();
      break;
    case ESP_HIDD_CONNECT_EVENT:
      connected = true;
      ESP_LOGI(TAG, "BLE host connected");
      break;
    case ESP_HIDD_DISCONNECT_EVENT:
      connected = false;
      ESP_LOGI(TAG, "BLE host disconnected; re-advertising");
      esp_hid_ble_gap_adv_start();
      break;
    default:
      break;
  }
}

static void load_config(void) {
  cfg_enabled = false;
  cfg_slot = 0;
  cfg_text[0] = '\0';
  nvs_handle_t handle;
  if (nvs_open("ble", NVS_READONLY, &handle) != ESP_OK) return;
  uint8_t enabled = 0;
  if (nvs_get_u8(handle, "enabled", &enabled) == ESP_OK) cfg_enabled = enabled != 0;
  nvs_get_u8(handle, "slot", &cfg_slot);
  size_t len = sizeof(cfg_text);
  nvs_get_str(handle, "text", cfg_text, &len);
  nvs_close(handle);
}

static bool save_u8(const char *key, uint8_t value) {
  nvs_handle_t handle;
  if (nvs_open("ble", NVS_READWRITE, &handle) != ESP_OK) return false;
  esp_err_t r = nvs_set_u8(handle, key, value);
  if (r == ESP_OK) r = nvs_commit(handle);
  nvs_close(handle);
  return r == ESP_OK;
}

static void start_stack(void) {
  if (started || !cfg_enabled) return;
  if (esp_hid_gap_init(HID_DEV_MODE) != ESP_OK) { ESP_LOGE(TAG, "gap init failed"); return; }
  if (esp_hid_ble_gap_adv_init(ESP_HID_APPEARANCE_KEYBOARD, hid_config.device_name) != ESP_OK) {
    ESP_LOGE(TAG, "adv init failed");
    return;
  }
  if (esp_hidd_dev_init(&hid_config, ESP_HID_TRANSPORT_BLE, hidd_event_cb, &hid_dev) != ESP_OK) {
    ESP_LOGE(TAG, "hidd init failed");
    return;
  }
  started = true;
  ESP_LOGI(TAG, "BLE HID keyboard started");
}

void ble_hid_init(void) {
  load_config();
  start_stack();
}

bool ble_hid_enabled(void) { return cfg_enabled; }
bool ble_hid_connected(void) { return connected; }
uint8_t ble_hid_slot(void) { return cfg_slot; }

bool ble_hid_set_enabled(bool enabled) {
  if (!save_u8("enabled", enabled ? 1 : 0)) return false;
  cfg_enabled = enabled;
  if (enabled) start_stack();  // disabling takes effect on next reboot
  return true;
}

bool ble_hid_set_slot(uint8_t slot) {
  if (slot > 5) return false;
  if (!save_u8("slot", slot)) return false;
  cfg_slot = slot;
  return true;
}

bool ble_hid_set_text(const char *text) {
  if (!text || strlen(text) >= BLE_TEXT_CAP) return false;
  nvs_handle_t handle;
  if (nvs_open("ble", NVS_READWRITE, &handle) != ESP_OK) return false;
  esp_err_t r = nvs_set_str(handle, "text", text);
  if (r == ESP_OK) r = nvs_commit(handle);
  nvs_close(handle);
  if (r == ESP_OK) strlcpy(cfg_text, text, sizeof(cfg_text));
  return r == ESP_OK;
}

bool ble_hid_type_credential(void) {
  if (!connected || cfg_text[0] == '\0') return false;
  for (const char *p = cfg_text; *p; p++) type_char(*p);
  return true;
}

void ble_hid_status(char *out, size_t cap) {
  snprintf(out, cap, "enabled=%s state=%s slot=%u text=%s",
           cfg_enabled ? "yes" : "no",
           connected ? "connected" : (started ? "advertising" : "off"),
           cfg_slot, cfg_text[0] ? "set" : "unset");
}

// The copied esp_hid_gap.c calls these on BLE connect/disconnect. Connection
// state is tracked via the esp_hidd events above, so these just log.
void ble_hid_task_start_up(void) {
  ESP_LOGI(TAG, "BLE security established");
}

void ble_hid_task_shut_down(void) {
  ESP_LOGI(TAG, "BLE link torn down");
}
